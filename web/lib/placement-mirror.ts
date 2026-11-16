import {
  buildGroupConflictMap,
  pupilBufferOf,
  validatePlacement,
  type ConflictHit,
  type GroupConflictMap,
  type LunchOf,
  type Meal,
  type Placement,
  type PupilBufferMap,
} from "@/lib/conflicts";
import type { FrameTime } from "@/lib/frame-times";
import { buildGradeSpans, type GradeSpan } from "@/lib/grade-span";
import type { GradeNumbering } from "@/lib/grade-numbering";
import {
  keptCardId,
  placementCardId,
  teacherOfPlacement,
  type BoardKept,
  type BoardPlacement,
  type BoardPost,
  type PlacementBoard,
} from "@/lib/placement-board";
import type { PlacementRefusalReason } from "@/lib/requirement-placements";
import type { AvailabilityConstraint, StudentGroup } from "@/lib/types";
import { timeToMinutes } from "@/lib/utils";

/*
 * THE MIRROR OF THE JUDGE, for the ghost under a drag and for the arrow keys.
 *
 * The gateway judges a förläggning (placement-judge.ts) and the page cannot ask it
 * at every pixel of a drag, so the ghost is drawn from the week's own facts with the
 * grundschema's mirror of the clash rule (lib/conflicts.ts validatePlacement,
 * unchanged): the lessons Generera keeps and the other förläggningar, recounted as
 * its `Placement`, held against the school's constraints, ramtider, grade rules
 * and the meals placed by hand.
 *
 * IT IS NOT THE JUDGE (planens risk 7). It lacks other schools' bookings, the
 * post's demand (OVER_DEMAND) and the names of the pupils a kept lesson was opened
 * to (the week names none), so it can be MILDER there, and the gateway answers at
 * the drop and its sentence is the one shown. For the rules it has (TEACHER, ROOM,
 * GROUP, AVAILABILITY, FRAME, LUNCH, GRADE_RULE) it must never be milder than the
 * judge: where the judge refuses, the mirror refuses. The fixture
 * src/requirement-placements/__fixtures__/placement-clash-cases.json holds both to
 * that (placement-mirror.contract.test.ts here, the adapter probe there).
 *
 * THE PUPILS' MINUTES. Ombyte before and dusch after an idrott hold the class's other lessons out of the minutes around it
 * (the gateway's findConflicts, pupilBuffersOf), so every lesson here carries its (class, subject)'s buffer from the posts
 * of the week (`buffers`), the lesson being placed as well. Left out, the mirror gave "free" a quarter of an hour the judge
 * refused (review of #326, MEDEL-3).
 *
 * NO ROOM, NO ROOM CLASH. A förläggning with no room (the engine chooses it) has
 * roomId null, which validatePlacement does not hold against any room, as the judge
 * does not.
 *
 * Pure: the lists come in, `Placement`s and hits go out.
 */

/** What the mirror is built from: the week and the school's lists. A list that has not arrived is left out and is then not checked. */
export interface MirrorFacts {
  board: PlacementBoard;
  /** Row id → its key (placement-rows.ts keyByRowId): a row's `Placement` is named by it, so that a row moved or re-saved is still the one. */
  keys: ReadonlyMap<string, string>;
  /** The year's groups, for the pupils' groups in common (halves, replacing groups) and the grade spans. */
  groups: readonly StudentGroup[];
  /** Pupil → home class. */
  studentGroupOf: Map<string, string | null>;
  /** Pupil → teaching group, as the groups page reads them. */
  memberships: ReadonlyArray<{ studentId: string; studentGroupId: string }>;
  constraints: readonly AvailabilityConstraint[] | undefined;
  frames: readonly FrameTime[] | undefined;
  numbering?: GradeNumbering | undefined;
  /** The year the groups belong to, so that another year's groups lend no grade. */
  academicYearId?: string | undefined;
}

export interface MirrorContext {
  /** The lessons Generera keeps and the förläggningar, as the clash rule reads them. */
  others: Placement[];
  constraints: AvailabilityConstraint[];
  studentGroupOf: Map<string, string | null>;
  groupConflicts: GroupConflictMap;
  gradeSpanOf: Map<string, GradeSpan>;
  frames: FrameTime[] | undefined;
  lunchOf: LunchOf;
  /** (class, subject) → the pupils' minutes before and after its lessons; empty at nearly every school. */
  buffers: PupilBufferMap;
}

/**
 * The buffers of the week's posts, per (class, subject) as the gateway reads them. Where two posts of a class and subject say
 * different numbers the gateway keeps one of them (which one is not told); the widest here, so that the mirror is never milder.
 */
export function bufferMapOfBoard(posts: readonly Pick<BoardPost, "studentGroupId" | "subjectId" | "minutesBefore" | "minutesAfter">[]): PupilBufferMap {
  const map: PupilBufferMap = new Map();
  for (const post of posts) {
    const minutesBefore = post.minutesBefore ?? 0;
    const minutesAfter = post.minutesAfter ?? 0;
    if (minutesBefore === 0 && minutesAfter === 0) continue;
    const key = `${post.studentGroupId}:${post.subjectId}`;
    const known = map.get(key);
    map.set(key, known ? { minutesBefore: Math.max(known.minutesBefore, minutesBefore), minutesAfter: Math.max(known.minutesAfter, minutesAfter) } : { minutesBefore, minutesAfter });
  }
  return map;
}

/** The meals the school placed by hand, by `group:weekday`: the only meals a row is held to. */
export function lunchOfBoard(meals: PlacementBoard["meals"]): LunchOf {
  const held = new Map<string, Meal[]>();
  for (const meal of meals) {
    const key = `${meal.studentGroupId}:${meal.dayOfWeek}`;
    const entry: Meal = {
      startMinutes: timeToMinutes(meal.startTime),
      endMinutes: timeToMinutes(meal.endTime),
      startDate: meal.startDate,
      endDate: meal.endDate,
    };
    const list = held.get(key);
    if (list) list.push(entry);
    else held.set(key, [entry]);
  }
  return held;
}

/** A förläggning as a `Placement`: its post's class, subject, teachers and weeks, its own day, time and room. */
export function placementOfRow(row: BoardPlacement, post: BoardPost | undefined, id: string, buffers?: PupilBufferMap): Placement {
  const buffer = post ? pupilBufferOf(buffers, { studentGroupId: post.studentGroupId, subjectId: post.subjectId }) : undefined;
  return {
    ...(buffer ?? {}),
    id,
    dayOfWeek: row.dayOfWeek,
    startMinutes: timeToMinutes(row.startTime),
    endMinutes: timeToMinutes(row.endTime),
    teacherId: teacherOfPlacement(row, post),
    coTeacherId: post?.coTeacherId ?? null,
    roomId: row.roomId,
    studentGroupId: post?.studentGroupId ?? "",
    ...(post ? { subjectId: post.subjectId } : {}),
    recurrence: row.recurrence,
    startDate: post?.startDate ?? null,
    endDate: post?.endDate ?? null,
  };
}

/** A lesson Generera keeps as a `Placement`. The week names no pupil it was opened to, so none is held against (the gateway does). */
export function placementOfKept(lesson: BoardKept, buffers?: PupilBufferMap): Placement {
  // A lesson opened to a second class carries the widest of the classes' rows, as the gateway reads it.
  const buffer = pupilBufferOf(buffers, lesson);
  return {
    ...(buffer ?? {}),
    id: keptCardId(lesson.id),
    dayOfWeek: lesson.dayOfWeek,
    startMinutes: timeToMinutes(lesson.startTime),
    endMinutes: timeToMinutes(lesson.endTime),
    teacherId: lesson.teacherId,
    coTeacherId: lesson.coTeacherId,
    roomId: lesson.roomId,
    studentGroupId: lesson.studentGroupId,
    subjectId: lesson.subjectId,
    extraGroupIds: lesson.extraGroupIds,
    recurrence: lesson.recurrence,
    startDate: lesson.startDate,
    endDate: lesson.endDate,
  };
}

/** Builds what the check is made against; called when the week or a list changes, not per pixel of a drag. */
export function buildMirror(facts: MirrorFacts): MirrorContext {
  const postById = new Map(facts.board.posts.map((post) => [post.id, post]));
  const groups = facts.academicYearId ? facts.groups.filter((group) => group.academicYearId === facts.academicYearId) : [...facts.groups];
  const membersByGroup = new Map<string, string[]>();
  for (const row of facts.memberships) {
    const list = membersByGroup.get(row.studentGroupId);
    if (list) list.push(row.studentId);
    else membersByGroup.set(row.studentGroupId, [row.studentId]);
  }
  const buffers = bufferMapOfBoard(facts.board.posts);
  return {
    others: [
      ...facts.board.kept.map((lesson) => placementOfKept(lesson, buffers)),
      ...facts.board.placements.map((row) => placementOfRow(row, postById.get(row.requirementId), placementCardId(facts.keys.get(row.id) ?? row.id), buffers)),
    ],
    buffers,
    constraints: [...(facts.constraints ?? [])],
    studentGroupOf: facts.studentGroupOf,
    groupConflicts: buildGroupConflictMap(facts.studentGroupOf, [...facts.memberships], groups),
    gradeSpanOf: buildGradeSpans({ groups, membersByGroup, homeClassOf: facts.studentGroupOf, numbering: facts.numbering }),
    frames: facts.frames ? [...facts.frames] : undefined,
    lunchOf: lunchOfBoard(facts.board.meals),
  };
}

/** The hits the grundschema's clash rule gives a lesson at this place, none when the week holds it. `candidate.id` is skipped among the others, so a lesson moved does not clash with where it was. */
export function mirrorHits(context: MirrorContext, candidate: Placement): ConflictHit[] {
  return validatePlacement(
    candidate,
    context.others,
    context.constraints,
    context.studentGroupOf,
    context.groupConflicts,
    context.gradeSpanOf,
    context.frames,
    context.lunchOf,
  );
}

/** A hit's kind as the judge's reason: the grade rules read as AVAILABILITY in the mirror (one rule in the constraints) and as GRADE_RULE in the judge. */
export const REASON_OF_HIT: Readonly<Record<ConflictHit["kind"], PlacementRefusalReason | null>> = {
  TEACHER: "TEACHER",
  ROOM: "ROOM",
  GROUP: "GROUP",
  AVAILABILITY: "AVAILABILITY",
  FRAME: "FRAME",
  LUNCH: "LUNCH",
  // The school's room lock is not a rule of a förläggning's judge (it holds no subject room locks); not asked.
  ROOM_LOCK: null,
};
