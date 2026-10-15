import { percentSteps, postAtStart } from "@/lib/period-view";
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
  /**
   * Tjänst % (anställning) on the läsår's first day; null without a post. A
   * post that changes during the year is compared by where it starts, and
   * shown with its steps.
   */
  employmentPercent: number | null;
  /** The grad as it changes over the year, [100, 50]; one step all year; [] without a post. */
  employmentSteps: number[];
  /** Nedsättning % on the läsår's first day; 0 without a post. */
  reductionPercent: number;
  /**
   * The nedsättning as it changes over the year, each change once: [0, 20]
   * for one from January. One step all year; [] without a post. The row
   * shows the steps when there are several, so a post that is CHANGED by its
   * nedsättning alone says why.
   */
  reductionSteps: number[];
  /**
   * The post over the year, stretch by stretch: "grad/nedsättning" to three
   * decimals, each change once. What the CHANGED class compares, so a post
   * that halves in January, or gets a nedsättning from it, is a change even
   * where the year starts the same. [] without a post.
   */
  postSteps: string[];
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
  /** The nedsättning moved, both years having a row: the table has no column for it, so the row says it. */
  reductionChanged: boolean;
  change: ComparisonChange;
}

const thousandths = (value: number) => String(Math.round(value * 1000));

function figures(load: TeacherLoad): YearFigures {
  const start = postAtStart(load);
  const stretches = (load.periods?.length ?? 0) > 0 ? load.periods! : start ? [start] : [];
  const steps = (load.periods?.length ?? 0) > 0 ? percentSteps(load.periods!) : start ? [start.employmentPercent] : [];
  const postSteps: string[] = [];
  const reductionSteps: number[] = [];
  for (const stretch of stretches) {
    const step = `${thousandths(stretch.employmentPercent)}/${thousandths(stretch.reductionPercent)}`;
    if (postSteps[postSteps.length - 1] !== step) postSteps.push(step);
    const last = reductionSteps[reductionSteps.length - 1];
    if (last === undefined || thousandths(last) !== thousandths(stretch.reductionPercent)) {
      reductionSteps.push(stretch.reductionPercent);
    }
  }
  return {
    employmentPercent: start?.employmentPercent ?? null,
    employmentSteps: steps,
    reductionPercent: start?.reductionPercent ?? 0,
    reductionSteps,
    postSteps,
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
 * nedsättning or the counted minutes moved — the post and the nedsättning
 * over the whole year, stretch by stretch, not only where it starts; a
 * percent of target that moved only because the school's riktmärke did is
 * not a change of the teacher's.
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
    const reductionChanged =
      current !== null && previous !== null && !samePercent(current.reductionPercent, previous.reductionPercent);
    let change: ComparisonChange;
    if (!previous) change = "NEW";
    else if (!current) change = "LEFT";
    else
      change =
        countedDelta !== 0 || current.postSteps.join(" ") !== previous.postSteps.join(" ") ? "CHANGED" : "SAME";
    return { userId, lastYear: previous, thisYear: current, countedDelta, employmentDelta, reductionChanged, change };
  });
}
