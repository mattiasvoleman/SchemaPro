import { toNioarigSpan } from '../common/grade-numbering';
import { hasDistributionRule } from '../common/subject-distribution';
import { pupilCohortsOf, lockMarginOf } from '../optimization/pupil-cohorts';
import { gradeSpanOf } from '../optimization/room-eligibility';
import type { OtherSchoolHold } from '../optimization/other-school-holds';
import { frameWindow, type GapConstraint, type GapSpan } from './swap-gaps';
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
  private readonly sittings = new Map<string, SwapData['sittings'][number][]>();
  private readonly holdsByResource = new Map<string, OtherSchoolHold[]>();
  private readonly gapConstraints: GapConstraint[];

  constructor(readonly data: SwapData) {
    this.lessonById = new Map(data.lessons.map((lesson) => [lesson.id, lesson]));

    // Pupil buffers per (group, subject), then the widest over a lesson's groups.
    const buffers = new Map<string, { before: number; after: number }>();
    for (const post of data.posts) {
      if (post.minutesBefore === 0 && post.minutesAfter === 0) continue;
      buffers.set(`${post.studentGroupId}:${post.subjectId}`, { before: post.minutesBefore, after: post.minutesAfter });
    }
    for (const lesson of data.lessons) {
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
    for (const sitting of data.sittings) {
      const key = `${sitting.studentGroupId}|${sitting.dayOfWeek}`;
      const list = this.sittings.get(key);
      if (list) list.push(sitting);
      else this.sittings.set(key, [sitting]);
    }
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

    // Units: what the school laid beside what.
    const blockOfPost = new Map(data.posts.map((post) => [`${post.studentGroupId}:${post.subjectId}`, post.blockId]));
    const sameTimes = new Map(data.blocks.map((block) => [block.id, block.sameTimesAsBlockId]));
    const groupFacts = new Map(
      data.groups.map((group) => [group.id, { halfOfId: group.halfOfId, replacesSubjectId: group.replacesSubjectId }]),
    );
    this.unitOf = buildUnits(data.lessons, {
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

    this.soft = this.softMeasure();
  }

  /** The cohorts, the margins and the rules behind the figures (swap-soft.ts). */
  private softMeasure(): SoftMeasure {
    const { data } = this;
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
      locks: data.lessons.map((lesson) => ({
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
    for (const lesson of data.lessons) {
      const margin = lockMarginOf(rows, {
        groupIds: [lesson.studentGroupId, ...lesson.extraGroupIds],
        subjectId: lesson.subjectId,
      });
      if (margin) margins.set(lesson.id, { before: margin.minutesBefore, after: margin.minutesAfter });
    }
    return buildSoftMeasure({
      lessons: data.lessons,
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

  private freeOfLessons({ lesson, to }: Landing, vacating: ReadonlySet<string>): boolean {
    const day = to.dayOfWeek;
    const meets = (other: SwapLesson) => !vacating.has(other.id) && other.id !== lesson.id && weeksMeet(lesson, other);
    for (const teacherId of [lesson.teacherId, lesson.coTeacherId]) {
      if (teacherId === null) continue;
      for (const other of this.byTeacherDay.get(`${teacherId}|${day}`) ?? []) {
        if (meets(other) && overlaps(to.startMinutes, to.endMinutes, other.startMinutes, other.endMinutes)) return false;
      }
    }
    if (lesson.roomId !== null) {
      for (const other of this.byRoomDay.get(`${lesson.roomId}|${day}`) ?? []) {
        if (meets(other) && overlaps(to.startMinutes, to.endMinutes, other.startMinutes, other.endMinutes)) return false;
      }
    }
    const own = this.buffer.get(lesson.id);
    const pupilStart = to.startMinutes - (own?.before ?? 0);
    const pupilEnd = to.endMinutes + (own?.after ?? 0);
    for (const groupId of [lesson.studentGroupId, ...lesson.extraGroupIds]) {
      for (const other of this.byGroupDay.get(`${groupId}|${day}`) ?? []) {
        if (!meets(other)) continue;
        const theirs = this.buffer.get(other.id);
        if (
          overlaps(
            pupilStart,
            pupilEnd,
            other.startMinutes - (theirs?.before ?? 0),
            other.endMinutes + (theirs?.after ?? 0),
          )
        ) {
          return false;
        }
      }
    }
    // The weekly rows the clash rule reads: the lesson's teachers, room and classes.
    const groups = [lesson.studentGroupId, ...lesson.extraGroupIds];
    for (const row of this.data.constraints) {
      if (row.dayOfWeek !== day) continue;
      const applies =
        (row.resourceType === 'TEACHER' && row.userId !== null && (row.userId === lesson.teacherId || row.userId === lesson.coTeacherId)) ||
        (row.resourceType === 'ROOM' && lesson.roomId !== null && row.roomId === lesson.roomId) ||
        (row.resourceType === 'STUDENT_GROUP' && row.studentGroupId !== null && groups.includes(row.studentGroupId));
      if (applies && overlaps(to.startMinutes, to.endMinutes, row.startMinutes, row.endMinutes)) return false;
    }
    return true;
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
    const day = to.dayOfWeek;
    // FRAME: any group outside its stage's day is enough (breaksFrame).
    if (this.data.frames.length > 0) {
      for (const groupId of groups) {
        const span = this.spans.get(groupId);
        if (!span) continue;
        const window = frameWindow(this.data.frames, span, day);
        if (window === null || to.startMinutes < window[0] || to.endMinutes > window[1]) return 'FRAME';
      }
    }
    for (const groupId of groups) {
      for (const sitting of this.sittings.get(`${groupId}|${day}`) ?? []) {
        if (overlaps(to.startMinutes, to.endMinutes, sitting.startMinutes, sitting.endMinutes)) return 'LUNCH';
      }
    }
    for (const row of this.data.constraints) {
      if (row.resourceType !== 'GRADE_LEVEL' || row.dayOfWeek !== day) continue;
      const meets = groups.some((groupId) => {
        const span = this.spans.get(groupId);
        if (!span) return false;
        if (row.minGradeLevel !== null && span[1] < row.minGradeLevel) return false;
        return !(row.maxGradeLevel !== null && span[0] > row.maxGradeLevel);
      });
      if (meets && overlaps(to.startMinutes, to.endMinutes, row.startMinutes, row.endMinutes)) return 'GRADE_RULE';
    }
    return this.holdsAt(lesson, to).length > 0 ? 'OTHER_SCHOOL' : null;
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
