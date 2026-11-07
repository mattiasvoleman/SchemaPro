import { randomUUID } from 'node:crypto';
import { zonedTimeToUtc } from '../common/utils/time';
import type { PersonDay } from '../cover/cover-rules';
import {
  roomBlocks,
  teacherBlocks,
  type RoomDayUse,
  type SlotSpan,
} from './exam-availability';
import {
  candidateSlots,
  clockOf,
  indexDates,
  type ExamToPlan,
  type PlanLesson,
  type Slot,
  type SlotShortage,
} from './exam-plan';
import type {
  EngineExam,
  EngineReason,
  PlanExamsRequest,
  PlanExamsResponse,
  PlacedExamOut,
} from './interfaces/exam-engine.interface';

/*
 * PROVPLANERING: THE REQUEST THE ENGINE IS SENT AND THE ANSWER IT GIVES BACK,
 * as pure functions over what the service has read.
 *
 * Everything the engine cannot decide for itself is decided here, by the rules
 * the rest of the product already answers with: which times an exam can take
 * (exam-plan.ts), who and what is free at each (exam-availability.ts, the rules
 * of Skolans dag), what a time costs, and what the school's earlier exams have
 * already used of the caps. The engine gets opaque ids and numbers and returns
 * a choice among them.
 */

/** An exam the school asked for, with what the planner needs of its classes. */
export interface PlanningExam extends ExamToPlan {
  /** The groups the avbokning takes: named, halves, groups wholly inside the named classes. */
  affected: ReadonlySet<string>;
  /** The home classes that have writers: what shares a time and counts toward the caps. */
  classes: readonly string[];
  writers: number;
}

/** An exam that already stands (its activity is live), as the classes' load and the clash rule read it. */
export interface StandingExam {
  id: string;
  date: string;
  start: number;
  end: number;
  classes: readonly string[];
}

export interface PlanningState {
  today: string;
  timezone: string;
  limits: { maxPerClassPerDay: number; maxPerClassPerWeek: number; writersPerInvigilator: number; turnoverMinutes: number };
  exams: readonly PlanningExam[];
  /** The lessons an activity could take, of every group an exam touches. */
  lessons: readonly PlanLesson[];
  /** The invigilator pool: active teachers the school may name. */
  teacherIds: readonly string[];
  personDays: ReadonlyMap<string, ReadonlyMap<string, PersonDay>>;
  /** Minutes of watch each teacher already has this year. */
  prior: ReadonlyMap<string, number>;
  rooms: ReadonlyArray<{ id: string; seats: number }>;
  roomUses: ReadonlyMap<string, RoomDayUse>;
  loan: (roomId: string, slot: SlotSpan) => boolean;
  standing: readonly StandingExam[];
  /** The search budget in seconds, when the caller sets one. */
  maxTimeSeconds?: number;
}

/** An exam the gateway could not ask the engine about, with the reason it gives. */
export interface GatewayUnplaced {
  examId: string;
  reason: SlotShortage | EngineReason;
  params: Record<string, string | number>;
}

export interface BuiltRequest {
  request: PlanExamsRequest;
  /** Anonymous id -> real id, per id space. */
  maps: { exams: Map<string, string>; rooms: Map<string, string>; teachers: Map<string, string>; classes: Map<string, string> };
  /** The slots each asked exam offered, by real exam id, in the order the engine indexes them. */
  slots: Map<string, Slot[]>;
  unplaced: GatewayUnplaced[];
}

/** The most times the engine takes for one exam. */
export const MAX_SLOTS = 500;

const overlapping = (a: { start: number; end: number }, b: { start: number; end: number }): boolean => a.start < b.end && b.start < a.end;

export function buildRequest(state: PlanningState, requestId: string = randomUUID()): BuiltRequest {
  const lessonsByDate = new Map<string, PlanLesson[]>();
  for (const lesson of state.lessons) {
    const list = lessonsByDate.get(lesson.date);
    if (list) list.push(lesson);
    else lessonsByDate.set(lesson.date, [lesson]);
  }

  // 1. The times each exam can take.
  const unplaced: GatewayUnplaced[] = [];
  const asked: Array<{ exam: PlanningExam; slots: Slot[] }> = [];
  for (const exam of state.exams) {
    const own = new Map<string, PlanLesson[]>();
    for (const [date, lessons] of lessonsByDate) {
      const mine = lessons.filter((lesson) => lesson.groupIds.some((id) => exam.affected.has(id)));
      if (mine.length > 0) own.set(date, mine);
    }
    const { slots, shortage } = candidateSlots(exam, own, state.today);
    // A time on top of an exam that already stands for one of the same classes is no time.
    const free = slots.filter(
      (slot) => !state.standing.some((other) => other.date === slot.date && overlapping(other, slot) && other.classes.some((id) => exam.classes.includes(id))),
    );
    if (slots.length > 0 && free.length === 0) {
      unplaced.push({ examId: exam.id, reason: 'EXAM_CLASS_CLASH', params: {} });
    } else if (free.length === 0) {
      unplaced.push({ examId: exam.id, reason: shortage ?? 'EXAM_NO_LESSON_TO_REPLACE', params: {} });
    } else {
      // The engine takes at most 500 times an exam; a window of 31 days with a dozen lesson starts a day is under it.
      asked.push({ exam, slots: free.slice(0, MAX_SLOTS) });
    }
  }

  const maps = { exams: new Map<string, string>(), rooms: new Map<string, string>(), teachers: new Map<string, string>(), classes: new Map<string, string>() };
  const anon = (map: Map<string, string>, realId: string): string => {
    let id = map.get(realId);
    if (!id) {
      id = randomUUID();
      map.set(realId, id);
    }
    return id;
  };
  const classAnon = maps.classes;

  // 2. Day and week indexes over everything the request touches.
  const { day, week } = indexDates([...asked.flatMap(({ slots }) => slots.map((slot) => slot.date)), ...state.standing.map((exam) => exam.date)]);
  const weekOf = (date: string): number => week.get(weekKeyFor(date)) ?? 0;

  // 3. Who is free and what is free, per exam.
  const spanOf = (slot: Slot): SlotSpan => ({
    date: slot.date,
    start: zonedTimeToUtc(slot.date, clockOf(slot.start), state.timezone).getTime(),
    end: zonedTimeToUtc(slot.date, clockOf(slot.end), state.timezone).getTime(),
  });
  const exams: EngineExam[] = asked.map(({ exam, slots }) => {
    const spans = slots.map(spanOf);
    const teachers = teacherBlocks(state.teacherIds, state.personDays, exam.affected, spans);
    const rooms = roomBlocks(
      state.rooms.map((room) => room.id),
      state.roomUses,
      exam.affected,
      spans,
      state.loan,
    );
    return {
      id: anon(maps.exams, exam.id),
      length: exam.lengthMinutes,
      writers: exam.writers,
      classes: exam.classes.map((id) => anon(classAnon, id)),
      slots: slots.map((slot) => ({ day: day.get(slot.date) ?? 0, week: weekOf(slot.date), start: slot.start, loss: slot.loss })),
      roomBlocks: [...rooms].map(([id, blocked]) => ({ id: anon(maps.rooms, id), slots: blocked })),
      teacherBlocks: [...teachers].map(([id, blocked]) => ({ id: anon(maps.teachers, id), slots: blocked })),
      fixed: exam.windowKind === 'FIXED',
    };
  });

  // 4. What the exams that stand already use of the caps.
  const dayLoad = new Map<string, number>();
  const weekLoad = new Map<string, number>();
  for (const other of state.standing) {
    for (const id of other.classes) {
      const dayKey = `${id}|${day.get(other.date)}`;
      const weekKey = `${id}|${weekOf(other.date)}`;
      dayLoad.set(dayKey, (dayLoad.get(dayKey) ?? 0) + 1);
      weekLoad.set(weekKey, (weekLoad.get(weekKey) ?? 0) + 1);
    }
  }

  const request: PlanExamsRequest = {
    requestId,
    exams,
    rooms: state.rooms.map((room) => ({ id: anon(maps.rooms, room.id), seats: room.seats })),
    teachers: state.teacherIds.map((id) => ({ id: anon(maps.teachers, id), prior: state.prior.get(id) ?? 0 })),
    limits: { ...state.limits },
    existingDayLoad: [...dayLoad]
      .map(([key, count]) => {
        const [realClass, dayIndex] = key.split('|');
        return { class: classAnon.get(realClass), day: Number(dayIndex), count };
      })
      .filter((row): row is { class: string; day: number; count: number } => row.class !== undefined),
    existingWeekLoad: [...weekLoad]
      .map(([key, count]) => {
        const [realClass, weekIndex] = key.split('|');
        return { class: classAnon.get(realClass), week: Number(weekIndex), count };
      })
      .filter((row): row is { class: string; week: number; count: number } => row.class !== undefined),
    ...(state.maxTimeSeconds !== undefined ? { search: { maxTimeSeconds: state.maxTimeSeconds } } : {}),
  };
  return { request, maps, slots: new Map(asked.map(({ exam, slots }) => [exam.id, slots])), unplaced };
}

function weekKeyFor(date: string): string {
  // The same key exam-plan.ts' indexDates numbers the weeks by.
  const d = new Date(`${date}T00:00:00.000Z`);
  const weekday = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + 4 - weekday);
  const year = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-${String(week).padStart(2, '0')}`;
}

/** One exam of the answer, in real ids and real times. */
export interface PlacedExam {
  examId: string;
  date: string;
  start: number;
  end: number;
  loss: number;
  rooms: Array<{ roomId: string; writers: number; teacherIds: string[] }>;
}

export interface Unplaced {
  examId: string;
  reason: string;
  params: Record<string, string | number>;
  message: string | null;
}

export interface RealisedPlan {
  status: PlanExamsResponse['status'];
  placed: PlacedExam[];
  unplaced: Unplaced[];
  /** Minutes of watch this proposal adds per teacher. */
  added: Map<string, number>;
  metrics: PlanExamsResponse['metrics'];
}

const reverse = (map: Map<string, string>): Map<string, string> => new Map([...map].map(([realId, anonId]) => [anonId, realId]));

/** The engine's answer put back into real ids and times. A choice that names an id the request did not carry is refused. */
export function realise(built: BuiltRequest, response: PlanExamsResponse): RealisedPlan {
  const exams = reverse(built.maps.exams);
  const rooms = reverse(built.maps.rooms);
  const teachers = reverse(built.maps.teachers);
  const classes = reverse(built.maps.classes);
  const known = (map: Map<string, string>, anonId: string, what: string): string => {
    const real = map.get(anonId);
    if (!real) throw new Error(`The exam planner answered with a ${what} the request did not carry.`);
    return real;
  };
  const placed: PlacedExam[] = response.placed.map((out: PlacedExamOut) => {
    const examId = known(exams, out.exam, 'exam');
    const slot = built.slots.get(examId)?.[out.slot];
    if (!slot) throw new Error('The exam planner answered with a time the request did not carry.');
    return {
      examId,
      date: slot.date,
      start: slot.start,
      end: slot.end,
      loss: slot.loss,
      rooms: out.rooms.map((room) => ({
        roomId: known(rooms, room.room, 'room'),
        writers: room.writers,
        teacherIds: room.invigilators.map((id) => known(teachers, id, 'teacher')),
      })),
    };
  });
  const unplaced: Unplaced[] = [
    ...built.unplaced.map((one) => ({ examId: one.examId, reason: one.reason, params: one.params, message: null })),
    ...response.unplaced.map((one) => ({
      examId: known(exams, one.exam, 'exam'),
      reason: one.reason,
      // A class the reason names comes back as the real id; the service puts its name on it.
      params: typeof one.params.classId === 'string' ? { ...one.params, classId: classes.get(one.params.classId) ?? '' } : one.params,
      message: one.message,
    })),
  ];
  const added = new Map<string, number>();
  for (const row of response.invigilatorMinutes) {
    added.set(known(teachers, row.teacher, 'teacher'), row.minutes);
  }
  return { status: response.status, placed, unplaced, added, metrics: response.metrics };
}
