import { sortByName } from "@/lib/sorting";
import type { SubjectLoad, TeacherLoad, TeacherLoadReport } from "@/lib/teacher-load";

/*
 * What the staffing matrix shows, decided outside React so it can be tested
 * as arithmetic and reused by the drawer and the requirements dialog.
 *
 * Nothing here recomputes a load. The report is the gateway's answer (or the
 * mirror's, in a test), and these functions only choose which of its numbers
 * a cell prints and how a bar is cut. The one figure invented here is the
 * bar's SCALE — see loadBarSegments.
 */

export type WeekView = "standard" | "peak";
export type UnitView = "minutes" | "percent";

/**
 * The subject columns, in the order of the label they carry.
 *
 * Only subjects somebody actually teaches: a school's twenty subjects would
 * otherwise draw twenty mostly-empty columns on a matrix whose point is which
 * cells are filled. Sorted by code, as the timplan's header is — the eye
 * reads codes, and a header sorted by name while showing codes reads as no
 * order at all (see admin/requirements).
 */
export function matrixColumns(
  report: Pick<TeacherLoadReport, "teachers">,
  subjects: { id: string; name: string; code: string | null }[],
): { id: string; name: string; code: string | null }[] {
  const taught = new Set<string>();
  for (const teacher of report.teachers) {
    for (const subject of teacher.subjects) taught.add(subject.subjectId);
  }
  const known = new Map(subjects.map((subject) => [subject.id, subject]));
  const columns = [...taught].map(
    (id) =>
      known.get(id) ?? {
        id,
        // A subject the subjects query cannot name yet (deleted, or not loaded)
        // keeps its column under the name the report carried.
        name: report.teachers.flatMap((t) => t.subjects).find((s) => s.subjectId === id)!
          .subjectName,
        code: null,
      },
  );
  return sortByName(columns, (subject) => subject.code ?? subject.name);
}

/** One decimal, decimal comma, no trailing ",0": "53,3", "80". */
export function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1).replace(".", ",");
}

/**
 * What a cell prints: standardvecka minutes in the subject, or the SCB share
 * of the post. Null for an empty cell, and null (not "0") for the percent view
 * of a teacher without a post — the figure has no denominator there.
 */
export function cellValue(
  teacher: Pick<TeacherLoad, "subjects">,
  subjectId: string,
  unit: UnitView,
): { subject: SubjectLoad; text: string } | null {
  const subject = teacher.subjects.find((entry) => entry.subjectId === subjectId);
  if (!subject) return null;
  if (unit === "minutes") return { subject, text: String(subject.minutesPerWeek) };
  if (subject.percentOfEmployment === null) return null;
  return { subject, text: `${formatPercent(subject.percentOfEmployment)} %` };
}

/** The groups a teacher carries in one subject, for the cell's tooltip. */
export function groupsInSubject(
  requirements: {
    subjectId: string;
    studentGroupId: string;
    teacherId: string | null;
    coTeacherId: string | null;
  }[],
  userId: string,
  subjectId: string,
  groupName: (groupId: string) => string,
): string[] {
  const names = new Set<string>();
  for (const requirement of requirements) {
    if (requirement.subjectId !== subjectId) continue;
    if (requirement.teacherId !== userId && requirement.coTeacherId !== userId) continue;
    names.add(groupName(requirement.studentGroupId));
  }
  return [...names].sort((a, b) => a.localeCompare(b, "sv"));
}

export interface LoadBarSegments {
  /** Share of the bar's width, 0..1 each; the three sum to 1 (or to the teaching share alone). */
  teaching: number;
  remaining: number;
  over: number;
  /** Minutes behind each segment, for the label. */
  teachingMinutes: number;
  remainingMinutes: number;
  overMinutes: number;
}

/**
 * The Lectio-style bar: undervisning, kvar till mål, över mål.
 *
 * The bar's full width is max(target, assigned), so a teacher at 110 % shows
 * a bar whose last tenth is red rather than a bar that overflows its cell —
 * and two teachers' bars are NOT on the same scale. That is deliberate: the
 * matrix compares each teacher with their own target (an 80 % post fills at
 * 865 minutes, a full one at 1 080), and a shared scale would make every
 * part-timer look under-used. The number beside the bar is what compares
 * across rows.
 *
 * Without a target there is nothing to be short of or over, so the bar is
 * teaching alone at full width; the label says "inget riktmärke" rather than
 * a percentage of nothing.
 */
export function loadBarSegments(
  teacher: Pick<TeacherLoad, "assignedMinutesPerWeek" | "targetMinutesPerWeek">,
  week: WeekView = "standard",
  peakMinutes = teacher.assignedMinutesPerWeek,
): LoadBarSegments {
  const assigned = week === "peak" ? peakMinutes : teacher.assignedMinutesPerWeek;
  const target = teacher.targetMinutesPerWeek;
  if (target === null || target <= 0) {
    return {
      teaching: assigned > 0 ? 1 : 0,
      remaining: 0,
      over: 0,
      teachingMinutes: assigned,
      remainingMinutes: 0,
      overMinutes: Math.max(0, target === 0 ? assigned : 0),
    };
  }
  const scale = Math.max(target, assigned);
  const teachingMinutes = Math.min(assigned, target);
  const remainingMinutes = Math.max(0, target - assigned);
  const overMinutes = Math.max(0, assigned - target);
  return {
    teaching: teachingMinutes / scale,
    remaining: remainingMinutes / scale,
    over: overMinutes / scale,
    teachingMinutes,
    remainingMinutes,
    overMinutes,
  };
}

/** The three KPI figures above the matrix. */
export function kpis(report: TeacherLoadReport): {
  unstaffed: number;
  unqualified: number | null;
  overTarget: number;
} {
  return {
    unstaffed: report.unstaffedRequirements.length,
    // Null, not 0, when nothing was checked: an empty list from a school with
    // no behörighet rows must not read as "everybody is qualified".
    unqualified: report.qualificationsRecorded ? report.unqualifiedAssignments.length : null,
    overTarget: report.teachers.filter((teacher) => teacher.status === "OVER").length,
  };
}
