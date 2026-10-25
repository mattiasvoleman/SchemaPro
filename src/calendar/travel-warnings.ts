import type { LessonRecurrence } from '@prisma/client';
import { travelBreaches, type PlacedLesson, type SiteMap, type TravelBreach } from '../common/site-travel';

/**
 * TRAVEL_TIME_SHORT: a hand edit in the grundschema that leaves a teacher, or
 * the pupils of a lesson, less time between two lessons at different sites
 * than the walk between them (Skolområden och restid, 20261124090000; the
 * rule is src/common/site-travel.ts).
 *
 * A WARNING beside the saved lesson, never a refusal: the school may have
 * reasons the data does not hold (a teacher with a car, a class let out
 * early), and the generator's own rule comes later, off by default, in
 * Restid i generatorn. Like the ämnesfördelning's warning it is read after
 * the write, from the day as the edit leaves it, and names only walks the
 * edited lesson is one end of: a breach elsewhere that day is not this
 * edit's to report.
 *
 * Who walks:
 *   - each teacher on the lesson (teacherId and coTeacherId), between it and
 *     their own lessons before and after;
 *   - its pupils, between it and every lesson that shares a pupil with it —
 *     the classes, the teaching groups, the pupils named on it, and a half
 *     standing for the pupils it may hold, by the same "these share pupils"
 *     the clash check reads — each pupil from the lesson they actually come
 *     from (neighboursOf).
 *
 * The code's sentence is the engine catalogue's (app/messages.py), where the
 * gateway's other hand-edit warnings live, so the timetable renders it with
 * the code it already has. `name` is the teacher, or for pupils the groups of
 * whichever of the two lessons holds fewer of them: everyone who walks is on
 * both, so the smaller lesson names them best ("Spanska 7", not "7A").
 */
export const TRAVEL_TIME_SHORT = 'TRAVEL_TIME_SHORT';

export interface TravelWarning {
  code: typeof TRAVEL_TIME_SHORT;
  params: {
    party: 'TEACHER' | 'PUPILS';
    /** The teacher's name, or the walking pupils' group(s). */
    name: string;
    /** The site walked from, and to. */
    from: string;
    to: string;
    /** The pair's minutes. */
    minutes: number;
    /** The minutes between the two lessons. */
    gap: number;
    /** The other lesson: its subject, and its times as HH:MM–HH:MM. */
    other: string;
    time: string;
  };
}

/** The weeks a lesson runs: its parity and its Från and Till (yyyy-mm-dd, inclusive). */
export interface TravelWeeks {
  recurrence: LessonRecurrence;
  startDate: string | null;
  endDate: string | null;
}

/** A lesson of the day as the rule reads it. */
export interface TravelDayLesson extends PlacedLesson {
  subjectName: string;
  teacherIds: readonly string[];
  /** The groups attending it: its own and the ones joining. */
  groupIds: readonly string[];
  /**
   * Ersättande grupper: the groups replacing its subject that are not on it
   * (common/replacing-groups.ts). Their members are elsewhere, so a half pair
   * with one of them says nothing about this lesson's pupils.
   */
  leftOut?: ReadonlySet<string>;
  /** Every pupil it holds: the groups' members and the pupils named on it. */
  pupils: ReadonlySet<string>;
  weeks: TravelWeeks;
}

/**
 * Whether `m` runs in every week `a` and `b` both run: its parity is every
 * week, or theirs; its Från is no later than theirs and its Till no earlier.
 * A lesson between two others hides the walk from one to the other only in
 * the weeks it runs — an odd-week lesson in between leaves the even weeks'
 * walk, and one that stops at Christmas leaves the spring's.
 */
export function weeksCover(m: TravelWeeks, a: TravelWeeks, b: TravelWeeks): boolean {
  const both =
    a.recurrence === 'ALL_WEEKS' ? b.recurrence : b.recurrence === 'ALL_WEEKS' || b.recurrence === a.recurrence ? a.recurrence : null;
  if (both === null) return true;
  if (m.recurrence !== 'ALL_WEEKS' && m.recurrence !== both) return false;
  const from = [a.startDate, b.startDate].reduce<string | null>((x, y) => (x === null ? y : y === null ? x : x > y ? x : y), null);
  const to = [a.endDate, b.endDate].reduce<string | null>((x, y) => (x === null ? y : y === null ? x : x < y ? x : y), null);
  if (m.startDate !== null && (from === null || m.startDate > from)) return false;
  if (m.endDate !== null && (to === null || m.endDate < to)) return false;
  return true;
}

export interface TravelWarningContext {
  map: SiteMap;
  /** Whether two lessons' weeks can meet (lesson-recurrence.ts, weeksCanOverlap). */
  weeksMeet: (a: TravelDayLesson, b: TravelDayLesson) => boolean;
  /** Whether two groups share the pupils a half may hold (class-halves.ts). */
  halvesPair: (a: string, b: string) => boolean;
  teacherName: (id: string) => string;
  groupName: (id: string) => string;
}

const hhmm = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** Whether two lessons have a pupil in common, a half standing for the pupils it may hold. */
export function sharePupils(a: TravelDayLesson, b: TravelDayLesson, halvesPair: (x: string, y: string) => boolean): boolean {
  if (a.groupIds.some((group) => b.groupIds.includes(group))) return true;
  for (const pupil of a.pupils) if (b.pupils.has(pupil)) return true;
  return a.groupIds.some((x) =>
    b.groupIds.some((y) => halvesPair(x, y) && !a.leftOut?.has(y) && !b.leftOut?.has(x)),
  );
}

export function travelWarningsOf(
  context: TravelWarningContext,
  target: TravelDayLesson,
  day: readonly TravelDayLesson[],
): TravelWarning[] {
  const { map } = context;
  if (target.roomId === null || !map.siteOfRoom.has(target.roomId)) return [];
  const meeting = day.filter((other) => other.id !== target.id && context.weeksMeet(target, other));
  const warnings: TravelWarning[] = [];
  const say = (party: 'TEACHER' | 'PUPILS', name: string, breach: TravelBreach<TravelDayLesson>) => {
    const other = breach.from.id === target.id ? breach.to : breach.from;
    warnings.push({
      code: TRAVEL_TIME_SHORT,
      params: {
        party,
        name,
        from: map.nameOf.get(breach.walk.fromSite) ?? '',
        to: map.nameOf.get(breach.walk.toSite) ?? '',
        minutes: breach.walk.minutes,
        gap: breach.gap,
        other: other.subjectName,
        time: `${hhmm(other.start)}–${hhmm(other.end)}`,
      },
    });
  };

  // A teacher's lesson between O and the target hides O only in the weeks it
  // runs: some lesson between must run every week the two do.
  const teacherHidden = (o: TravelDayLesson, between: readonly TravelDayLesson[]) =>
    between.some((m) => weeksCover(m.weeks, o.weeks, target.weeks));
  for (const teacher of new Set(target.teacherIds)) {
    const own = meeting.filter((other) => other.teacherIds.includes(teacher));
    for (const breach of travelBreaches(map, target, own, teacherHidden)) say('TEACHER', context.teacherName(teacher), breach);
  }

  // Pupils: O is hidden when every pupil it and the target share goes to a
  // lesson in between that runs every week the two do. With no pupil known
  // on both — a class not yet filled, planned before the pupil import — the
  // groups they share stand for their pupils: O is hidden when one such
  // lesson in between holds every group O and the target share, so a class
  // with no roster walks from its own last lesson, as a filled one does.
  // Shared through a half alone (no group and no pupil in common), nobody is
  // known to go anywhere: kept.
  const pupilsHidden = (o: TravelDayLesson, between: readonly TravelDayLesson[]) => {
    const covering = between.filter((m) => weeksCover(m.weeks, o.weeks, target.weeks));
    const walkers = [...o.pupils].filter((pupil) => target.pupils.has(pupil));
    if (walkers.length > 0) return walkers.every((pupil) => covering.some((m) => m.pupils.has(pupil)));
    const groups = o.groupIds.filter((group) => target.groupIds.includes(group));
    return groups.length > 0 && covering.some((m) => groups.every((group) => m.groupIds.includes(group)));
  };
  const together = meeting.filter((other) => sharePupils(target, other, context.halvesPair));
  for (const breach of travelBreaches(map, target, together, pupilsHidden)) {
    const other = breach.from.id === target.id ? breach.to : breach.from;
    const smaller = other.pupils.size < target.pupils.size ? other : target;
    say('PUPILS', smaller.groupIds.map(context.groupName).join(', '), breach);
  }

  const seen = new Set<string>();
  return warnings.filter((warning) => {
    const key = JSON.stringify(warning.params);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
