import type { TeacherLoadReportResponse } from "../../../lib/staffing-queries";
import type {
  GroupLoss,
  ReconciliationLine,
  StaffingNotice,
  StaffingReconciliationResponse,
  TeacherReconciliation,
} from "../../../lib/staffing-reconciliation";
import type { ScopeInterpretation, ScopeReport, ScopeStageHours, ScopeVersionInfo, TeacherScope } from "../../../lib/assignment-scope";
import { changesDuringYear, postStretches } from "../../../lib/employment-periods";
import { shownEmployment } from "../../../lib/teacher-load";
import type {
  GradeSpan,
  LoadStatus,
  PeriodLoad,
  ShownEmployment,
  SubjectBottleneck,
  SubjectLoad,
  TeacherAssignment,
  TeacherLoad,
  UnqualifiedAssignment,
  UnstaffedRequirement,
} from "../../../lib/teacher-load";
import type {
  AcademicYear,
  TeacherCandidate,
  TeacherEmployment,
  TeacherQualificationKind,
  TeacherSuggestions,
  TeachingRequirement,
} from "../../../lib/types";
import { addDays, isoWeekday, NOW, THIS_MONDAY, TODAY } from "./calendar";
import { GROUP_MEMBERS, SCHOOL_BREAKS } from "./school-days";
import { DUTIES, EMPLOYMENTS, QUALIFICATIONS, STAFFING_POLICY } from "./staffing-rows";
import {
  ALL_PEOPLE,
  byId,
  GROUP_LIST,
  GROUPS,
  REQUIREMENTS,
  STUDENT_LIST,
  SUBJECT_LIST,
  SUBJECTS,
  TEACHERS,
  YEAR,
} from "./world";

/**
 * GET /staffing/load, /suggest-teachers and /delivered, computed from
 * staffing-rows.ts and world.ts's timplansposter.
 *
 * A short copy of the arithmetic in lib/teacher-load.ts (the stub may not
 * import app code at runtime): standardvecka, the policy's target and
 * tolerance, behörighet, bottlenecks and årsarbetstid. It simplifies what the
 * fixtures never exercise — every timplanspost runs every week of the year,
 * and the toppvecka adds a dated uppdrag in full — so the figures are the
 * gateway's for this school, not for every school.
 */

/** The answer as the gateway sends it; the web's type leaves out listsComputed. */
export type LoadResponse = TeacherLoadReportResponse & { listsComputed: boolean };

const round1 = (value: number) => Math.round(value * 10) / 10;
const round4 = (value: number) => Math.round(value * 10_000) / 10_000;
const round5 = (value: number) => Math.round(value / 5) * 5;
const later = (a: string, b: string) => (a > b ? a : b);
const earlier = (a: string, b: string) => (a < b ? a : b);
const byName = (a: string, b: string) => a.localeCompare(b, "sv");

const STATUS_ORDER: Record<LoadStatus, number> = { OVER: 0, UNDER: 1, OK: 2, NO_TARGET: 3 };
const RANK: Record<TeacherQualificationKind, number> = { LEGITIMATION: 3, BEHORIG: 2, TILLATEN: 1 };

/** Weekdays in [from, to] that no lov or studiedag of the year closes. */
function teachingDays(year: AcademicYear, from: string, to: string): number {
  const closures = SCHOOL_BREAKS.filter((row) => row.academicYearId === year.id);
  let days = 0;
  for (let date = later(from, year.startDate); date <= earlier(to, year.endDate); date = addDays(date, 1)) {
    if (isoWeekday(date) > 5) continue;
    if (closures.some((closure) => closure.startDate <= date && date <= closure.endDate)) continue;
    days++;
  }
  return days;
}

/** The weeks a period is taught, lov out: the year's own when undated. */
const teachingWeeks = (year: AcademicYear, from: string | null, to: string | null) =>
  teachingDays(year, from ?? year.startDate, to ?? year.endDate) / 5;

/** The years a group holds: its members' home classes, else its own grade. */
function gradeSpanOf(groupId: string): GradeSpan | null {
  const grades = GROUP_MEMBERS.filter((member) => member.studentGroupId === groupId)
    .map((member) => byId(GROUP_LIST, byId(STUDENT_LIST, member.studentId)?.studentGroupId)?.gradeLevel)
    .filter((grade): grade is number => typeof grade === "number");
  if (grades.length > 0) return { min: Math.min(...grades), max: Math.max(...grades) };
  const own = byId(GROUP_LIST, groupId)?.gradeLevel ?? null;
  return own === null ? null : { min: own, max: own };
}

/** Σ of the row's lektionslängder when it has them: 1 × 60 + 1 × 40 is 100, not 120. */
const weeklyMinutesOf = (row: TeachingRequirement) =>
  row.lessonLengths && row.lessonLengths.length > 0
    ? row.lessonLengths.reduce((sum, minutes) => sum + minutes, 0)
    : row.lessonsPerWeek * row.minutesPerLesson;

function targetOf(
  employment: Pick<ShownEmployment, "employmentPercent" | "reductionPercent" | "teachingTargetMinutesPerWeek"> | null,
): number | null {
  if (!employment) return null;
  if (employment.teachingTargetMinutesPerWeek !== null) return employment.teachingTargetMinutesPerWeek;
  const full = STAFFING_POLICY.fullTimeTeachingMinutesPerWeek;
  if (full === null) return null;
  return round5((full * (employment.employmentPercent - employment.reductionPercent)) / 100);
}

function statusOf(counted: number, target: number | null): LoadStatus {
  if (target === null) return "NO_TARGET";
  const minutes = Math.round(counted);
  const band = (target * STAFFING_POLICY.overAllocationTolerancePercent) / 100;
  if (minutes > target + band) return "OVER";
  if (minutes < target - band) return "UNDER";
  return "OK";
}

/** The strongest behörighet of `userId` covering a subject for a span, valid in the year. */
/**
 * A post that changes during the year, stretch by stretch, as the gateway's
 * report gives it (teacher-load.ts stretchLoads): the year cut into whole
 * weeks by postStretches, each stretch's target from its own figures. The
 * stub's timplansposter and uppdrag run all year, so every stretch counts the
 * year's minutes. Empty for a post the same all year.
 */
function periodsOf(year: AcademicYear, employment: TeacherEmployment | null, counted: number): PeriodLoad[] {
  // The stub's posts all carry their percentages, as a full administrator reads them.
  const shown = shownEmployment(employment);
  if (!shown || !changesDuringYear(shown, year)) return [];
  return postStretches(shown, year).map((stretch): PeriodLoad => {
    const target = targetOf(stretch.figures);
    const weeks = stretch.window ? teachingWeeks(year, stretch.window.startDate, stretch.window.endDate) : 0;
    return {
      from: stretch.from,
      to: stretch.to,
      kind: stretch.kind,
      effectiveFrom: stretch.window?.startDate ?? null,
      effectiveTo: stretch.window?.endDate ?? null,
      employmentPercent: stretch.figures.employmentPercent,
      reductionPercent: stretch.figures.reductionPercent,
      ownTargetMinutesPerWeek: stretch.figures.teachingTargetMinutesPerWeek,
      targetMinutesPerWeek: target,
      teachingWeeks: round1(weeks),
      countedMinutesPerWeek: Math.round(counted),
      balanceMinutesPerWeek: target === null ? null : target - Math.round(counted),
      percentOfTarget: target === null || target === 0 ? null : round1((counted / target) * 100),
      status: statusOf(counted, target),
    };
  });
}

/** The worst stretch with teaching weeks, as the report's status for a changing post. */
function worstOf(periods: PeriodLoad[]): LoadStatus | null {
  const judged = periods.filter((period) => period.teachingWeeks > 0);
  if (judged.length === 0) return null;
  return judged.reduce((worst, period) => (STATUS_ORDER[period.status] < STATUS_ORDER[worst] ? period.status : worst), judged[0]!.status);
}

function strongestCovering(userId: string, subjectId: string, span: GradeSpan | null, year: AcademicYear) {
  let best: TeacherQualificationKind | null = null;
  for (const row of QUALIFICATIONS) {
    if (row.userId !== userId || row.subjectId !== subjectId) continue;
    if ((row.validFrom && row.validFrom > year.endDate) || (row.validTo && row.validTo < year.startDate)) continue;
    if (span && (row.minGradeLevel > span.min || row.maxGradeLevel < span.max)) continue;
    if (best === null || RANK[row.kind] > RANK[best]) best = row.kind;
  }
  return best;
}

interface Tally {
  assigned: number;
  annualMinutes: number;
  peak: number;
  requirementCount: number;
  dutyMinutes: number;
  countedDutyMinutes: number;
  undatedDutyMinutes: number;
  datedDutyPeak: number;
  dutyAnnualMinutes: number;
  dutyCount: number;
  subjects: Map<string, { subjectName: string; minutes: number }>;
  assignments: TeacherAssignment[];
}

/** The report for one läsår over the given timplansposter (the year's own by default). */
export function loadReport(
  year: AcademicYear,
  requirements = REQUIREMENTS.filter((row) => row.academicYearId === year.id),
): LoadResponse {
  const policy = STAFFING_POLICY;
  const yearWeeks = teachingWeeks(year, null, null);
  const employments = EMPLOYMENTS.filter((row) => row.academicYearId === year.id);
  const duties = DUTIES.filter((row) => row.academicYearId === year.id);
  const subjectName = (id: string) => byId(SUBJECT_LIST, id)?.name ?? "—";
  const groupName = (id: string) => byId(GROUP_LIST, id)?.name ?? "—";

  const tallies = new Map<string, Tally>();
  const tallyOf = (userId: string) => {
    let tally = tallies.get(userId);
    if (!tally) {
      tally = {
        assigned: 0,
        annualMinutes: 0,
        peak: 0,
        requirementCount: 0,
        dutyMinutes: 0,
        countedDutyMinutes: 0,
        undatedDutyMinutes: 0,
        datedDutyPeak: 0,
        dutyAnnualMinutes: 0,
        dutyCount: 0,
        subjects: new Map(),
        assignments: [],
      };
      tallies.set(userId, tally);
    }
    return tally;
  };
  // A post with nothing on it is still a row: its whole target is unfilled.
  for (const employment of employments) tallyOf(employment.userId);

  for (const duty of duties) {
    const tally = tallyOf(duty.userId);
    const dated = Boolean(duty.validFrom || duty.validTo);
    const weeks = teachingWeeks(year, duty.validFrom, duty.validTo);
    const standard = dated ? (duty.minutesPerWeek * weeks) / yearWeeks : duty.minutesPerWeek;
    tally.dutyMinutes += standard;
    tally.dutyCount += 1;
    if (duty.countsAsTeaching) tally.countedDutyMinutes += standard;
    tally.dutyAnnualMinutes += duty.minutesPerWeek * weeks;
    if (dated) tally.datedDutyPeak = Math.max(tally.datedDutyPeak, duty.minutesPerWeek);
    else tally.undatedDutyMinutes += duty.minutesPerWeek;
  }

  const unstaffedRequirements: UnstaffedRequirement[] = [];
  const unqualifiedAssignments: UnqualifiedAssignment[] = [];
  const demand = new Map<string, { subjectName: string; minutes: number; count: number }>();
  let lessonMinutesPerWeek = 0;

  for (const requirement of requirements) {
    const lesson = weeklyMinutesOf(requirement);
    const span = gradeSpanOf(requirement.studentGroupId);
    const common = {
      subjectId: requirement.subjectId,
      subjectName: subjectName(requirement.subjectId),
      studentGroupId: requirement.studentGroupId,
      groupName: groupName(requirement.studentGroupId),
      gradeSpan: span,
    };
    lessonMinutesPerWeek += lesson;
    if (requirement.teacherId === null) {
      const teacherMinutes = (lesson * requirement.teacherLoadPercent) / 100;
      unstaffedRequirements.push({
        requirementId: requirement.id,
        ...common,
        minutesPerWeek: Math.round(lesson),
        teacherMinutesPerWeek: Math.round(teacherMinutes),
      });
      const subjectDemand = demand.get(requirement.subjectId) ?? { subjectName: common.subjectName, minutes: 0, count: 0 };
      subjectDemand.minutes += teacherMinutes;
      subjectDemand.count += 1;
      demand.set(requirement.subjectId, subjectDemand);
    }
    const roles: Array<[string | null, TeacherAssignment["role"], number]> = [
      [requirement.teacherId, "TEACHER", requirement.teacherLoadPercent],
      [requirement.coTeacherId, "CO_TEACHER", requirement.coTeacherLoadPercent],
    ];
    for (const [userId, role, percent] of roles) {
      if (userId === null) continue;
      const minutes = (lesson * percent) / 100;
      const annual = minutes * yearWeeks;
      const tally = tallyOf(userId);
      tally.assigned += minutes;
      tally.annualMinutes += annual;
      tally.peak += minutes;
      tally.requirementCount += 1;
      tally.assignments.push({
        requirementId: requirement.id,
        role,
        ...common,
        recurrence: requirement.recurrence,
        startDate: requirement.startDate,
        endDate: requirement.endDate,
        lessonMinutesPerWeek: Math.round(lesson),
        timeMinutesPerWeek: Math.round(minutes),
        minutesPerWeek: Math.round(minutes),
        hoursPerYear: round1(annual / 60),
      });
      const subject = tally.subjects.get(requirement.subjectId) ?? { subjectName: common.subjectName, minutes: 0 };
      subject.minutes += minutes;
      tally.subjects.set(requirement.subjectId, subject);
      if (
        QUALIFICATIONS.length > 0 &&
        policy.qualificationMode !== "OFF" &&
        strongestCovering(userId, requirement.subjectId, span, year) === null
      ) {
        unqualifiedAssignments.push({ requirementId: requirement.id, userId, role, ...common });
      }
    }
  }

  const teachers: TeacherLoad[] = [...tallies].map(([userId, tally]) => {
    const employment = shownEmployment(employments.find((row) => row.userId === userId));
    const target = targetOf(employment);
    const counted = tally.assigned + tally.countedDutyMinutes;
    const periods = periodsOf(year, employment, counted);
    const active = employment ? employment.employmentPercent - employment.reductionPercent : null;
    const regulated = active === null ? null : (policy.fullTimeRegulatedHoursPerYear * active) / 100;
    const annualHours =
      employment?.contractKind === "FERIE" && active !== null ? (policy.fullTimeAnnualHours * active) / 100 : null;
    const subjects: SubjectLoad[] = [...tally.subjects]
      .map(([subjectId, subject]) => {
        const share = tally.assigned > 0 ? subject.minutes / tally.assigned : 0;
        return {
          subjectId,
          subjectName: subject.subjectName,
          minutesPerWeek: Math.round(subject.minutes),
          shareOfTeaching: round4(share),
          percentOfEmployment: employment ? round1(employment.employmentPercent * share) : null,
          percentOfFullTime:
            policy.fullTimeTeachingMinutesPerWeek === null
              ? null
              : round1((subject.minutes / policy.fullTimeTeachingMinutesPerWeek) * 100),
        };
      })
      .sort((a, b) => b.minutesPerWeek - a.minutesPerWeek || a.subjectId.localeCompare(b.subjectId));
    return {
      userId,
      employment: employment && {
        userId,
        employmentPercent: employment.employmentPercent,
        reductionPercent: employment.reductionPercent,
        contractKind: employment.contractKind,
        teachingTargetMinutesPerWeek: employment.teachingTargetMinutesPerWeek,
        signature: employment.signature,
        // The gateway names a post's periods only when it has some.
        ...((employment.periods ?? []).length > 0
          ? {
              periods: employment.periods!.map((period) => ({
                validFrom: period.validFrom,
                validTo: period.validTo,
                employmentPercent: period.employmentPercent,
                reductionPercent: period.reductionPercent,
                teachingTargetMinutesPerWeek: period.teachingTargetMinutesPerWeek,
              })),
            }
          : {}),
      },
      targetMinutesPerWeek: target,
      assignedMinutesPerWeek: Math.round(tally.assigned),
      peakMinutesPerWeek: Math.round(tally.peak),
      dutyMinutesPerWeek: Math.round(tally.dutyMinutes),
      dutyPeakMinutesPerWeek: Math.round(tally.undatedDutyMinutes + tally.datedDutyPeak),
      countedDutyMinutesPerWeek: Math.round(tally.countedDutyMinutes),
      countedMinutesPerWeek: Math.round(counted),
      balanceMinutesPerWeek: target === null ? null : target - Math.round(counted),
      percentOfTarget: target === null || target === 0 ? null : round1((counted / target) * 100),
      status: worstOf(periods) ?? statusOf(counted, target),
      periods,
      requirementCount: tally.requirementCount,
      dutyCount: tally.dutyCount,
      subjects,
      assignments: tally.assignments.sort(
        (a, b) =>
          byName(a.groupName, b.groupName) ||
          byName(a.subjectName, b.subjectName) ||
          a.requirementId.localeCompare(b.requirementId) ||
          a.role.localeCompare(b.role),
      ),
      annual: {
        assignedHoursPerYear: round1(tally.annualMinutes / 60),
        regulatedHoursPerYear: regulated === null ? null : round1(regulated),
        workDaysPerYear: policy.workDaysPerYear,
        contractKind: employment?.contractKind ?? null,
        annualHours: annualHours === null ? null : round1(annualHours),
        unregulatedHoursPerYear: annualHours === null || regulated === null ? null : round1(annualHours - regulated),
        semesterHoursPerWeek:
          employment?.contractKind === "SEMESTER" && active !== null
            ? round1((policy.semesterHoursPerWeek * active) / 100)
            : null,
        dutyHoursPerYear: round1(tally.dutyAnnualMinutes / 60),
        teachingWeeksPerYear: yearWeeks,
        percentOfRegulated:
          regulated === null || regulated <= 0 ? null : round1((tally.annualMinutes / 60 / regulated) * 100),
      },
    };
  });
  // OVER first, then by id: the gateway's order.
  teachers.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.userId.localeCompare(b.userId));

  // Capacity per subject with an unstaffed row; a deactivated holder has none.
  const inactive = new Set(ALL_PEOPLE.filter((person) => !person.isActive).map((person) => person.id));
  const subjectBottlenecks: SubjectBottleneck[] = [...demand]
    .map(([subjectId, subjectDemand]) => {
      const holders = new Set(
        QUALIFICATIONS.filter((row) => row.subjectId === subjectId && !inactive.has(row.userId)).map((row) => row.userId),
      );
      let remaining = 0;
      let withTarget = 0;
      let noTarget = 0;
      for (const userId of holders) {
        const row = teachers.find((teacher) => teacher.userId === userId);
        const target = targetOf(shownEmployment(employments.find((employment) => employment.userId === userId)));
        if (target === null) {
          noTarget += 1;
          continue;
        }
        withTarget += 1;
        remaining += Math.max(0, target - (row?.countedMinutesPerWeek ?? 0));
      }
      const demanded = Math.round(subjectDemand.minutes);
      return {
        subjectId,
        subjectName: subjectDemand.subjectName,
        unstaffedCount: subjectDemand.count,
        demandedMinutesPerWeek: demanded,
        qualifiedRemainingMinutesPerWeek: Math.round(remaining),
        qualifiedTeacherCount: withTarget,
        qualifiedNoTargetCount: noTarget,
        short: demanded > Math.round(remaining),
      };
    })
    .sort(
      (a, b) =>
        Number(b.short) - Number(a.short) ||
        b.demandedMinutesPerWeek - b.qualifiedRemainingMinutesPerWeek -
          (a.demandedMinutesPerWeek - a.qualifiedRemainingMinutesPerWeek) ||
        a.subjectId.localeCompare(b.subjectId),
    );

  return {
    academicYearId: year.id,
    horizon: "planned",
    year: { startDate: year.startDate, endDate: year.endDate },
    listsComputed: true,
    loadModel: policy.loadModel,
    teachers,
    unstaffedRequirements,
    unqualifiedAssignments,
    qualificationsRecorded: QUALIFICATIONS.length > 0,
    subjectBottlenecks,
    bottlenecksComputed: QUALIFICATIONS.length > 0,
    scope: scopeOf(teachers),
    totals: {
      teacherMinutesPerWeek: Math.round([...tallies.values()].reduce((sum, tally) => sum + tally.assigned, 0)),
      lessonMinutesPerWeek: Math.round(lessonMinutesPerWeek),
      dutyMinutesPerWeek: Math.round([...tallies.values()].reduce((sum, tally) => sum + tally.dutyMinutes, 0)),
    },
  };
}

// --- Undervisningsuppdragets omfattning (SFS 2026:1487) ------------------------

/**
 * The `scope` block of GET /staffing/load (src/staffing/assignment-scope.ts): each teacher's teaching hours for the läsår against the ordinance's
 * span for the stage, which the cards of tjänstefördelningen's drawer and of Min tjänst, and the assessment card in the drawer, are drawn from.
 *
 * A short copy of what the fixtures exercise, as the arithmetic above is. The hours are the lessons' OWN minutes over the year's teaching weeks
 * (unweighted: the report's charge is not time), the stage is the group's years (a group over two stages is read in the stricter, as the
 * gateway does), the span is the ordinance's own, blended by hours and scaled by the post, and nobody here has a level of their own, so a
 * teacher is INSIDE or OVER_MAX. The bands, the version's title and the interpretation are the migration's (20270301090000), not made up.
 *
 * ONE THING THE STUB DOES THAT THE GATEWAY DOES NOT. The ordinance holds from 2027-07-01 and the gateway answers `version: null`, so that no
 * card is drawn, for a läsår that began before it. The stub's läsår is the one around today (calendar.ts), and the browser gates must draw
 * the cards on whatever day they run (a card that appeared on 2027-07-01 would move every baseline that holds one, with no change of code),
 * so the stub answers as if the ordinance held for its läsår. Its version says the date the ordinance says.
 */
const SCOPE_VERSION: ScopeVersionInfo = {
  code: "SFS2026:1487",
  sfs: "SFS 2026:1487",
  title: "Förordning om omfattning av tiden för lärares och förskollärares undervisningsuppdrag",
  validFrom: "2027-07-01",
  validTo: null,
  source: "https://svenskforfattningssamling.se/sites/default/files/sfs/2026-06/SFS2026-1487.pdf",
};

const SCOPE_BANDS = [
  { gradeFrom: 1, gradeTo: 6, teachingHoursLow: 550, teachingHoursHigh: 650, planningFloorPercent: 100 },
  { gradeFrom: 7, gradeTo: 9, teachingHoursLow: 500, teachingHoursHigh: 600, planningFloorPercent: 110 },
] as const;

const SCOPE_INTERPRETATION: ScopeInterpretation = {
  section: "4 § p. 1 och 5 § p. 1",
  note: 'Tolkning: 5 § säger "Utöver den tid som anges i 4 §" men 4 § räknar inte upp årskurs 7-9. Läst som 100 % (4 §) och ytterligare minst 10 % (5 §), vilket är utredningens egen sammanfattning (prop. 2025/26:196 bilaga 1 s. 125).',
};

/** The band of a group's years: 0 or 1 for a stage, "UNREGULATED" for förskoleklass, "UNKNOWN" for a group with no årskurs. */
function scopeBandOf(span: GradeSpan | null): 0 | 1 | "UNREGULATED" | "UNKNOWN" {
  if (span === null) return "UNKNOWN";
  if (span.max === 0) return "UNREGULATED";
  if (span.max <= 6) return 0;
  // 7-9, or a span over both stages: the stricter band.
  return 1;
}

function scopeOf(teachers: TeacherLoad[]): ScopeReport {
  const rows = teachers.map((teacher): TeacherScope => {
    const weeks = teacher.annual.teachingWeeksPerYear;
    const stageMinutes = [0, 0];
    let unregulatedMinutes = 0;
    let unknownMinutes = 0;
    for (const assignment of teacher.assignments) {
      const minutes = assignment.timeMinutesPerWeek * weeks;
      const band = scopeBandOf(assignment.gradeSpan);
      if (band === "UNREGULATED") unregulatedMinutes += minutes;
      else if (band === "UNKNOWN") unknownMinutes += minutes;
      else stageMinutes[band]! += minutes;
    }
    const hours = (minutes: number) => round1(minutes / 60);
    const inStages = stageMinutes[0]! + stageMinutes[1]!;
    const total = inStages + unregulatedMinutes + unknownMinutes;
    const stages: ScopeStageHours[] = SCOPE_BANDS.flatMap((band, index) =>
      stageMinutes[index]! > 0 ? [{ ...band, hours: hours(stageMinutes[index]!) }] : [],
    );
    const blended = (pick: (band: (typeof SCOPE_BANDS)[number]) => number) =>
      inStages > 0 ? round1(SCOPE_BANDS.reduce((sum, band, index) => sum + (stageMinutes[index]! / inStages) * pick(band), 0)) : null;
    const fullTimeHighestHours = blended((band) => band.teachingHoursHigh);
    const fullTimeLowestHours = blended((band) => band.teachingHoursLow);
    const employment = teacher.employment;
    const active =
      employment && employment.employmentPercent !== null && employment.reductionPercent !== null
        ? employment.employmentPercent - employment.reductionPercent
        : null;
    const highestHours = fullTimeHighestHours !== null && active !== null ? round1((fullTimeHighestHours * active) / 100) : null;
    const planningFloorHours =
      inStages > 0 ? round1(SCOPE_BANDS.reduce((sum, band, index) => sum + (stageMinutes[index]! / 60) * (band.planningFloorPercent / 100), 0)) : null;
    // Whether the floor fits is worked out for a full ferietjänst only: the working time that is left after the teaching and every uppdrag.
    const remainingHours =
      teacher.annual.contractKind === "FERIE" && teacher.annual.annualHours !== null
        ? round1(teacher.annual.annualHours - hours(total) - teacher.annual.dutyHoursPerYear)
        : null;
    const base = {
      userId: teacher.userId,
      teachingHours: hours(total),
      stages,
      unregulatedHours: hours(unregulatedMinutes),
      unknownGradeHours: hours(unknownMinutes),
      fullTimeHighestHours,
      fullTimeLowestHours,
      highestHours,
      ordinanceHighestHours: highestHours,
      planningFloorHours,
      remainingHours,
      planningFits: remainingHours !== null && planningFloorHours !== null ? remainingHours >= planningFloorHours : null,
    };
    if (total === 0) return { ...base, verdict: "NOT_JUDGED", notJudged: "NO_TEACHING" };
    if (employment === null) return { ...base, verdict: "NOT_JUDGED", notJudged: "NO_POST" };
    if (inStages === 0) return { ...base, verdict: "NOT_JUDGED", notJudged: "NO_STAGE" };
    return { ...base, verdict: hours(inStages) > highestHours! ? "OVER_MAX" : "INSIDE", notJudged: null };
  });
  return { version: SCOPE_VERSION, yearReason: null, interpretations: [SCOPE_INTERPRETATION], teachers: rows };
}

/** What a TEACHER is answered: their own row, and none of the admin's lists. */
export const ownLoad = (report: LoadResponse, userId: string): LoadResponse => ({
  ...report,
  scope: report.scope && { ...report.scope, teachers: report.scope.teachers.filter((row) => row.userId === userId) },
  teachers: report.teachers.filter((row) => row.userId === userId),
  unstaffedRequirements: [],
  unqualifiedAssignments: report.unqualifiedAssignments.filter((row) => row.userId === userId),
  subjectBottlenecks: [],
  bottlenecksComputed: false,
  totals: { teacherMinutesPerWeek: 0, lessonMinutesPerWeek: 0, dutyMinutesPerWeek: 0 },
});

/** GET /staffing/suggest-teachers: the school's active staff ranked for one row, or null for an unknown row. */
export function suggestTeachers(requirementId: string, year: AcademicYear): TeacherSuggestions | null {
  const requirement = REQUIREMENTS.find((row) => row.id === requirementId && row.academicYearId === year.id);
  if (!requirement) return null;
  const others = REQUIREMENTS.filter((row) => row.academicYearId === year.id && row.id !== requirementId);
  // Everybody's minutes with this row's lead taken off it.
  const base = loadReport(year, [...others, { ...requirement, teacherId: null }]);
  const charge = (weeklyMinutesOf(requirement) * requirement.teacherLoadPercent) / 100;
  const span = gradeSpanOf(requirement.studentGroupId);
  const teaches = (userId: string, row: TeachingRequirement) => row.teacherId === userId || row.coTeacherId === userId;
  const staff = ALL_PEOPLE.filter(
    (person) => person.isActive && (person.role === "TEACHER" || person.role === "SCHOOL_ADMIN"),
  );
  const candidates: TeacherCandidate[] = staff
    .filter((person) => person.id !== requirement.coTeacherId)
    .map((person) => {
      const post = EMPLOYMENTS.find((row) => row.userId === person.id && row.academicYearId === year.id) ?? null;
      const target = targetOf(shownEmployment(post));
      const after = (base.teachers.find((row) => row.userId === person.id)?.countedMinutesPerWeek ?? 0) + charge;
      const status = statusOf(after, target);
      return {
        userId: person.id,
        qualificationKind: strongestCovering(person.id, requirement.subjectId, span, year),
        teachesSubjectAlready: others.some((row) => row.subjectId === requirement.subjectId && teaches(person.id, row)),
        teachesGroupAlready: others.some(
          (row) => row.studentGroupId === requirement.studentGroupId && teaches(person.id, row),
        ),
        taughtLastYear: false,
        currentlyAssigned: requirement.teacherId === person.id,
        remainingMinutesPerWeek: target === null ? null : target - Math.round(after),
        wouldExceed: charge > 0 && status === "OVER",
        status,
      };
    });
  const tier = (candidate: TeacherCandidate) => (candidate.qualificationKind ? RANK[candidate.qualificationKind] : 0);
  candidates.sort(
    (a, b) =>
      tier(b) - tier(a) ||
      Number(b.teachesGroupAlready) - Number(a.teachesGroupAlready) ||
      Number(a.remainingMinutesPerWeek === null) - Number(b.remainingMinutesPerWeek === null) ||
      (b.remainingMinutesPerWeek ?? 0) - (a.remainingMinutesPerWeek ?? 0) ||
      a.userId.localeCompare(b.userId),
  );
  return {
    requirementId,
    subjectId: requirement.subjectId,
    studentGroupId: requirement.studentGroupId,
    gradeSpan: span,
    teacherMinutesPerWeek: Math.round(charge),
    qualificationsRecorded: QUALIFICATIONS.length > 0,
    // No year before this one: nobody taught the group's predecessor.
    lastYear: null,
    candidates,
  };
}

// --- Planerat, schemalagt, genomfört -----------------------------------------

const NO_LOSS = {
  cancelledTeacherUnavailable: 0,
  cancelledRoomUnavailable: 0,
  cancelledManual: 0,
  cancelledUnknown: 0,
  otherStatus: 0,
};

/**
 * GET /staffing/delivered over [from, to], already inside the year. The
 * calendar is published from two weeks before this Monday through next week,
 * and over a full week of it one Svenska in 7A was cancelled (the studiebesök)
 * and one Ma in 7B was held by Cecilia as vikarie for Bo.
 */
export function delivered(
  year: AcademicYear,
  range: { from: string; to: string },
  notices: StaffingNotice[],
  ownUserId: string | null,
): StaffingReconciliationResponse {
  const report = loadReport(year);
  const answer = (rest: Partial<StaffingReconciliationResponse>): StaffingReconciliationResponse => ({
    academicYearId: year.id,
    year: { startDate: year.startDate, endDate: year.endDate },
    asOf: NOW,
    asOfDate: TODAY,
    ...range,
    comparison: null,
    loadModel: report.loadModel,
    published: null,
    teachers: [],
    groupLosses: [],
    totals: null,
    notices,
    ...rest,
  });
  // Only this läsår has a calendar; a rolled year has nothing published yet.
  if (year.id !== YEAR.id) {
    return answer({ notices: [...notices, { code: "STAFFING_NOTHING_PUBLISHED", params: {} }] });
  }

  const published = {
    from: later(year.startDate, addDays(THIS_MONDAY, -14)),
    through: earlier(year.endDate, addDays(THIS_MONDAY, 11)),
  };
  if (range.from < published.from) {
    notices.push({ code: "STAFFING_RANGE_BEFORE_PUBLISHED", params: { publishedFrom: published.from } });
  }
  const from = later(range.from, published.from);
  const to = earlier(range.to, published.through);
  const comparison = from <= to ? { from, to } : null;
  if (comparison && (isoWeekday(comparison.from) !== 1 || isoWeekday(comparison.to) < 5)) {
    notices.push({ code: "STAFFING_RANGE_PARTIAL_WEEKS", params: comparison });
  }
  if (range.to >= TODAY) {
    notices.push({ code: "STAFFING_RANGE_INCLUDES_FUTURE", params: { asOfDate: TODAY } });
  }
  const weeks = comparison ? teachingDays(year, comparison.from, comparison.to) / 5 : 0;
  // Held only up to yesterday: a lesson that has not ended is Kommande, not genomförd.
  const heldWeeks = comparison ? teachingDays(year, comparison.from, earlier(comparison.to, addDays(TODAY, -1))) / 5 : 0;
  // The two events need a whole week held, so a range of a day or two stays clean.
  const events = heldWeeks >= 1;

  const teachers: TeacherReconciliation[] = report.teachers
    .filter((row) => ownUserId === null || row.userId === ownUserId)
    .map((row) => {
      const lines: ReconciliationLine[] = row.assignments.map((assignment) => {
        const planned = Math.round(assignment.minutesPerWeek * weeks);
        const cancelled =
          events &&
          row.userId === TEACHERS.anna.id &&
          assignment.subjectId === SUBJECTS.sv.id &&
          assignment.studentGroupId === GROUPS.g7A.id;
        const covered =
          events &&
          row.userId === TEACHERS.bo.id &&
          assignment.subjectId === SUBJECTS.ma.id &&
          assignment.studentGroupId === GROUPS.g7B.id;
        return {
          subjectId: assignment.subjectId,
          studentGroupId: assignment.studentGroupId,
          extraGroupIds: [],
          planned,
          scheduled: planned,
          delivered: Math.round(assignment.minutesPerWeek * heldWeeks) - (cancelled || covered ? 60 : 0),
          substituteMinutes: 0,
          lostMinutes: cancelled ? 60 : 0,
        };
      });
      const substitute = events && row.userId === TEACHERS.cecilia.id;
      if (substitute) {
        lines.push({
          subjectId: SUBJECTS.ma.id,
          studentGroupId: GROUPS.g7B.id,
          extraGroupIds: [],
          planned: 0,
          scheduled: 0,
          delivered: 60,
          substituteMinutes: 60,
          lostMinutes: 0,
        });
      }
      const sum = (pick: (line: ReconciliationLine) => number) => lines.reduce((total, line) => total + pick(line), 0);
      const lost = { ...NO_LOSS, cancelledManual: sum((line) => line.lostMinutes) };
      const deliveredMinutes = sum((line) => line.delivered);
      return {
        userId: row.userId,
        planned: sum((line) => line.planned),
        scheduled: sum((line) => line.scheduled),
        delivered: deliveredMinutes,
        substituteMinutes: sum((line) => line.substituteMinutes),
        coveredByOthersMinutes: events && row.userId === TEACHERS.bo.id ? 60 : 0,
        aheadMinutes: 0,
        lost,
        lostMinutes: lost.cancelledManual,
        deliveredLessons: Math.round(deliveredMinutes / 60),
        displacedLessons: ownUserId === null ? 0 : null,
        lines,
      };
    });

  const groupLosses: GroupLoss[] =
    events && ownUserId === null
      ? [
          {
            studentGroupId: GROUPS.g7A.id,
            subjectId: SUBJECTS.sv.id,
            ...NO_LOSS,
            cancelledManual: 60,
            teacherless: 0,
            lessons: 1,
          },
        ]
      : [];
  const total = (pick: (row: TeacherReconciliation) => number) => teachers.reduce((sum, row) => sum + pick(row), 0);
  return answer({
    comparison,
    published,
    teachers,
    groupLosses,
    totals: comparison
      ? {
          planned: total((row) => row.planned),
          scheduled: total((row) => row.scheduled),
          delivered: total((row) => row.delivered),
          substituteMinutes: total((row) => row.substituteMinutes),
          coveredByOthersMinutes: total((row) => row.coveredByOthersMinutes),
          lostMinutes: total((row) => row.lostMinutes),
          aheadMinutes: total((row) => row.aheadMinutes),
        }
      : null,
    notices,
  });
}
