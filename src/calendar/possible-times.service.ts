import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { LessonRecurrence, PrismaClient } from '@prisma/client';
import { recordRead } from '../access-log/access-log';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { roomNeedsOf, type RoomNeeds } from '../optimization/room-eligibility';
import { constraintsOfYear } from '../staffing/duty-slot-year';
import { SwapContext } from '../swaps/swap-context';
import { dayLessonOf, SwapReads } from '../swaps/swap-reads';
import { readSwapData, type SwapData } from '../swaps/swap-snapshot';
import type { SoftCost, SwapLesson } from '../swaps/swap-types';
import { judgeLessons, type JudgeItem, type JudgedCandidate, type LessonVerdict } from './lesson-judge';
import {
  byScore,
  costOf,
  probeStarts,
  runsOf,
  type CostedStart,
  type PossibleSubject,
  type PossibleWindow,
  type PossibleWorld,
  type ProbedStart,
  type RoomFact,
  type Run,
  type Settled,
  type WishRow,
} from './possible-times';
import { MasterLessonsService } from './master-lessons.service';
import { readClosedWeeks } from './school-weeks';
import { sharedSeatsByRoom } from '../common/shared-rooms';
import { readSharedMode } from '../common/shared-rooms.reader';
import type { PossibleTimesDto } from './dto/possible-times.dto';

/*
 * E3: POST /api/v1/master-lessons/possible-times. The reading half of the board's "Välj, se, lägg": which times a lesson (or a
 * brick that is not a lesson yet) can stand at, which are shut by a rule and by which, and which of the free ones is best. The
 * rules and the order are in possible-times.ts; this file reads the school, asks the judge, and says it.
 *
 * Nothing here writes, and nothing here is a rule: the judge (judgeLessons, the function POST /judge and every write ask) has the
 * last word on every time that is called free. The prune before it only decides what is not worth asking.
 */

/** The longest the judge is asked for: after it, the times not yet judged are not painted, and `truncated` says so. */
const JUDGE_BUDGET_MS = 1200;
/** How many candidates go to the judge in one call: the budget is looked at between calls. */
const JUDGE_CHUNK = 24;
const DEFAULT_LIMIT = 12;
const DEFAULT_FROM = 7 * 60;
const DEFAULT_TO = 18 * 60;
/** A lesson that does not exist yet is called `brick`, or `brick#<n>` among several: no real id (a uuid) starts with it. */
export const BRICK_ID = 'brick';
export const isNewLesson = (id: string): boolean => id.startsWith(BRICK_ID);

/** The rooms of the lessons of a unit that stand in another than their own at a candidate start: what a run of "another room" carries. */
function roomsOf(subject: PossibleSubject, candidate: CostedStart): Array<{ lessonId: string; roomId: string | null }> {
  return subject.unit.members
    .filter((member) => (candidate.rooms.get(member.id) ?? null) !== member.roomId)
    .map((member) => ({ lessonId: isNewLesson(member.id) ? '' : member.id, roomId: candidate.rooms.get(member.id) ?? null }));
}

export interface PossibleOption {
  /** 1 is the best. */
  rank: number;
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
  /** The room each lesson of the unit stands in at this time; another than its own when `roomChanged`. */
  lessons: Array<{ lessonId: string; roomId: string | null; startMinutes: number; endMinutes: number }>;
  roomChanged: boolean;
  /** The soft figures of laying it here, before and after (swap-soft.ts): what changes, in numbers. */
  costs: SoftCost[];
  /** The school's wishes the time meets (PREFERRED_BUSY) and breaks (PREFERRED_FREE). */
  wishes: { met: number; avoided: number };
  /** The order's own figure; lower is better. Not a figure to show. */
  score: number;
}

/** A lesson that holds a stretch, named the way a refusal names one: by class, subject, day and clock. */
export interface PossibleBlocker {
  lessonId: string;
  className: string;
  subjectName: string;
  dayOfWeek: number;
  startMinutes: number;
  endMinutes: number;
  isLocked: boolean;
}

export interface PossibleTimes {
  academicYearId: string;
  subject: {
    /** The lesson, or null for a brick. */
    lessonId: string | null;
    className: string;
    subjectName: string;
    minutes: number;
    /** Every lesson that moves with it: a block's, a half's. */
    lessonIds: string[];
    isLocked: boolean;
    /** Stands nowhere: a brick, or a lesson on the tray. */
    unplaced: boolean;
    /** Where it stands now. */
    current: { dayOfWeek: number; startMinutes: number; endMinutes: number } | null;
  };
  /** The lesson is a förläggning's: it is moved on the timplan, and no time here is its own. */
  immovable?: 'PLACED';
  stepMinutes: number;
  /** The best, best first. */
  options: PossibleOption[];
  /** Every start asked about, cut into runs of one answer, per day. */
  days: Array<{ dayOfWeek: number; runs: Run[] }>;
  /** The lessons the runs name as holding a stretch, by id. */
  blockers: Record<string, PossibleBlocker>;
  stats: {
    starts: number;
    closed: number;
    inTheWay: number;
    crowded: number;
    /** Asked of the judge, and how many it refused (a time the prune let through and the judge did not). */
    judged: number;
    refused: number;
    free: number;
    /** The judge's time ran out: some starts were not judged and are not painted. */
    truncated: boolean;
    elapsedMs: number;
    phasesMs: { read: number; index: number; warm: number; probe: number; judge: number };
  };
}

export const clock = (value: string | null | undefined, fallback: number): number =>
  value ? Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5)) : fallback;
const minutesOf = (time: Date): number => time.getUTCHours() * 60 + time.getUTCMinutes();
const dateOf = (value: string | null): Date | null => (value ? new Date(`${value}T00:00:00.000Z`) : null);
const parseDate = (value: string | null | undefined): string | null => (value ? value.slice(0, 10) : null);

/** What a stored lesson is read with: the lesson as the swap search holds it, and what the questions of the board ask of its state. */
export const STORED_LESSON_SELECT = {
  id: true,
  academicYearId: true,
  subjectId: true,
  studentGroupId: true,
  teacherId: true,
  coTeacherId: true,
  roomId: true,
  dayOfWeek: true,
  startTime: true,
  endTime: true,
  recurrence: true,
  startDate: true,
  endDate: true,
  isLocked: true,
  isParked: true,
  isGenerated: true,
  fromPlacement: true,
  subject: { select: { name: true } },
  studentGroup: { select: { name: true } },
  extraGroups: { select: { studentGroupId: true } },
  participants: { select: { studentId: true } },
} as const;

type StoredLesson = {
  id: string;
  subjectId: string;
  studentGroupId: string;
  teacherId: string | null;
  coTeacherId: string | null;
  roomId: string | null;
  dayOfWeek: number;
  startTime: Date;
  endTime: Date;
  recurrence: LessonRecurrence;
  startDate: Date | null;
  endDate: Date | null;
  isLocked: boolean;
  fromPlacement: boolean;
  isGenerated: boolean;
  subject: { name: string };
  studentGroup: { name: string };
  extraGroups: Array<{ studentGroupId: string }>;
  participants: Array<{ studentId: string }>;
};

/** A stored lesson as the swap search holds it. A förläggning's lesson counts as locked: Generera writes it again where its förläggning stands. */
export function swapLessonOfRow(row: StoredLesson): SwapLesson {
  return {
    id: row.id,
    subjectId: row.subjectId,
    subjectName: row.subject.name,
    studentGroupId: row.studentGroupId,
    groupName: row.studentGroup.name,
    teacherId: row.teacherId,
    coTeacherId: row.coTeacherId,
    roomId: row.roomId,
    dayOfWeek: row.dayOfWeek,
    startMinutes: minutesOf(row.startTime),
    endMinutes: minutesOf(row.endTime),
    recurrence: row.recurrence,
    startDate: parseDate(row.startDate?.toISOString()),
    endDate: parseDate(row.endDate?.toISOString()),
    isLocked: row.isLocked || row.fromPlacement,
    isGenerated: row.isGenerated,
    extraGroupIds: row.extraGroups.map((entry) => entry.studentGroupId).sort(),
    studentIds: row.participants.map((entry) => entry.studentId).sort(),
  };
}

@Injectable()
export class PossibleTimesService {
  /** How long the judge is asked for, in milliseconds: a field so that a probe on a loaded host can be given all the time it needs. */
  judgeBudgetMs = JUDGE_BUDGET_MS;

  /**
   * How long the question's transaction may run: the default 15 s, and never less than the judge's budget and ten seconds more. In the
   * service the budget is 1.2 s; a probe on a loaded host raises it to minutes, and a transaction that expired under the judge would be
   * a failure of the host and not an answer.
   */
  transactionMs(): number {
    return Math.max(15_000, this.judgeBudgetMs + 10_000);
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly masterLessons: MasterLessonsService,
  ) {}

  async possibleTimes(dto: PossibleTimesDto, user: AuthenticatedUser): Promise<PossibleTimes> {
    if ((dto.lessonId === undefined) === (dto.brick === undefined)) {
      throw new BadRequestException('Name either lessonId or brick, and not both.');
    }
    const started = Date.now();
    return this.prisma.withRls(user, async (tx) => {
      const found = await this.subjectOf(tx, dto);
      const academicYearId = found.academicYearId;
      const stepMinutes = dto.stepMinutes ?? 5;
      const window: PossibleWindow = {
        days: [...new Set(dto.days ?? [1, 2, 3, 4, 5])],
        fromMinutes: clock(dto.from, DEFAULT_FROM),
        toMinutes: clock(dto.to, DEFAULT_TO),
        stepMinutes,
      };

      if (found.placed) {
        return {
          academicYearId,
          subject: found.view,
          immovable: 'PLACED',
          stepMinutes,
          options: [],
          days: [],
          blockers: {},
          stats: emptyStats(started),
        };
      }

      const reading = Date.now();
      const data = await readSwapData(tx, user, academicYearId);
      const indexing = Date.now();
      const unplaced = found.lesson.unplaced ? [found.lesson.lesson] : [];
      const context = await this.contextOf(tx, data, unplaced);
      const unit = context.unitOf.get(found.lesson.lesson.id);
      if (!unit) throw new NotFoundException('The lesson is not in the year read.');
      const subject: PossibleSubject = { unit, lesson: found.lesson.lesson, unplaced: found.lesson.unplaced };
      // The lessons that move with it: a block's, a half's. A brick is no lesson yet and moves with nothing.
      if (!found.lesson.unplaced) found.view.lessonIds = unit.members.map((member) => member.id);
      const reads = new SwapReads(data.lessons);
      const warming = Date.now();
      await reads.warm(tx, data);
      const probing = Date.now();

      const world = await this.worldOf(tx, data, context, unit.members);
      const probed = probeStarts(world, subject, window);
      const judging = Date.now();

      const { settled, options, judged, refused, truncated } = await this.judge(tx, data, world, subject, probed, reads, dto.limit ?? DEFAULT_LIMIT);

      const blockers: Record<string, PossibleBlocker> = {};
      for (const { answer } of settled) {
        if (answer.kind !== 'IN_THE_WAY' || blockers[answer.blockerId]) continue;
        const lesson = context.lessonById.get(answer.blockerId)!;
        blockers[lesson.id] = {
          lessonId: lesson.id,
          className: lesson.groupName,
          subjectName: lesson.subjectName,
          dayOfWeek: lesson.dayOfWeek,
          startMinutes: lesson.startMinutes,
          endMinutes: lesson.endMinutes,
          isLocked: lesson.isLocked,
        };
      }

      // A teacher's day counted against a limit of their post is a read of that post.
      const limited = unit.members.flatMap((member) => [member.teacherId, member.coTeacherId]).filter((id): id is string => id !== null && data.postLimited.has(id));
      if (options.length > 0) await recordRead(tx, 'EMPLOYMENT', limited, user.channel);

      const runs = runsOf(settled, stepMinutes);
      const count = (kind: Settled['kind']) => settled.filter(({ answer }) => answer.kind === kind).length;
      return {
        academicYearId,
        subject: found.view,
        stepMinutes,
        options,
        days: window.days
          .slice()
          .sort((a, b) => a - b)
          .map((dayOfWeek) => ({ dayOfWeek, runs: runs.filter((run) => run.dayOfWeek === dayOfWeek) })),
        blockers,
        stats: {
          starts: probed.length,
          closed: count('CLOSED'),
          inTheWay: count('IN_THE_WAY'),
          crowded: count('CROWDED'),
          judged,
          refused,
          free: count('FREE') + count('CHANGE'),
          truncated,
          elapsedMs: Date.now() - started,
          phasesMs: { read: indexing - reading, index: warming - indexing, warm: probing - warming, probe: judging - probing, judge: Date.now() - judging },
        },
      };
    }, { timeoutMs: this.transactionMs() });
  }

  /**
   * The school as the judge sees it, for the prune: the snapshot of the year, the lessons that stand nowhere yet, the läsår's closed
   * weeks (a lesson of the autumn to the 10th of January and one of the spring from the 4th meet only in a jullov: no clash, as the
   * judge says) and the rooms the school lets several lessons share while their pupils fit (the judge counts the pupils, so a lesson
   * in such a room is no obstacle to the prune).
   */
  async contextOf(tx: PrismaClient, data: SwapData, unplaced: readonly SwapLesson[]): Promise<SwapContext> {
    return new SwapContext(data, { unplaced, ...(await this.worldFactsOf(tx, data)) });
  }

  /**
   * The facts beside the snapshot that a SwapContext is built with: the läsår's closed weeks and the rooms that may be shared. The fill (board-fill)
   * builds a new context after every brick it lays, and reads these once.
   */
  async worldFactsOf(tx: PrismaClient, data: SwapData): Promise<{ closedWeeks: Awaited<ReturnType<typeof readClosedWeeks>>; sharedRooms: ReadonlySet<string> }> {
    const sharedMode = await readSharedMode(tx, { academicYearId: data.academicYearId });
    const sharedRooms =
      sharedMode === 'OFF'
        ? new Set<string>()
        : new Set(
            sharedSeatsByRoom(
              sharedMode,
              await tx.room.findMany({ where: { schoolId: data.schoolId, canBeShared: true, capacity: { not: null } }, select: { id: true, canBeShared: true, capacity: true } }),
            ).keys(),
          );
    return { closedWeeks: await readClosedWeeks(tx, data.academicYearId), sharedRooms };
  }

  // ---------------------------------------------------------------------------
  // The subject: a lesson that exists, or a brick that does not yet.
  // ---------------------------------------------------------------------------

  async subjectOf(
    tx: PrismaClient,
    dto: Pick<PossibleTimesDto, 'lessonId' | 'brick'>,
  ): Promise<{
    academicYearId: string;
    placed: boolean;
    lesson: { lesson: SwapLesson; unplaced: boolean };
    view: PossibleTimes['subject'];
  }> {
    if (dto.lessonId !== undefined) {
      const row = await tx.masterLesson.findUnique({ where: { id: dto.lessonId }, select: STORED_LESSON_SELECT });
      if (!row) throw new NotFoundException('Master lesson not found.');
      const lesson = swapLessonOfRow(row);
      const unplaced = row.isParked;
      return {
        academicYearId: row.academicYearId,
        // A förläggning's lesson is moved on the timplan: Generera writes it again where its förläggning stands.
        placed: row.fromPlacement,
        lesson: { lesson, unplaced },
        view: {
          lessonId: row.id,
          className: lesson.groupName,
          subjectName: lesson.subjectName,
          minutes: lesson.endMinutes - lesson.startMinutes,
          lessonIds: [row.id],
          isLocked: row.isLocked,
          unplaced,
          current: unplaced ? null : { dayOfWeek: lesson.dayOfWeek, startMinutes: lesson.startMinutes, endMinutes: lesson.endMinutes },
        },
      };
    }

    const brick = dto.brick!;
    const [group, subject] = await Promise.all([
      tx.studentGroup.findFirst({ where: { id: brick.studentGroupId, academicYearId: brick.academicYearId }, select: { name: true } }),
      tx.subject.findUnique({ where: { id: brick.subjectId }, select: { name: true } }),
    ]);
    if (!group) throw new NotFoundException('Student group not found in the year.');
    if (!subject) throw new NotFoundException('Subject not found.');
    const lesson: SwapLesson = {
      id: BRICK_ID,
      subjectId: brick.subjectId,
      subjectName: subject.name,
      studentGroupId: brick.studentGroupId,
      groupName: group.name,
      teacherId: brick.teacherId ?? null,
      coTeacherId: brick.coTeacherId ?? null,
      roomId: brick.roomId ?? null,
      // A placeholder no question reads: the brick stands nowhere (SwapContext `unplaced`).
      dayOfWeek: 1,
      startMinutes: 0,
      endMinutes: brick.minutes,
      recurrence: (brick.recurrence ?? 'ALL_WEEKS') as LessonRecurrence,
      startDate: parseDate(brick.startDate),
      endDate: parseDate(brick.endDate),
      isLocked: false,
      isGenerated: false,
      extraGroupIds: [...new Set(brick.extraGroupIds ?? [])].filter((id) => id !== brick.studentGroupId).sort(),
      studentIds: [...new Set(brick.studentIds ?? [])].sort(),
    };
    return {
      academicYearId: brick.academicYearId,
      placed: false,
      lesson: { lesson, unplaced: true },
      view: {
        lessonId: null,
        className: group.name,
        subjectName: subject.name,
        minutes: brick.minutes,
        lessonIds: [],
        isLocked: false,
        unplaced: true,
        current: null,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // The facts beside the snapshot: the rooms, what a lesson needs of one, the school's wishes.
  // ---------------------------------------------------------------------------

  async worldOf(tx: PrismaClient, data: SwapData, context: SwapContext, members: readonly SwapLesson[]): Promise<PossibleWorld> {
    const subjectIds = [...new Set(members.map((member) => member.subjectId))];
    const [roomRows, subjectRows, wishRows] = await Promise.all([
      tx.room.findMany({
        where: { schoolId: data.schoolId },
        select: { id: true, name: true, capacity: true, roomTypeId: true, minGradeLevel: true, maxGradeLevel: true, building: true },
      }),
      tx.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, requiredRoomTypeId: true } }),
      tx.availabilityConstraint.findMany({
        where: { type: { in: ['PREFERRED_FREE', 'PREFERRED_BUSY'] }, date: null, dayOfWeek: { not: null }, AND: [constraintsOfYear(data.academicYearId)] },
        select: { resourceType: true, userId: true, roomId: true, studentGroupId: true, dayOfWeek: true, startTime: true, endTime: true, type: true },
      }),
    ]);
    const rooms: RoomFact[] = roomRows;
    const requiredRoomType = new Map(subjectRows.map((row) => [row.id, row.requiredRoomTypeId]));
    const needs = new Map<string, RoomNeeds>();
    const wishes: WishRow[] = wishRows.flatMap((row) =>
      row.resourceType === 'GRADE_LEVEL' || row.dayOfWeek === null
        ? []
        : [
            {
              resourceType: row.resourceType as WishRow['resourceType'],
              userId: row.userId,
              roomId: row.roomId,
              studentGroupId: row.studentGroupId,
              dayOfWeek: row.dayOfWeek,
              startMinutes: minutesOf(row.startTime),
              endMinutes: minutesOf(row.endTime),
              type: row.type as WishRow['type'],
            },
          ],
    );
    return {
      context,
      rooms,
      wishes,
      needsOf: (lesson) => {
        const known = needs.get(lesson.id);
        if (known) return known;
        const made = roomNeedsOf(
          data.rosters,
          { groupIds: [lesson.studentGroupId, ...lesson.extraGroupIds], studentIds: lesson.studentIds },
          { requiredRoomTypeId: requiredRoomType.get(lesson.subjectId) ?? null },
          data.gradeNumbering,
        );
        needs.set(lesson.id, made);
        return made;
      },
    };
  }

  // ---------------------------------------------------------------------------
  // The judge, in the order of the cost, until the time is out.
  // ---------------------------------------------------------------------------

  private async judge(
    tx: PrismaClient,
    data: SwapData,
    world: PossibleWorld,
    subject: PossibleSubject,
    probed: readonly ProbedStart[],
    reads: SwapReads,
    limit: number,
  ): Promise<{
    settled: Array<{ dayOfWeek: number; startMinutes: number; answer: Settled }>;
    options: PossibleOption[];
    judged: number;
    refused: number;
    truncated: boolean;
  }> {
    const settled = new Map<string, { dayOfWeek: number; startMinutes: number; answer: Settled }>();
    const keyOf = (day: number, start: number) => `${day}|${start}`;
    const candidates: CostedStart[] = [];
    for (const { dayOfWeek, startMinutes, probe } of probed) {
      const set = (answer: Settled) => settled.set(keyOf(dayOfWeek, startMinutes), { dayOfWeek, startMinutes, answer });
      switch (probe.kind) {
        case 'STANDS':
          set({ kind: 'STANDS' });
          break;
        case 'CLOSED':
          set({ kind: 'CLOSED', code: probe.code, params: probe.params });
          break;
        case 'IN_THE_WAY':
          set({ kind: 'IN_THE_WAY', blockerId: probe.blocker.id });
          break;
        case 'CROWDED':
          set({ kind: 'CROWDED', units: probe.units, locked: probe.locked });
          break;
        case 'CANDIDATE':
          set({ kind: 'UNJUDGED' });
          candidates.push(costOf(world, subject, { dayOfWeek, startMinutes, rooms: probe.rooms, roomChanged: probe.roomChanged }));
          break;
      }
    }
    candidates.sort(byScore);

    const started = Date.now();
    const accepted: CostedStart[] = [];
    let judged = 0;
    let refused = 0;
    let truncated = false;
    for (let at = 0; at < candidates.length; at += JUDGE_CHUNK) {
      // The first chunk is always judged: a slow host gets a short list, never an empty one.
      if (at > 0 && Date.now() - started > this.judgeBudgetMs) {
        truncated = true;
        break;
      }
      const chunk = candidates.slice(at, at + JUDGE_CHUNK);
      const verdicts = await this.judgeChunk(tx, data, subject, chunk, reads);
      chunk.forEach((candidate, index) => {
        judged += 1;
        const ok = verdicts[index]!;
        const answer: Settled = ok
          ? candidate.roomChanged
            ? { kind: 'CHANGE', rooms: roomsOf(subject, candidate) }
            : { kind: 'FREE' }
          : // The prune let it through and the judge did not (a rule only the judge holds): nothing is painted, and nothing offered.
            { kind: 'CROWDED', units: 0, locked: false };
        settled.set(keyOf(candidate.dayOfWeek, candidate.startMinutes), { dayOfWeek: candidate.dayOfWeek, startMinutes: candidate.startMinutes, answer });
        if (ok) accepted.push(candidate);
        else refused += 1;
      });
    }

    const options = accepted
      .sort(byScore)
      .slice(0, limit)
      .map((candidate, index): PossibleOption => ({
        rank: index + 1,
        dayOfWeek: candidate.dayOfWeek,
        startMinutes: candidate.startMinutes,
        endMinutes: candidate.endMinutes,
        lessons: subject.unit.members.map((member) => ({
          lessonId: isNewLesson(member.id) ? '' : member.id,
          roomId: candidate.rooms.get(member.id) ?? null,
          startMinutes: candidate.startMinutes,
          endMinutes: candidate.startMinutes + (member.endMinutes - member.startMinutes),
        })),
        roomChanged: candidate.roomChanged,
        costs: candidate.costs,
        wishes: candidate.wishes,
        score: candidate.score,
      }));
    return {
      settled: [...settled.values()].sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startMinutes - b.startMinutes),
      options,
      judged,
      refused,
      truncated,
    };
  }

  /** The judge's verdict on each candidate of one subject, the unit's lessons judged as one move (the card's way, as the swap search). */
  private judgeChunk(tx: PrismaClient, data: SwapData, subject: PossibleSubject, chunk: readonly CostedStart[], reads: SwapReads): Promise<boolean[]> {
    return this.judgePairs(tx, data, chunk.map((candidate) => ({ subject, candidate })), reads);
  }

  /**
   * The judge's verdict on each (subject, candidate) pair: every lesson of the subject's unit laid at the candidate's start and
   * judged beside the others as one move. The same call serves one subject at many starts (possible times) and many subjects at
   * one start (what fits here).
   */
  async judgePairs(
    tx: PrismaClient,
    data: SwapData,
    pairs: ReadonlyArray<{ subject: PossibleSubject; candidate: CostedStart }>,
    reads: SwapReads,
  ): Promise<boolean[]> {
    return (await this.judgeVerdicts(tx, data, pairs, reads)).map((members) => members.every((verdict) => verdict.ok));
  }

  /** The judge's whole verdict on each member of each pair's unit, in the unit's order: what judgePairs reads `ok` from, and the room chooser reads the reasons of. */
  async judgeVerdicts(
    tx: PrismaClient,
    data: SwapData,
    pairs: ReadonlyArray<{ subject: PossibleSubject; candidate: Pick<CostedStart, 'dayOfWeek' | 'startMinutes' | 'rooms'> }>,
    reads: SwapReads,
  ): Promise<LessonVerdict[][]> {
    const items: JudgeItem[] = [];
    for (const { subject, candidate } of pairs) {
      const members = subject.unit.members;
      const memberIds = members.map((member) => member.id);
      const landings = members.map((member) => ({
        member,
        room: candidate.rooms.get(member.id) ?? null,
        at: { dayOfWeek: candidate.dayOfWeek, startMinutes: candidate.startMinutes, endMinutes: candidate.startMinutes + (member.endMinutes - member.startMinutes) },
      }));
      for (const { member, room, at } of landings) {
        const judged: JudgedCandidate = {
          dayOfWeek: at.dayOfWeek,
          startMinutes: at.startMinutes,
          endMinutes: at.endMinutes,
          teacherId: member.teacherId,
          coTeacherId: member.coTeacherId,
          roomId: room,
          extraGroupIds: member.extraGroupIds,
          studentIds: member.studentIds,
          recurrence: member.recurrence,
          startDate: dateOf(member.startDate),
          endDate: dateOf(member.endDate),
        };
        items.push({
          lesson: { id: isNewLesson(member.id) ? null : member.id, studentGroupId: member.studentGroupId, subjectId: member.subjectId },
          candidate: judged,
          // A lesson on the tray, or one that does not exist yet, stands nowhere: every rule is asked.
          stands: subject.unplaced
            ? null
            : {
                dayOfWeek: member.dayOfWeek,
                startMinutes: member.startMinutes,
                endMinutes: member.endMinutes,
                teacherId: member.teacherId,
                coTeacherId: member.coTeacherId,
                roomId: member.roomId,
                extraGroupIds: member.extraGroupIds,
                recurrence: member.recurrence,
                startDate: dateOf(member.startDate),
                endDate: dateOf(member.endDate),
              },
          excludeIds: memberIds.filter((id) => !isNewLesson(id)),
          alongside: landings
            .filter((other) => other.member.id !== member.id && other.at.dayOfWeek === at.dayOfWeek)
            .map((other) => dayLessonOf({ ...other.member, roomId: other.room }, other.at)),
        });
      }
    }
    const verdicts = await judgeLessons(
      tx,
      this.masterLessons,
      { academicYearId: data.academicYearId, schoolId: data.schoolId, basis: data.basis, gradeNumbering: data.gradeNumbering },
      items,
      { reads },
    );
    const out: LessonVerdict[][] = [];
    let at = 0;
    for (const { subject } of pairs) {
      out.push(subject.unit.members.map(() => verdicts[at++]!));
    }
    return out;
  }
}

function emptyStats(started: number): PossibleTimes['stats'] {
  return {
    starts: 0,
    closed: 0,
    inTheWay: 0,
    crowded: 0,
    judged: 0,
    refused: 0,
    free: 0,
    truncated: false,
    elapsedMs: Date.now() - started,
    phasesMs: { read: 0, index: 0, warm: 0, probe: 0, judge: 0 },
  };
}
