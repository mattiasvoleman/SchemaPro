/**
 * The årskurs span of a lokal timplan, as the page offers it.
 *
 * The check counts only the årskurser a plan is for (lib/timplan-coverage.ts,
 * "The plan's årskurs span"); this file is where the browser decides what a new
 * plan, a copy and the notice on the plan suggest. All of it is a SUGGESTION
 * drawn from the school's skolenheter, which only a SCHOOL_ADMIN can read
 * (SchoolUnits has no RLS arm for anyone else), and none of it reaches the
 * verdict: the verdict depends on the plan and the statute, so a teacher gets
 * exactly the verdict the admin gets.
 *
 * Pure functions, no React: each rule is tested on its own (timplan-span.test.ts).
 */

import { lydelseIsTioarig } from "@/lib/grade-numbering";
import { unitSpanIn, type SchoolUnit, type SchoolUnitType } from "@/lib/school-units";
import { stageGradesFor, type GradeSpan, type SchoolForm } from "@/lib/timplan-coverage";

/** The S1 school type whose skolenheter a plan of each school form is for. */
export const SCHOOL_FORM_UNIT_TYPE: Record<SchoolForm, SchoolUnitType> = {
  GRUNDSKOLA: "GR",
  ANPASSAD_GRUNDSKOLA_AMNEN: "GRS",
  ANPASSAD_GRUNDSKOLA_AMNESOMRADEN: "TR",
  SPECIALSKOLA: "SP",
  SAMESKOLA: "SAM",
};

/** What a span is read against: the lydelse's form and the term it applies from. */
export interface SpanVersion {
  schoolForm: SchoolForm;
  appliesFromCohortTerm: string;
}

/** The årskurser the form has, lowest to highest, in the lydelse's numbering. */
export function formGrades(version: SpanVersion): number[] {
  const stages = stageGradesFor(version);
  return [...stages.LAG, ...stages.MELLAN, ...stages.HOG].sort((a, b) => a - b);
}

/**
 * The årskurser a span's selects offer: every årskurs of the form, and the
 * förskoleklass where the lydelse has one. The tioårig lydelse counts 1..10,
 * its årskurs 1 being the former förskoleklass, so it has no row 0 to offer.
 */
export function spanGradeOptions(version: SpanVersion): number[] {
  const grades = formGrades(version);
  return lydelseIsTioarig(version.appliesFromCohortTerm) ? grades : [0, ...grades];
}

/**
 * The skolenheternas årskurser for a plan of `schoolForm` in a lydelse that is
 * `tioarig` or not: the hull of the span of every unit that holds that school
 * type and has both ends set, in the plan's numbering (unitSpanIn). Null when
 * no such unit exists — the plan then has nothing to be prefilled with.
 *
 * The HULL, not the union: the units of a school do not overlap, but two
 * units with a gap between them (F–3 and 7–9) are one school's plan, and a
 * plan has one span.
 */
export function unitSpanForForm(
  units: readonly SchoolUnit[],
  schoolForm: SchoolForm,
  tioarig: boolean,
): GradeSpan | null {
  const type = SCHOOL_FORM_UNIT_TYPE[schoolForm];
  const spans = units
    .filter((unit) => unit.schoolTypes.includes(type))
    .map((unit) => unitSpanIn(unit, tioarig ? "TIOARIG" : "NIOARIG"))
    .filter((span): span is GradeSpan => span !== null);
  if (spans.length === 0) return null;
  return {
    gradeFrom: Math.min(...spans.map((span) => span.gradeFrom)),
    gradeTo: Math.max(...spans.map((span) => span.gradeTo)),
  };
}

export function sameSpan(a: GradeSpan | null, b: GradeSpan | null): boolean {
  return a === null || b === null ? a === b : a.gradeFrom === b.gradeFrom && a.gradeTo === b.gradeTo;
}

/** The span held to the årskurser the form has: what the check can tell apart. */
function clippedToForm(span: GradeSpan, version: SpanVersion): GradeSpan | null {
  const grades = formGrades(version).filter(
    (grade) => grade >= span.gradeFrom && grade <= span.gradeTo,
  );
  return grades.length === 0 ? null : { gradeFrom: grades[0]!, gradeTo: grades[grades.length - 1]! };
}

/** Whether the span holds every årskurs of the form, which makes it the whole form. */
export function spanHoldsWholeForm(span: GradeSpan, version: SpanVersion): boolean {
  const grades = formGrades(version);
  return grades.every((grade) => grade >= span.gradeFrom && grade <= span.gradeTo);
}

/**
 * The span a plan on `version` is suggested: the skolenheternas, or null (the
 * whole form) when there is none, or when the units hold every årskurs of the
 * form anyway — "Hela skolformen" says that better than F–9.
 */
export function suggestedSpan(
  units: readonly SchoolUnit[] | undefined,
  version: SpanVersion,
): GradeSpan | null {
  if (!units) return null;
  const span = unitSpanForForm(units, version.schoolForm, lydelseIsTioarig(version.appliesFromCohortTerm));
  return span && !spanHoldsWholeForm(span, version) ? span : null;
}

/**
 * What a copy or a reopen states of the span: undefined (say nothing, the
 * gateway copies the source's own) when the fields still show it, else the
 * span asked for, null for the whole form. A source with no span and a
 * suggestion from the skolenheter is the case that states one: the reopened
 * draft is where a plan decided before the span existed is given its span.
 */
export function copySpanRequest(
  chosen: GradeSpan | null,
  source: GradeSpan | null,
): GradeSpan | null | undefined {
  return sameSpan(chosen, source) ? undefined : chosen;
}

/**
 * What the notice on a plan says when the plan's årskurser are not the
 * skolenheternas: the two spans, the plan's null when it is for the whole
 * form. Null when they agree, and when there is nothing to compare with (no
 * unit of the form, or units that hold no årskurs of it).
 *
 * Compared as the CHECK reads them, on the årskurser the form has: a unit that
 * runs F–6 and a plan for 1–6 judge the same årskurser, and F–9 against no span
 * is no difference.
 */
export function spanNotice(
  plan: GradeSpan | null,
  units: readonly SchoolUnit[] | undefined,
  version: SpanVersion,
): { plan: GradeSpan | null; units: GradeSpan } | null {
  if (!units) return null;
  const unit = unitSpanForForm(units, version.schoolForm, lydelseIsTioarig(version.appliesFromCohortTerm));
  if (!unit) return null;
  const theirs = clippedToForm(unit, version);
  if (!theirs) return null;
  const grades = formGrades(version);
  const whole = { gradeFrom: grades[0]!, gradeTo: grades[grades.length - 1]! };
  const ours = plan === null ? whole : clippedToForm(plan, version);
  return sameSpan(ours, theirs) ? null : { plan, units: unit };
}

/**
 * Whether a lydelse numbers its årskurser the way the plan's does, which a
 * plan with a span needs of its new lydelse: the span is stated in its
 * lydelse's numbering, and the gateway refuses to carry it over to the other
 * one without being told the new span.
 */
export function versionKeepsNumbering(from: string, to: string): boolean {
  return lydelseIsTioarig(from) === lydelseIsTioarig(to);
}

/** A translate function, as far as the span's texts need one. */
type Translate = (key: string, values?: Record<string, string | number>) => string;

/** "åk 4–9", "F–9" or "åk 9": the span in words, under the timplan namespace's spanRange / spanOne. */
export function spanText(t: Translate, span: GradeSpan): string {
  return span.gradeFrom === span.gradeTo
    ? t("spanOne", { grade: span.gradeFrom })
    : t("spanRange", { from: span.gradeFrom, to: span.gradeTo });
}
