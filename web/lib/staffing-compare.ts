import type { TeacherLoad } from "@/lib/teacher-load";

/*
 * "Jämför med förra läsåret" on /admin/staffing (staffing Fas 5): per teacher,
 * last year's tjänst and counted minutes beside this year's.
 *
 * Both sides are the gateway's own report, GET /staffing/load, once per year
 * — so this file joins and subtracts, and never recomputes a load. The join
 * is the UNION of the two years' teachers: one who has left is a row with
 * nothing this year, a new one a row with nothing last year, and neither is
 * silently dropped, because "who is gone" is half of what the comparison is
 * for.
 */

export interface YearFigures {
  /** Tjänst % (anställning); null without a post. */
  employmentPercent: number | null;
  /** Nedsättning %; 0 without a post. */
  reductionPercent: number;
  /** Teaching plus counted uppdrag, standardvecka — what the target is compared with. */
  countedMinutesPerWeek: number;
  percentOfTarget: number | null;
}

export type ComparisonChange = "NEW" | "LEFT" | "CHANGED" | "SAME";

export interface ComparisonRow {
  userId: string;
  lastYear: YearFigures | null;
  thisYear: YearFigures | null;
  /** this − last counted minutes; null when either side is missing. */
  countedDelta: number | null;
  /** this − last tjänst %; null when either side has no post. */
  employmentDelta: number | null;
  change: ComparisonChange;
}

function figures(load: TeacherLoad): YearFigures {
  return {
    employmentPercent: load.employment?.employmentPercent ?? null,
    reductionPercent: load.employment?.reductionPercent ?? 0,
    countedMinutesPerWeek: load.countedMinutesPerWeek,
    percentOfTarget: load.percentOfTarget,
  };
}

/** Three decimals, as the gateway stores a percent: 50.0004 is not a change. */
const samePercent = (a: number | null, b: number | null) =>
  a === null || b === null ? a === b : Math.round(a * 1000) === Math.round(b * 1000);

/**
 * The two years' teachers side by side, sorted by userId (the page sorts by
 * name, which only it can resolve). A teacher is CHANGED when the post, the
 * nedsättning or the counted minutes moved; a percent of target that moved
 * only because the school's riktmärke did is not a change of the teacher's.
 */
export function compareYears(
  thisYear: readonly TeacherLoad[],
  lastYear: readonly TeacherLoad[],
): ComparisonRow[] {
  const now = new Map(thisYear.map((row) => [row.userId, figures(row)]));
  const then = new Map(lastYear.map((row) => [row.userId, figures(row)]));
  const ids = [...new Set([...now.keys(), ...then.keys()])].sort();
  return ids.map((userId) => {
    const current = now.get(userId) ?? null;
    const previous = then.get(userId) ?? null;
    const countedDelta =
      current && previous ? current.countedMinutesPerWeek - previous.countedMinutesPerWeek : null;
    const employmentDelta =
      current?.employmentPercent != null && previous?.employmentPercent != null
        ? Math.round((current.employmentPercent - previous.employmentPercent) * 1000) / 1000
        : null;
    let change: ComparisonChange;
    if (!previous) change = "NEW";
    else if (!current) change = "LEFT";
    else
      change =
        countedDelta !== 0 ||
        !samePercent(current.employmentPercent, previous.employmentPercent) ||
        !samePercent(current.reductionPercent, previous.reductionPercent)
          ? "CHANGED"
          : "SAME";
    return { userId, lastYear: previous, thisYear: current, countedDelta, employmentDelta, change };
  });
}
