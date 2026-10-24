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
    /** Delade lektioner: a share's teacher carries the group too. */
    shares?: readonly { teacherId: string | null }[];
  }[],
  userId: string,
  subjectId: string,
  groupName: (groupId: string) => string,
): string[] {
  const names = new Set<string>();
  for (const requirement of requirements) {
    if (requirement.subjectId !== subjectId) continue;
    if (
      requirement.teacherId !== userId &&
      requirement.coTeacherId !== userId &&
      !(requirement.shares ?? []).some((share) => share.teacherId === userId)
    ) {
      continue;
    }
    names.add(groupName(requirement.studentGroupId));
  }
  return [...names].sort((a, b) => a.localeCompare(b, "sv"));
}

export interface LoadBarSegments {
  /**
   * Share of the bar's width, 0..1 each, summing to 1 (or 0 for an empty
   * week, and for a teacher with no target). `duty` is the uppdrag that do NOT count toward the target, drawn
   * first and outside the comparison; `teaching` is what the target is
   * compared with — teaching plus the uppdrag that count.
   */
  duty: number;
  teaching: number;
  remaining: number;
  over: number;
  /** Minutes behind each segment, for the label. */
  dutyMinutes: number;
  teachingMinutes: number;
  remainingMinutes: number;
  overMinutes: number;
  /** Of `teachingMinutes`' week, the uppdrag minutes that count as teaching. */
  countedDutyMinutes: number;
}

type DutyFigures = Partial<
  Pick<
    TeacherLoad,
    | "dutyMinutesPerWeek"
    | "countedDutyMinutesPerWeek"
    | "dutyPeakMinutesPerWeek"
    | "countedDutyPeakMinutesPerWeek"
  >
>;

type BarTeacher = Pick<TeacherLoad, "assignedMinutesPerWeek" | "targetMinutesPerWeek"> & DutyFigures;

/**
 * The uppdrag minutes a week view reads: all of them, and the part that
 * counts toward the target.
 *
 * The standardvecka reads the standardvecka figures, where a dated uppdrag
 * weighs its share of the year's weeks. The TOPPVECKA reads the uppdrag's own
 * toppvecka (20261017090000, 20261022090000), where it weighs its whole
 * minutes in the weeks it runs: a mentor from January carries 90 minutes in
 * March, not the 41 the year averages to, and a peak view that added the
 * average understated exactly the week it exists to show. Each part is at
 * its own busiest week — the teaching's beside the uppdrag's, the counted
 * uppdrag's beside all of them — so the sum never understates a week, and
 * where they peak in different weeks it states more than any one week holds.
 *
 * A report without both peaks reads as the standardvecka, AS A PAIR: the
 * gateway release before 20261022090000 sends dutyPeakMinutesPerWeek but not
 * the counted one, and a peak beside a standardvecka figure is no week at all
 * — a counted 90-minute uppdrag from January read as 90 against 41 and drew
 * 49 minutes of uncounted uppdrag that do not exist.
 */
export function dutyMinutesOf(teacher: DutyFigures, week: WeekView): { all: number; counted: number } {
  const standard = { all: teacher.dutyMinutesPerWeek ?? 0, counted: teacher.countedDutyMinutesPerWeek ?? 0 };
  if (week !== "peak") return standard;
  if (teacher.dutyPeakMinutesPerWeek === undefined || teacher.countedDutyPeakMinutesPerWeek === undefined) {
    return standard;
  }
  return { all: teacher.dutyPeakMinutesPerWeek, counted: teacher.countedDutyPeakMinutesPerWeek };
}

/**
 * The Lectio-style bar: uppdrag, undervisning, kvar till mål, över mål.
 *
 * The comparable part's width is max(target, counted), so a teacher at 110 %
 * shows a bar whose last tenth is red rather than a bar that overflows its
 * cell — and two teachers' bars are NOT on the same scale. That is
 * deliberate: the matrix compares each teacher with their own target (an
 * 80 % post fills at 865 minutes, a full one at 1 080), and a shared scale
 * would make every part-timer look under-used. The number beside the bar is
 * what compares across rows.
 *
 * COUNTED IS WHAT THE TARGET READS (Fas 2). An uppdrag the school counts as
 * teaching (countsAsTeaching — pedagogisk lunch, resurstid) is inside the
 * teaching segment, because the report's status and saldo already include
 * it; one that does not count is the dark `duty` segment drawn before the
 * comparison, widening the bar without moving the target, so a mentor's 90
 * minutes are seen and never read as "over". In the peak week the uppdrag
 * are their own toppvecka (dutyMinutesOf): the counted ones' peak meets the
 * target, and the dark segment is the rest of the busiest uppdrag week. When
 * the counted and the uncounted uppdrag run in different terms, that rest can
 * be less than the uncounted ones hold in their own weeks — never more than
 * the busiest uppdrag week holds — while the comparison with the target is
 * never understated.
 *
 * Without a target there is nothing to be short of or over, and nothing to
 * be a share OF: the bar is drawn empty, its track alone, and the label beside
 * it says "inget riktmärke". It used to be the week alone at full width, and a
 * full bar under the heading "Andel av mål" reads as 100 % of a target the
 * teacher does not have (webbgenomgången 2026-10-07, /admin/staffing and Min
 * tjänst). The minutes are still returned, for the sentence a screen reader
 * gets.
 */
export function loadBarSegments(
  teacher: BarTeacher,
  week: WeekView = "standard",
  peakMinutes = teacher.assignedMinutesPerWeek,
): LoadBarSegments {
  const teaching = week === "peak" ? peakMinutes : teacher.assignedMinutesPerWeek;
  const duties = dutyMinutesOf(teacher, week);
  const countedDuty = duties.counted;
  const dutyMinutes = Math.max(0, duties.all - countedDuty);
  const counted = teaching + countedDuty;
  const target = teacher.targetMinutesPerWeek;
  if (target === null || target <= 0) {
    return {
      duty: 0,
      teaching: 0,
      remaining: 0,
      over: 0,
      dutyMinutes,
      teachingMinutes: counted,
      remainingMinutes: 0,
      overMinutes: Math.max(0, target === 0 ? counted : 0),
      countedDutyMinutes: countedDuty,
    };
  }
  const scale = dutyMinutes + Math.max(target, counted);
  const teachingMinutes = Math.min(counted, target);
  const remainingMinutes = Math.max(0, target - counted);
  const overMinutes = Math.max(0, counted - target);
  return {
    duty: dutyMinutes / scale,
    teaching: teachingMinutes / scale,
    remaining: remainingMinutes / scale,
    over: overMinutes / scale,
    dutyMinutes,
    teachingMinutes,
    remainingMinutes,
    overMinutes,
    countedDutyMinutes: countedDuty,
  };
}

/** The four KPI figures above the matrix. */
export function kpis(report: TeacherLoadReport): {
  unstaffed: number;
  unqualified: number | null;
  overTarget: number;
  bottlenecks: number | null;
} {
  return {
    unstaffed: report.unstaffedRequirements.length,
    // Null, not 0, when nothing was checked: an empty list from a school with
    // no behörighet rows must not read as "everybody is qualified".
    unqualified: report.qualificationsRecorded ? report.unqualifiedAssignments.length : null,
    overTarget: report.teachers.filter((teacher) => teacher.status === "OVER").length,
    // Null for the same reason: without a single behörighet the capacity in
    // a subject is unknown, and "0 flaskhalsar" would be a claim.
    bottlenecks: report.bottlenecksComputed
      ? report.subjectBottlenecks.filter((row) => row.short).length
      : null,
  };
}
