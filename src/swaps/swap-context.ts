import { toNioarigSpan } from '../common/grade-numbering';
import { hasDistributionRule } from '../common/subject-distribution';
import { pupilCohortsOf, lockMarginOf } from '../optimization/pupil-cohorts';
import { gradeSpanOf } from '../optimization/room-eligibility';
import type { OtherSchoolHold } from '../optimization/other-school-holds';
import { meetOnlyInClosedWeeks, type ClosedWeeks } from '../calendar/school-weeks';
import { boardCodeOf, indexSittings, type BoardFacts } from './board-rules';
import type { GapConstraint, GapSpan } from './swap-gaps';
import { buildSoftMeasure, type SoftMeasure } from './swap-soft';
import type { SwapData } from './swap-snapshot';
import { buildUnits, weeksMeet } from './swap-units';
import type {
  ExternalTouch,
  HardCode,
  SwapLesson,
  SwapMove,
  SwapSlot,
  SwapUnit,
} from './swap-types';

/*
 * THE SEARCH'S WORLD: the snapshot, indexed.
 *
 * Built once per request from SwapData. It answers the three questions the
 * search asks without touching the database:
 *
 *   mayStand   a necessary condition for a unit at a slot (the prune)
 *   soft       what a set of moves costs (swap-soft.ts)
 *   board      the hard kinds the clash rule does not hold but the grid paints
 *              red and the generator keeps — ramtider, the class's meal, a
 *              weekly rule on årskurser, another school's hold — as a verdict
 *
 * The clash rule itself is NOT here. It is MasterLessonsService.findConflicts,
 * called by the service on the survivors; this file only prunes with the
 * parts of it that are a plain overlap, which is a subset by construction.
 */

const overlaps = (a0: number, a1: number, b0: number, b1: number): boolean => a0 < b1 && b0 < a1;

const holdMinutes = (time: string): number => {
  const [h, m] = time.split(':');
  return Number(h) * 60 + Number(m);
};

/** What stands in a landing's way (SwapContext.inTheWay). */
export interface InTheWay {
  /** The lessons that hold its teacher, room or class at the new time, each once. */
  lessons: SwapLesson[];
  /** The weekly rows that close its teacher, room or class there: the resource each closes. */
  closures: Array<'TEACHER' | 'ROOM' | 'GROUP'>;
}

export interface Landing {
  lesson: SwapLesson;
  to: SwapSlot;
}

export class SwapContext {
  readonly unitOf: ReadonlyMap<string, SwapUnit>;
  readonly soft: SoftMeasure;
  readonly lessonById: ReadonlyMap<string, SwapLesson>;
  private readonly byTeacherDay = new Map<string, SwapLesson[]>();
  private readonly byRoomDay = new Map<string, SwapLesson[]>();
  private readonly byGroupDay = new Map<string, SwapLesson[]>();
  private readonly buffer = new Map<string, { before: number; after: number }>();
  private readonly spans = new Map<string, GapSpan>();
  private readonly sittings: Map<string, SwapData['sittings'][number][]>;
  /** What FRAME, LUNCH and GRADE_RULE are judged on (board-rules.ts, the judge G5 asks too). */
  private readonly board: BoardFacts;
  private readonly holdsByResource = new Map<string, OtherSchoolHold[]>();
  private readonly gapConstraints: GapConstraint[];
  /** The lessons the school plans that stand nowhere yet (the constructor's `unplaced`). */
  private readonly unplacedIds: ReadonlySet<string>;
  /** The weeks of the läsår in which no lesson is written (jullov): two lessons that meet only in them are no double booking. */
  private readonly closedWeeks: ClosedWeeks | null;
  /** The rooms the school lets hold several lessons at once (Placeringsregel 3): whether one more fits is the judge's count, not the prune's. */
  private readonly sharedRooms: ReadonlySet<string>;
  /**
   * group -> the groups that hold a pupil of it, or null at a school with a
   * replacing group. A class and a teaching group cut across it (språkval,
   * elevens val) clash when they share a pupil, and the clash rule says so; the
   * prune says it too, so that the judge is not asked about every slot a block
   * stands in. With a replacing group the rule lets a replaced pupil be
   * elsewhere (common/replacing-groups.ts), so the plain relation could refuse
   * what the rule allows: there the prune keeps to the groups themselves.
   */
  private readonly sharing: ReadonlyMap<string, readonly string[]> | null;

  /**
   * `unplaced`: lessons that are in the school's plan but stand nowhere yet (E3: a brick the schemaläggare asks the possible times
   * of). They belong to the pupils' cohorts, the teacher's week and the post's distribution, and each is a unit of its own, but they
   * occupy nothing and count for nothing until a move lays them somewhere: the figures before a move are the school without them.
   * Their `dayOfWeek`/`startMinutes`/`endMinutes` are a placeholder nothing reads.
   */
  constructor(
    readonly data: SwapData,
    options: {
      unplaced?: readonly SwapLesson[];
      /**
       * The läsår's closed weeks (school-weeks.ts readClosedWeeks), for the reader that must say what the judge says: findConflicts
       * does not count two lessons that meet only in a week no one sits (a jullov) as a double booking. Absent: every shared week
       * counts, as it did (the swap search keeps its prune a subset of the judge's, which is looser here and never stricter).
       */
      closedWeeks?: ClosedWeeks | null;
      /**
       * The rooms that may hold several lessons together while their pupils fit the seats (shared-rooms.ts, only when the school
       * holds the rule on). findConflicts counts the pupils and does not call such a room taken, so the prune must not hold a lesson
       * in one against another lesson of the room: the judge is asked, and it counts.
       */
      sharedRooms?: ReadonlySet<string>;
    } = {},
  ) {
    this.closedWeeks = options.closedWeeks ?? null;
    this.sharedRooms = options.sharedRooms ?? new Set();
    const unplaced = options.unplaced ?? [];
    const everyLesson = [...data.lessons, ...unplaced];
    this.lessonById = new Map(everyLesson.map((lesson) => [lesson.id, lesson]));

    // Pupil buffers per (group, subject), then the widest over a lesson's groups.
    const buffers = new Map<string, { before: number; after: number }>();
    for (const post of data.posts) {
      if (post.minutesBefore === 0 && post.minutesAfter === 0) continue;
      buffers.set(`${post.studentGroupId}:${post.subjectId}`, { before: post.minutesBefore, after: post.minutesAfter });
    }
    for (const lesson of everyLesson) {
      let before = 0;
      let after = 0;
      for (const groupId of [lesson.studentGroupId, ...lesson.extraGroupIds]) {
        const row = buffers.get(`${groupId}:${lesson.subjectId}`);
        if (!row) continue;
        before = Math.max(before, row.before);
        after = Math.max(after, row.after);
      }
      if (before > 0 || after > 0) this.buffer.set(lesson.id, { before, after });
    }

    // Indices of who stands where.
    const push = (map: Map<string, SwapLesson[]>, key: string, lesson: SwapLesson) => {
      const list = map.get(key);
      if (list) list.push(lesson);
      else map.set(key, [lesson]);
    };
    for (const lesson of data.lessons) {
      for (const teacherId of [lesson.teacherId, lesson.coTeacherId]) {
        if (teacherId !== null) push(this.byTeacherDay, `${teacherId}|${lesson.dayOfWeek}`, lesson);
      }
      if (lesson.roomId !== null) push(this.byRoomDay, `${lesson.roomId}|${lesson.dayOfWeek}`, lesson);
      for (const groupId of [lesson.studentGroupId, ...lesson.extraGroupIds]) {
        push(this.byGroupDay, `${groupId}|${lesson.dayOfWeek}`, lesson);
      }
    }

    // A group's years, in NIOARIG, as every school-wide span is stated.
    for (const group of data.groups) {
      const span = toNioarigSpan(gradeSpanOf(data.rosters, [group.id]), data.gradeNumbering);
      if (span) this.spans.set(group.id, [span.min, span.max]);
    }
    this.sittings = indexSittings(data.sittings);
    this.board = {
      frames: data.frames,
      sittings: this.sittings,
      gradeRules: data.constraints.filter((row) => row.resourceType === 'GRADE_LEVEL'),
      spans: this.spans,
    };
    for (const hold of data.holds) {
      const key = `${hold.resourceKind}|${hold.resourceId}`;
      const list = this.holdsByResource.get(key);
      if (list) list.push(hold);
      else this.holdsByResource.set(key, [hold]);
    }
    this.gapConstraints = data.constraints.flatMap((row): GapConstraint[] =>
      (row.resourceType === 'STUDENT_GROUP' || row.resourceType === 'GRADE_LEVEL') && row.endMinutes > row.startMinutes
        ? [
            {
              kind: row.resourceType,
              group: row.studentGroupId,
              min: row.minGradeLevel,
              max: row.maxGradeLevel,
              day: row.dayOfWeek,
              start: row.startMinutes,
              end: row.endMinutes,
            },
          ]
        : [],
    );

    this.sharing = data.groups.some((group) => group.replacesSubjectId !== null) ? null : sharingOf(data);

    // Units: what the school laid beside what.
    const blockOfPost = new Map(data.posts.map((post) => [`${post.studentGroupId}:${post.subjectId}`, post.blockId]));
    const sameTimes = new Map(data.blocks.map((block) => [block.id, block.sameTimesAsBlockId]));
    const groupFacts = new Map(
      data.groups.map((group) => [group.id, { halfOfId: group.halfOfId, replacesSubjectId: group.replacesSubjectId }]),
    );
    const placedUnits = buildUnits(data.lessons, {
      blockOf: (lesson) => blockOfPost.get(`${lesson.studentGroupId}:${lesson.subjectId}`) ?? null,
      sameTimesOf: (blockId) => sameTimes.get(blockId) ?? null,
      groupFacts,
      sharesPupils: (a, b) => {
        const members = data.rosters.membersByGroup.get(a);
        const other = data.rosters.membersByGroup.get(b);
        if (!members || !other) return false;
        for (const id of members) if (other.has(id)) return true;
        return false;
      },
    });
    this.unitOf = new Map([
      ...placedUnits,
      ...unplaced.map((lesson): [string, SwapUnit] => [
        lesson.id,
        { id: lesson.id, members: [lesson], links: [], slot: { dayOfWeek: lesson.dayOfWeek, startMinutes: lesson.startMinutes, endMinutes: lesson.endMinutes }, locked: false },
      ]),
    ]);
    this.unplacedIds = new Set(unplaced.map((lesson) => lesson.id));

    this.soft = this.softMeasure();
  }


  /** The cohorts, the margins and the rules behind the figures (swap-soft.ts). */
  private softMeasure(): SoftMeasure {
    const { data } = this;
    const lessons = [...this.lessonById.values()];
    const classes = new Set(data.groups.filter((group) => group.kind === 'CLASS').map((group) => group.id));
    const homeOf = new Map<string, string>();
    for (const row of data.rosters.homeMembers) {
      if (row.studentGroupId && classes.has(row.studentGroupId)) homeOf.set(row.id, row.studentGroupId);
    }
    // Every placed lesson is a "lock" to the cohort builder: pupils booked alike
    // are the pupils who sit the same lessons, by the report's own rule.
    const cohorts = pupilCohortsOf({
      homeOf,
      groupsOf: data.rosters.groupsByStudent,
      groups: data.groups,
      derivedKeys: [],
      locks: lessons.map((lesson) => ({
        id: lesson.id,
        groupIds: [lesson.studentGroupId, ...lesson.extraGroupIds],
        subjectId: lesson.subjectId,
        pupilIds: lesson.studentIds,
      })),
    });
    const margins = new Map<string, { before: number; after: number }>();
    const rows = new Map(
      data.posts.map((post) => [
        `${post.studentGroupId}:${post.subjectId}`,
        { minutesBefore: post.minutesBefore, minutesAfter: post.minutesAfter },
      ]),
    );
    for (const lesson of lessons) {
      const margin = lockMarginOf(rows, {
        groupIds: [lesson.studentGroupId, ...lesson.extraGroupIds],
        subjectId: lesson.subjectId,
      });
      if (margin) margins.set(lesson.id, { before: margin.minutesBefore, after: margin.minutesAfter });
    }
    return buildSoftMeasure({
      lessons,
      absent: this.unplacedIds,
      cohorts: cohorts.map((cohort) => ({
        pupils: cohort.pupils,
        lessonIds: new Set(cohort.fixedLessonIds),
        groups: cohort.groupIds,
      })),
      margins,
      spans: this.spans,
      constraints: this.gapConstraints,
      frames: data.frames,
      lunch: data.lunch,
      teacherRules: data.teacherRules,
      distribution: new Map(
        data.posts
          .filter((post) => hasDistributionRule(post.distribution))
          .map((post) => [`${post.studentGroupId}:${post.subjectId}`, post.distribution]),
      ),
    });
  }

  /** A unit's members laid at a slot, each keeping its own length. */
  landingsOf(unit: SwapUnit, to: SwapSlot): Landing[] {
    return unit.members.map((lesson) => ({
      lesson,
      to: {
        dayOfWeek: to.dayOfWeek,
        startMinutes: to.startMinutes,
        endMinutes: to.startMinutes + (lesson.endMinutes - lesson.startMinutes),
      },
    }));
  }

  // ---------------------------------------------------------------------------
  // The prune: teacher, room, class and the weekly rows, a plain overlap each.
  // ---------------------------------------------------------------------------

  /**
   * Whether `unit` may stand at `to`, the lessons in `vacating` gone. Every
   * test is one the clash rule makes too (findConflicts: same teacher, same
   * room, same class, the weekly rows), so a "no" is a "no" from the judge as
   * well; a "yes" is not a verdict. The board's kinds below are the verdict.
   */
  mayStand(unit: SwapUnit, to: SwapSlot, vacating: ReadonlySet<string>): boolean {
    for (const landing of this.landingsOf(unit, to)) {
      if (!this.freeOfLessons(landing, vacating)) return false;
      if (this.boardRefusal(landing) !== null) return false;
    }
    return true;
  }

  private freeOfLessons(landing: Landing, vacating: ReadonlySet<string>): boolean {
    const way = this.inTheWay(landing, vacating, true);
    return way.lessons.length === 0 && way.closures.length === 0;
  }

  /**
   * What stands in a landing's way: the lessons that hold its teacher, its room or its class (the pupils' own minutes before and
   * after counted) at the new time, and the weekly rows that close one of them. The one body of the prune: `mayStand` asks
   * whether it is empty, and the possible times (E3) ask what it holds, so the two can never disagree about a plain overlap.
   * `firstOnly` stops at the first hit, which is all the prune needs.
   */
  inTheWay({ lesson, to }: Landing, vacating: ReadonlySet<string>, firstOnly = false): InTheWay {
    const way: InTheWay = { lessons: [], closures: [] };
    const seen = new Set<string>();
    const hit = (other: SwapLesson): boolean => {
      if (!seen.has(other.id)) {
        seen.add(other.id);
        way.lessons.push(other);
      }
      return firstOnly;
    };
    const day = to.dayOfWeek;
    const closed = this.closedWeeks;
    const meets = (other: SwapLesson) =>
      !vacating.has(other.id) &&
      other.id !== lesson.id &&
      weeksMeet(lesson, other) &&
      !(closed !== null && meetOnlyInClosedWeeks(lesson, other, closed, day));
    for (const teacherId of [lesson.teacherId, lesson.coTeacherId]) {
      if (teacherId === null) continue;
      for (const other of this.byTeacherDay.get(`${teacherId}|${day}`) ?? []) {
        if (meets(other) && overlaps(to.startMinutes, to.endMinutes, other.startMinutes, other.endMinutes) && hit(other)) return way;
      }
    }
    if (lesson.roomId !== null && !this.sharedRooms.has(lesson.roomId)) {
      for (const other of this.byRoomDay.get(`${lesson.roomId}|${day}`) ?? []) {
        if (meets(other) && overlaps(to.startMinutes, to.endMinutes, other.startMinutes, other.endMinutes) && hit(other)) return way;
      }
    }
    const own = this.buffer.get(lesson.id);
    const pupilStart = to.startMinutes - (own?.before ?? 0);
    const pupilEnd = to.endMinutes + (own?.after ?? 0);
    const sharing = this.sharing;
    for (const groupId of [lesson.studentGroupId, ...lesson.extraGroupIds]) {
      for (const sharedWith of sharing ? [groupId, ...(sharing.get(groupId) ?? [])] : [groupId]) {
        for (const other of this.byGroupDay.get(`${sharedWith}|${day}`) ?? []) {
          if (!meets(other)) continue;
          const theirs = this.buffer.get(other.id);
          if (
            overlaps(
              pupilStart,
              pupilEnd,
              other.startMinutes - (theirs?.before ?? 0),
              other.endMinutes + (theirs?.after ?? 0),
            ) &&
            hit(other)
          ) {
            return way;
          }
        }
      }
    }
    // The weekly rows the clash rule reads: the lesson's teachers, room and classes.
    const groups = [lesson.studentGroupId, ...lesson.extraGroupIds];
    for (const row of this.data.constraints) {
      if (row.dayOfWeek !== day) continue;
      const resource =
        row.resourceType === 'TEACHER' && row.userId !== null && (row.userId === lesson.teacherId || row.userId === lesson.coTeacherId)
          ? 'TEACHER'
          : row.resourceType === 'ROOM' && lesson.roomId !== null && row.roomId === lesson.roomId
            ? 'ROOM'
            : row.resourceType === 'STUDENT_GROUP' && row.studentGroupId !== null && groups.includes(row.studentGroupId)
              ? 'GROUP'
              : null;
      if (resource !== null && overlaps(to.startMinutes, to.endMinutes, row.startMinutes, row.endMinutes)) {
        way.closures.push(resource);
        if (firstOnly) return way;
      }
    }
    return way;
  }

  /**
   * Whether two lessons, each at its own landing, hold the same teacher, room or class at once: `inTheWay`'s plain overlaps asked of
   * a PAIR instead of everything that stands (E5a, Gör plats: two units that both move must not land on each other, and the index
   * only knows where lessons stood). The pupils' own minutes before and after count, as there; the weekly rows are about one
   * landing and one resource, so they are not here. `swap-context.spec.ts` holds the two to the same answer for every pair.
   */
  landingsClash(a: Landing, b: Landing): boolean {
    if (a.lesson.id === b.lesson.id || a.to.dayOfWeek !== b.to.dayOfWeek) return false;
    const day = a.to.dayOfWeek;
    const closed = this.closedWeeks;
    if (!weeksMeet(a.lesson, b.lesson) || (closed !== null && meetOnlyInClosedWeeks(a.lesson, b.lesson, closed, day))) return false;
    const together = overlaps(a.to.startMinutes, a.to.endMinutes, b.to.startMinutes, b.to.endMinutes);
    const teachersOf = (lesson: SwapLesson) => [lesson.teacherId, lesson.coTeacherId].filter((id): id is string => id !== null);
    if (together) {
      const mine = teachersOf(a.lesson);
      if (teachersOf(b.lesson).some((id) => mine.includes(id))) return true;
      if (a.lesson.roomId !== null && a.lesson.roomId === b.lesson.roomId && !this.sharedRooms.has(a.lesson.roomId)) return true;
    }
    const own = this.buffer.get(a.lesson.id);
    const theirs = this.buffer.get(b.lesson.id);
    if (!overlaps(a.to.startMinutes - (own?.before ?? 0), a.to.endMinutes + (own?.after ?? 0), b.to.startMinutes - (theirs?.before ?? 0), b.to.endMinutes + (theirs?.after ?? 0))) {
      return false;
    }
    const sharing = this.sharing;
    const holdersOf = (lesson: SwapLesson) => new Set([lesson.studentGroupId, ...lesson.extraGroupIds]);
    const others = holdersOf(b.lesson);
    for (const groupId of holdersOf(a.lesson)) {
      for (const sharedWith of sharing ? [groupId, ...(sharing.get(groupId) ?? [])] : [groupId]) {
        if (others.has(sharedWith)) return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // The board's other hard kinds, as a verdict.
  // ---------------------------------------------------------------------------

  /**
   * The hard rule a landing breaks that the clash rule does not hold, or null.
   * Each is a rule the grid paints red and the generator keeps: FRAME
   * (frame-times.ts, the engine's frames.py), LUNCH (the class's sitting),
   * GRADE_RULE (a weekly row on whole årskurser) and OTHER_SCHOOL (a shared
   * teacher's lessons elsewhere, a room lent out or borrowed).
   */
  boardRefusal({ lesson, to }: Landing): Exclude<HardCode, 'CLASH'> | null {
    const groups = [lesson.studentGroupId, ...lesson.extraGroupIds];
    return (
      boardCodeOf(this.board, groups, to, { startDate: lesson.startDate, endDate: lesson.endDate }) ??
      (this.holdsAt(lesson, to).length > 0 ? 'OTHER_SCHOOL' : null)
    );
  }

  /** A room the school lets several lessons share while their pupils fit: the prune does not hold a lesson in it, the judge counts. */
  isSharedRoom(roomId: string): boolean {
    return this.sharedRooms.has(roomId);
  }

  /** The other schools, by name, whose hold on a lesson's teachers or room a landing sits inside (E3 names the closed stretch with them). */
  holdSchoolsAt({ lesson, to }: Landing): string[] {
    const schools = new Set<string>();
    for (const hold of this.holdsAt(lesson, to)) for (const school of hold.schools) schools.add(school);
    return [...schools].sort((a, b) => a.localeCompare(b, 'sv'));
  }

  /** The other schools' holds that a lesson at `to` would sit inside. */
  private holdsAt(lesson: SwapLesson, to: SwapSlot): OtherSchoolHold[] {
    const hits: OtherSchoolHold[] = [];
    const resources: Array<['TEACHER' | 'ROOM', string]> = [];
    for (const teacherId of [lesson.teacherId, lesson.coTeacherId]) if (teacherId !== null) resources.push(['TEACHER', teacherId]);
    if (lesson.roomId !== null) resources.push(['ROOM', lesson.roomId]);
    for (const [kind, id] of resources) {
      for (const hold of this.holdsByResource.get(`${kind}|${id}`) ?? []) {
        if (hold.dayOfWeek !== to.dayOfWeek) continue;
        if (overlaps(to.startMinutes, to.endMinutes, holdMinutes(hold.startTime), holdMinutes(hold.endTime))) hits.push(hold);
      }
    }
    return hits;
  }

  /**
   * The other schools' holds a proposal's lessons stand beside on their new
   * day: named, never moved. A shared teacher's lessons elsewhere and a room
   * lent or borrowed are the school's to know about when a lesson lands there.
   */
  externalTouches(moves: readonly SwapMove[]): ExternalTouch[] {
    const touches: ExternalTouch[] = [];
    for (const move of moves) {
      const lesson = this.lessonById.get(move.lessonId);
      if (!lesson) continue;
      const resources: Array<['TEACHER' | 'ROOM', string]> = [];
      for (const teacherId of [lesson.teacherId, lesson.coTeacherId]) if (teacherId !== null) resources.push(['TEACHER', teacherId]);
      if (lesson.roomId !== null) resources.push(['ROOM', lesson.roomId]);
      for (const [kind, id] of resources) {
        for (const hold of this.holdsByResource.get(`${kind}|${id}`) ?? []) {
          if (hold.dayOfWeek !== move.to.dayOfWeek) continue;
          touches.push({
            kind: hold.kind === 'TEACHER_BUSY' ? 'SHARED_TEACHER' : hold.kind,
            lessonId: lesson.id,
            resourceId: id,
            schools: hold.schools,
            dayOfWeek: hold.dayOfWeek,
            startMinutes: holdMinutes(hold.startTime),
            endMinutes: holdMinutes(hold.endTime),
          });
        }
      }
    }
    return touches;
  }

  /** The first board rule any of the moves breaks, or null. */
  boardVerdict(moves: readonly SwapMove[]): Exclude<HardCode, 'CLASH'> | null {
    for (const move of moves) {
      const lesson = this.lessonById.get(move.lessonId);
      if (!lesson) continue;
      const refusal = this.boardRefusal({ lesson, to: move.to });
      if (refusal !== null) return refusal;
    }
    return null;
  }
}

/** group -> the other groups holding at least one of its pupils, from the rosters the clash rule reads. */
function sharingOf(data: SwapData): Map<string, string[]> {
  const related = new Map<string, Set<string>>();
  for (const groups of data.rosters.groupsByStudent.values()) {
    if (groups.size < 2) continue;
    for (const a of groups) {
      let set = related.get(a);
      if (!set) related.set(a, (set = new Set()));
      for (const b of groups) if (a !== b) set.add(b);
    }
  }
  return new Map([...related].map(([group, others]) => [group, [...others]]));
}
