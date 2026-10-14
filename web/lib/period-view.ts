import type { PeriodLoad, TeacherLoad } from "@/lib/teacher-load";

/*
 * A post that changes during the year (20261022120000), as the screens and
 * the files say it. The figures are the report's stretches (PeriodLoad);
 * this only decides what a stretch is called.
 */

/**
 * Whether a stretch is judged at all: it holds a whole week (effectiveFrom)
 * and some week of it is taught (teachingWeeks). One that is not — a period
 * that holds no Monday, or weeks that are all lov — has no verdict: its 0
 * minutes are no "under mål", and it says "ingen undervisningsvecka".
 */
export function isJudged(period: Pick<PeriodLoad, "effectiveFrom" | "teachingWeeks">): boolean {
  return period.effectiveFrom !== null && period.teachingWeeks > 0;
}

/**
 * The tjänstgöringsgrad as it changes over the year, in date order, each
 * change once: [100, 50] for a post at half time from the spring, [100] for
 * one whose periods change only the nedsättning or the target.
 */
export function percentSteps(periods: readonly Pick<PeriodLoad, "employmentPercent">[]): number[] {
  const steps: number[] = [];
  for (const period of periods) {
    if (steps[steps.length - 1] !== period.employmentPercent) steps.push(period.employmentPercent);
  }
  return steps;
}

/**
 * The tjänstgöringsgrad over a range of days — a reconciliation's — as its
 * steps: those of the stretches the range touches, or the post's own for one
 * the same all year. Empty without a post.
 */
export function percentStepsIn(
  load: Pick<TeacherLoad, "employment" | "periods">,
  from: string,
  to: string,
): number[] {
  const touching = (load.periods ?? []).filter((period) => period.from <= to && period.to >= from);
  if (touching.length > 0) return percentSteps(touching);
  return load.employment ? [load.employment.employmentPercent] : [];
}

/**
 * The post on the läsår's first day: the first stretch's grad and
 * nedsättning for a post that changes during the year, the post's own
 * otherwise. Null without a post.
 */
export function postAtStart(
  load: Pick<TeacherLoad, "employment" | "periods">,
): { employmentPercent: number; reductionPercent: number } | null {
  if (!load.employment) return null;
  const first = load.periods?.[0] ?? load.employment;
  return { employmentPercent: first.employmentPercent, reductionPercent: first.reductionPercent };
}
