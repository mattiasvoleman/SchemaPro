// "Dela i halvklass" against the timplan: what a pupil of each half gets on
// each line the split touches, planned against the target, before anything
// is saved. Pure; the dialog (components/timplan/term-halves-dialog.tsx)
// hands in the year's plans and posts and the split it draws.
//
// NOTHING IS COMPUTED HERE THAT lib/timplan-planned.ts DOES NOT COMPUTE. That
// module is the gateway's layer-1 arithmetic (a mirror of
// src/common/timplan-planned.ts), and the figures below are its pupil figures:
// the split laid over the year's posts and handed to computePlannedCoverage
// with one pupil, who is in the class and in one half and in nothing else.
// Each half is asked on its own, so a line's pupil figure is that half's. A
// pupil in other teaching groups too (a språkval) is judged by the Täckning
// page as always; a split changes nothing for them on those lines.
//
// WHY. A half reads its subject in one period, so its pace has to rise
// (lib/half-class-periods.ts proposedLessons). With two subjects swapped the
// second is time on another line: hemkunskap swapped with slöjd gives each
// pupil slöjd in the half's other period, on top of the class's own slöjd
// post. The timplan counts both — per pupil and per line, a line being the
// school subject, the alternative SV_SVA / M2, or the parts of one national
// subject (Textilslöjd and Trä- och metallslöjd are Slöjd's SL; Biologi and
// Kemi are children of the ämnesgrupp NO) — so the
// dialog shows the lines, and proposes how far the class's own post in the
// other subject can
// come down with no half under its target (classPostReduction). The class's
// slöjd and the half's are one planning there, not double planned: the
// timplan reads the swap's shape, and the dialog says double planning only
// where the timplan will.

import {
  computePlannedCoverage,
  nationalTopOf,
  type PlannedCoverage,
  type PlannedLine,
  type PlannedPlan,
  type PlannedRequirement,
} from "@/lib/timplan-planned";
import type { GradeNumbering } from "@/lib/grade-numbering";
import { isMixed, lessonCountOf, longestLessonOf, type LessonShape } from "@/lib/lesson-lengths";
import type { ClosedRange, TeachingPeriod, YearBounds } from "@/lib/teaching-hours";
import type { PlannedRow, UniformLessons } from "@/lib/half-class-periods";

/** What the year holds that the timplan reads, as the matrix's Mål mode has it. */
export interface HalvesTimplanSources {
  year: YearBounds & { gradeNumbering?: GradeNumbering };
  closures: ClosedRange[];
  plans: PlannedPlan[];
  attachments: { gradeLevel: number; localTimplanId: string }[];
  subjects: readonly {
    id: string;
    name: string;
    nationalCode?: string | null;
    /** The ämnesgrupp of the code (BI → NO), where the subject has one: withParentCodes. */
    parentCode?: string | null;
    countsTowardTimplan?: boolean;
  }[];
}

/** A stored post, as far as the timplan reads it. */
export type StoredPost = LessonShape &
  TeachingPeriod & { id: string; studentGroupId: string; subjectId: string; blockId?: string | null };

/** The split the dialog draws. */
export interface HalvesSplit {
  theClass: { id: string; name: string; gradeLevel: number | null };
  /** The first half first: its ids, or stand-ins for halves the split makes. */
  halves: readonly [{ id: string; name: string }, { id: string; name: string }];
  /** The year's posts as stored; the class's and its halves' are read. */
  posts: readonly StoredPost[];
  /** The class's post the split replaces. */
  sourceId: string;
  /** The posts the split writes (plannedRows). */
  rows: readonly PlannedRow[];
  /** The subjects the rows read, by `subject`: one, or the swap's two. */
  subjectIds: readonly string[];
  /** A class post written with another week in the same save, or null. */
  adjusted?: { requirementId: string; week: UniformLessons } | null;
}

/** One line as a pupil of one half reads it. */
export interface HalfLine {
  /** The timplan's line ('subject:<id>', 'alt:<code>' or 'national:<code>'); null for a subject it does not count. */
  key: string | null;
  subjectIds: string[];
  /** The plan's minutes for the line in the class's årskurs; null for none. */
  target: number | null;
  /** The pupil's standardvecka minutes on the line, whole, as the timplan rounds them; null without a target. */
  planned: number | null;
  /**
   * The groups the line reaches the pupil from when the timplan calls it
   * TIMPLAN_PUPIL_DOUBLE_PLANNED, which the Täckning page lists; empty
   * otherwise. Never for the swap itself (the class's slöjd and the half's
   * slöjd in the term it reads no hemkunskap are one planning), but for a
   * class that keeps another post in the subject the split takes off it.
   */
  doubleFrom: string[];
}

export type HalvesTimplan =
  | { kind: "noGrade" }
  | { kind: "noPlan"; gradeLevel: number }
  | {
      kind: "lines";
      gradeLevel: number;
      /** Per half, one line per subject the split touches: the post's, then the chosen ones. */
      halves: [HalfLine[], HalfLine[]];
    };

/** The one pupil each half is asked about. */
const PUPIL = "half-pupil";

function plannedPost(id: string, studentGroupId: string, subjectId: string, week: LessonShape, period: TeachingPeriod): PlannedRequirement {
  return {
    id,
    studentGroupId,
    subjectId,
    lessonsPerWeek: week.lessonsPerWeek,
    minutesPerLesson: week.minutesPerLesson,
    // As Mål mode hands a post in (requirements-target.ts toPlannedRequirement).
    ...(isMixed(week) ? { lessonLengths: [...(week.lessonLengths ?? [])] } : {}),
    recurrence: period.recurrence ?? "ALL_WEEKS",
    startDate: period.startDate ?? null,
    endDate: period.endDate ?? null,
  };
}

/** The timplan's layer 1 for the class, its halves and one pupil of half `half`. */
function coverageOf(sources: HalvesTimplanSources, split: HalvesSplit, half: 0 | 1): PlannedCoverage {
  const { theClass, halves } = split;
  const groupIds = new Set([theClass.id, ...halves.map((group) => group.id)]);
  const posts: PlannedRequirement[] = [];
  for (const post of split.posts) {
    if (post.id === split.sourceId || !groupIds.has(post.studentGroupId)) continue;
    const adjusted = split.adjusted?.requirementId === post.id ? split.adjusted.week : null;
    const week = adjusted
      ? { lessonsPerWeek: adjusted.count, minutesPerLesson: adjusted.minutes, lessonLengths: [] }
      : post;
    posts.push(plannedPost(post.id, post.studentGroupId, post.subjectId, week, post));
  }
  split.rows.forEach((row, index) => {
    const subjectId = split.subjectIds[row.subject];
    if (subjectId) posts.push(plannedPost(`split-${index}`, halves[row.half].id, subjectId, row, row));
  });
  const { gradeNumbering, ...year } = sources.year;
  return computePlannedCoverage({
    year: { startDate: year.startDate, endDate: year.endDate },
    ...(gradeNumbering ? { gradeNumbering } : {}),
    closures: sources.closures,
    plans: sources.plans,
    attachments: sources.attachments,
    subjects: sources.subjects.map((subject) => ({
      id: subject.id,
      name: subject.name,
      nationalCode: subject.nationalCode ?? null,
      ...(subject.parentCode ? { parentCode: subject.parentCode } : {}),
      countsTowardTimplan: subject.countsTowardTimplan ?? true,
    })),
    groups: [
      { id: theClass.id, name: theClass.name, kind: "CLASS", gradeLevel: theClass.gradeLevel },
      ...halves.map((group) => ({
        id: group.id,
        name: group.name,
        kind: "TEACHING_GROUP" as const,
        gradeLevel: theClass.gradeLevel,
        halfOfId: theClass.id,
      })),
    ],
    requirements: posts,
    pupils: [{ id: PUPIL, homeGroupId: theClass.id, groupIds: [halves[half].id] }],
    includePupils: true,
  });
}

/**
 * Whether `subjectId` is on the class's `line` by its code: a part of the same
 * national subject. The class's line lists the subjects of its own posts and
 * of the plan's entries, so a part only the halves read (textilslöjd beside a
 * Slöjd entry, kemi beside a NO entry) is on it by the line's nationalCode,
 * which is the part's own code (a child the plan names) or its ämnesgrupp's.
 */
function onLine(line: PlannedLine, subjectId: string, codes: ReadonlyMap<string, readonly string[]>): boolean {
  return line.nationalCode !== undefined && (codes.get(subjectId) ?? []).includes(line.nationalCode);
}

/** The lines `subjectIds` are on, as one pupil reads them in a coverage of one pupil. */
function linesOf(
  coverage: PlannedCoverage,
  classId: string,
  subjectIds: readonly string[],
  codes: ReadonlyMap<string, readonly string[]>,
): HalfLine[] {
  const summary = coverage.groups.find((group) => group.studentGroupId === classId);
  const doubles = coverage.verdicts.filter((verdict) => verdict.code === "TIMPLAN_PUPIL_DOUBLE_PLANNED");
  const lines: HalfLine[] = [];
  for (const subjectId of subjectIds) {
    // The line that lists the subject first: a child the plan names is on its
    // own, beside the group's line its code would also reach.
    const line =
      summary?.lines.find((candidate) => candidate.subjectIds.includes(subjectId)) ??
      summary?.lines.find((candidate) => onLine(candidate, subjectId, codes));
    const seen = line ? lines.find((entry) => entry.key === line.key) : undefined;
    if (line && seen) {
      // A second part of a national line the split touches is named on the
      // line it shares, not drawn as a second line.
      if (line.nationalCode !== undefined && !seen.subjectIds.includes(subjectId)) seen.subjectIds.push(subjectId);
      continue;
    }
    if (!line) {
      // No target and no class minutes on it (or a subject the timplan does
      // not count): the timplan has nothing to judge the line against.
      lines.push({ key: null, subjectIds: [subjectId], target: null, planned: null, doubleFrom: [] });
      continue;
    }
    const doubleFrom = [
      ...new Set(
        doubles
          .filter((verdict) => verdict.subjectIds?.some((id) => line.subjectIds.includes(id)))
          .flatMap((verdict) => verdict.studentGroupIds ?? []),
      ),
    ];
    lines.push({
      key: line.key,
      // A part the class has no post or entry in is named after the line's own subjects.
      subjectIds:
        line.nationalCode !== undefined && !line.subjectIds.includes(subjectId)
          ? [...line.subjectIds, subjectId]
          : [...line.subjectIds],
      target: line.targetMinutesPerWeek,
      planned: line.targetMinutesPerWeek === null ? null : (line.pupils?.min ?? null),
      doubleFrom,
    });
  }
  return lines;
}

/**
 * The national codes each subject the timplan counts can be on a line under —
 * its own and its ämnesgrupp's — to find the parts of one national subject.
 */
const codesOf = (sources: HalvesTimplanSources): Map<string, readonly string[]> =>
  new Map(
    sources.subjects
      .filter((subject) => subject.countsTowardTimplan !== false)
      .map((subject) => {
        const own = subject.nationalCode ?? null;
        const top = nationalTopOf({ nationalCode: own, parentCode: subject.parentCode });
        return [subject.id, [...new Set([own, top].filter((code): code is string => code !== null))]];
      }),
  );

/**
 * Each half's lines: the post's subject's first, then each chosen subject's,
 * each line once. "noGrade" for a class with no årskurs, "noPlan" for an
 * årskurs the year attaches no plan to: there is no target to read.
 */
export function halvesTimplan(sources: HalvesTimplanSources, split: HalvesSplit, postSubjectId: string): HalvesTimplan {
  const grade = split.theClass.gradeLevel;
  if (grade === null) return { kind: "noGrade" };
  const subjectIds = [postSubjectId, ...split.subjectIds.filter((id) => id !== postSubjectId)];
  const coverages = ([0, 1] as const).map((half) => coverageOf(sources, split, half));
  if (coverages[0]!.groups.every((group) => group.localTimplanId === null)) return { kind: "noPlan", gradeLevel: grade };
  return {
    kind: "lines",
    gradeLevel: grade,
    halves: coverages.map((coverage) => linesOf(coverage, split.theClass.id, subjectIds, codesOf(sources))) as [
      HalfLine[],
      HalfLine[],
    ],
  };
}

/**
 * Whether the timplan draws a child of an ämnesgrupp on a line of its own
 * because the plan names it (Kemi 60), and not on its group's (NO). False for
 * any other subject, and while there are no lines to read.
 */
export function childOnOwnLine(
  timplan: HalvesTimplan | null,
  subject: { id: string; nationalCode?: string | null; parentCode?: string | null },
): boolean {
  if (timplan?.kind !== "lines" || !subject.nationalCode || !subject.parentCode) return false;
  const line = timplan.halves[0].find((candidate) => candidate.subjectIds.includes(subject.id));
  return line?.key != null && line.key !== `national:${subject.parentCode}`;
}

/** What the class's own post in the swap's other subject can come down to. */
export interface PostReduction {
  requirementId: string;
  /** The post as stored. */
  from: UniformLessons;
  /** The least week that keeps every half at its target. */
  to: UniformLessons;
  /** The line's target, and what a pupil of each half gets on it with `to`. */
  target: number;
  planned: [number, number];
  /**
   * The class's own line with `to`, as Mål and Täckning judge the class
   * until at least half its pupils are in the halves (the timplan's PUPILS
   * rule): under the target, since the swap's minutes are the halves'.
   */
  classPlanned: number;
  /** The post is in a parallel block, whose posts change together (TB409). */
  inBlock: boolean;
}

/**
 * The class's own post in `otherSubjectId` — the swap's subject that is not
 * the post's line, slöjd for a hemkunskap post — brought down as far as it
 * goes with no half under the line's target: the same lessons shorter, on the
 * 5-minute grid, or fewer lessons of its length, whichever leaves the fewest
 * minutes (a tie keeps the lessons). Each candidate is judged by the timplan
 * itself, a pupil of each half (halvesTimplan).
 *
 * Null when there is nothing to propose: no such post, one with lessons of
 * more than one length (the admin changes those in the post's dialog), no
 * target on the line, or no shorter week that keeps both halves at it.
 */
export function classPostReduction(
  sources: HalvesTimplanSources,
  split: HalvesSplit,
  otherSubjectId: string,
): PostReduction | null {
  const post = split.posts.find(
    (candidate) =>
      candidate.studentGroupId === split.theClass.id && candidate.subjectId === otherSubjectId && candidate.id !== split.sourceId,
  );
  if (!post || isMixed(post) || split.theClass.gradeLevel === null) return null;
  const from = { count: lessonCountOf(post), minutes: longestLessonOf(post) };
  const coveragesOf = (week: UniformLessons | null) => {
    const asked = { ...split, adjusted: week ? { requirementId: post.id, week } : null };
    return ([0, 1] as const).map((half) => coverageOf(sources, asked, half));
  };
  const codes = codesOf(sources);
  const judged = (week: UniformLessons | null) =>
    coveragesOf(week).map((coverage) => linesOf(coverage, split.theClass.id, [otherSubjectId], codes)[0]!);
  const now = judged(null);
  const target = now[0]!.target;
  if (target === null || target <= 0) return null;
  if (now.some((line) => line.planned === null || line.planned <= target)) return null;
  // Every week below the post's, fewest minutes first; at equal minutes the
  // one with the post's lessons.
  const candidates: UniformLessons[] = [];
  for (let minutes = from.minutes - 5; minutes >= 15; minutes -= 5) candidates.push({ count: from.count, minutes });
  for (let count = from.count - 1; count >= 1; count -= 1) candidates.push({ count, minutes: from.minutes });
  candidates.sort(
    (a, b) => a.count * a.minutes - b.count * b.minutes || Number(b.count === from.count) - Number(a.count === from.count),
  );
  for (const week of candidates) {
    const coverages = coveragesOf(week);
    const lines = coverages.map((coverage) => linesOf(coverage, split.theClass.id, [otherSubjectId], codes)[0]!);
    if (lines.every((line) => line.planned !== null && line.planned >= target)) {
      const classLine = coverages[0]!.groups
        .find((group) => group.studentGroupId === split.theClass.id)
        ?.lines.find((line) => line.subjectIds.includes(otherSubjectId));
      return {
        requirementId: post.id,
        from,
        to: week,
        target,
        planned: [lines[0]!.planned!, lines[1]!.planned!],
        classPlanned: classLine?.plannedMinutesPerWeek ?? 0,
        inBlock: (post.blockId ?? null) !== null,
      };
    }
  }
  return null;
}
