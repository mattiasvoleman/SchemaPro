import type { ConflictDetail, TimeoutReport } from "@/lib/queries";

/*
 * THE CAUSE OF A RUN THAT RAN OUT OF TIME, as far as anything measured it (omgång 13, M2 Förklaringen när tiden tar slut).
 *
 * The engine answers a TIMEOUT with the rows it has always carried (what a probe found, which years the arithmetic found
 * tight) and, since M2, a report of where the time went. This reads the two together into a short list of causes, each of
 * which says HOW it is known:
 *
 *   RULES_MEASURED  a rule, switched off, let the week solve in a short probe: measured, not proved
 *   PROBE_CHANGED_WEEK  a probe that changes the week without lifting a rule (a teacher of its own on each shared group, the placed
 *                   lessons released) let it solve in a short probe: measured, not proved, and not a rule to relax
 *   TIGHT_WEEK      the year's least week is PROVED to be at least this part of its frame time: a lower bound
 *   SHORT_CLOCK     the search was given less than the engine is set to give it: a fact about this run
 *   SLOW_SETUP      the checks and the model builds took a large part of the run: a fact about this run
 *   NOTHING_FOUND   none of the above: said as exactly that, never guessed at
 *
 * THE FIGURES OF A TIGHT WEEK ARE LOWER BOUNDS, and nothing here ranks them. The count stops where it has decided whether a
 * year is above the threshold, so "94 %" may be where it stopped and not the year's own least week, and two years' percentages
 * are not comparable: the years are listed in grade order, never by weight, and a text never calls one the tightest. A year
 * that is not listed was NOT counted if the week load stopped at its deadline (`weekLoadCut`), which is not the same as being
 * under the threshold: the caveat is carried beside the causes and never turned into "no other year is tight".
 *
 * The order of the causes is the order of how well each is known (measured, proved, a fact), never a ranking of one
 * year or rule against another. Pure, and in a file of its own so that a test can read it without rendering the card.
 */

/** A year the arithmetic found tight: `grades` is the year, or "any" for the classes whose years are unknown. */
export interface TightYear {
  grades: string;
  /** Whole percent: a LOWER BOUND on the year's least week against its frame time. */
  percent: number;
}

export type TimeoutCause =
  | { kind: "RULES_MEASURED"; count: number }
  | { kind: "PROBE_CHANGED_WEEK"; count: number }
  | { kind: "TIGHT_WEEK"; years: TightYear[] }
  | { kind: "SHORT_CLOCK"; budgetSeconds: number; configuredBudgetSeconds: number; callerWaitSeconds: number | null }
  | { kind: "SLOW_SETUP"; setupSeconds: number; totalSeconds: number }
  | { kind: "NOTHING_FOUND" };

export interface TimeoutAccount {
  causes: TimeoutCause[];
  /** The year's week load stopped at its deadline before every year was counted: a year with no row was NOT counted. */
  weekLoadCut: boolean;
}

/** The search is called short of its time when it had this many seconds less than the engine is set to give it. */
export const SHORT_CLOCK_MIN_SECONDS = 5;

/** The setup is said when it took this share of the run, and at least `SLOW_SETUP_MIN_SECONDS`. */
export const SLOW_SETUP_SHARE = 0.25;
export const SLOW_SETUP_MIN_SECONDS = 10;

// The walk's planned-sites search (SITES) is a SEARCH, and the list above the cause names it as one ("Sökning med restid mellan
// skolområden"): counted here it would turn "the checks and the preparation took 75 s" into a sentence whose figure is not the
// sum of the two steps it names (5 s and 10 s).
const SETUP_STAGES: readonly string[] = ["PRECHECKS", "BUILD"];

// The steps that are searches: the same three the list above the sentence names as searches. `search.phases` has a phase for the two
// satisfaction searches only (the engine notes none for the walk's), so a sentence made of the phases says less than the list when
// the walk's search ran: "En sökning pågick i sammanlagt 30 s" under 60 s and 30 s.
// The years' road (YEARS, M8 PR 5) is a search too: the week laid a year at a time between the two. START (the schedule a week is laid from) is not.
const SEARCH_STAGES: readonly string[] = ["SITES", "SEARCH_CLEAN", "YEARS", "SEARCH_CLONE"];

/**
 * How many searches ran and for how long, counted from the same steps the list above the sentence shows. A search step that took no time
 * is not a search that ran: the walk's step is entered before the engine knows whether it has the seconds for the search (it returns at
 * once when the clock leaves under a second after the builds, and the report then reads "SITES 0 s" with no solve at all), and a sentence
 * that said "En sökning pågick i sammanlagt 0 s" of it would say a search began where "Ingen sökning hann börja" is the truth.
 */
export function searchesOf(report: TimeoutReport): { count: number; seconds: number } {
  const searches = report.stages.filter((stage) => SEARCH_STAGES.includes(stage.stage) && stage.seconds > 0);
  return {
    count: searches.length,
    seconds: Math.round(searches.reduce((sum, stage) => sum + stage.seconds, 0) * 10) / 10,
  };
}

const numberOf = (value: string | number | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** The years the arithmetic found tight, from the rows that say so, in grade order and each year once. */
function tightYearsOf(conflicts: readonly ConflictDetail[]): TightYear[] {
  const byGrades = new Map<string, number>();
  for (const row of conflicts) {
    if (row.code !== "TIGHT_WEEK_LOAD") continue;
    const grades = row.params?.grades;
    const percent = numberOf(row.params?.percent);
    if (typeof grades !== "string" || percent === null) continue;
    // A year counted in two weeks: the larger of two lower bounds is a lower bound too.
    byGrades.set(grades, Math.max(byGrades.get(grades) ?? 0, percent));
  }
  const order = (grades: string): number => {
    const year = Number(grades);
    return grades === "any" || !Number.isFinite(year) ? Number.POSITIVE_INFINITY : year;
  };
  return [...byGrades.entries()]
    .map(([grades, percent]) => ({ grades, percent }))
    .sort((a, b) => order(a.grades) - order(b.grades));
}

/**
 * The percent the week load counts against ("not the same as being under 85 %"), as the engine's own row says it, or null when
 * there is no such row or it carries no figure: the text does not write a threshold the engine has not named.
 */
export function weekLoadThresholdOf(conflicts: readonly ConflictDetail[]): number | null {
  for (const row of conflicts) {
    if (row.code !== "WEEK_LOAD_NOT_COUNTED") continue;
    const percent = numberOf(row.params?.percent);
    if (percent !== null) return percent;
  }
  return null;
}

/**
 * The rules a probe found that, relaxed, let the week solve: the probe's findings, never its "could not measure" row. A probe
 * that is not a rule lifted is another thing: the engine says a rule by `PROBE_SOLVED_WITHOUT_…`, and the two it says by
 * `PROBE_SOLVED_WITH_…` (a teacher of its own on each shared group with the groups run in one parallel block, and the placed lessons
 * released) change the week and drop no rule, so "en regel gjorde att veckan gick att lösa" and "lätta på regeln" are not true of them.
 */
function measuredRulesOf(conflicts: readonly ConflictDetail[]): number {
  return conflicts.filter((row) => row.category === "TIMEOUT_PROBE" && (row.code ?? "").startsWith("PROBE_SOLVED_WITHOUT_")).length;
}

/**
 * The probes that solved the week by changing it and not by lifting a rule (`PROBE_SOLVED_WITH_…`): the engine's own summary counts them
 * among "the rules" it names, and the rows under the card say what each changed, so a card that said "no cause could be measured" for a
 * week only such a probe solved would say less than the engine measured. Said as what they are, apart from the rules.
 */
function changedWeekProbesOf(conflicts: readonly ConflictDetail[]): number {
  return conflicts.filter((row) => {
    const code = row.code ?? "";
    return row.category === "TIMEOUT_PROBE" && code.startsWith("PROBE_SOLVED_") && !code.startsWith("PROBE_SOLVED_WITHOUT_");
  }).length;
}

export function timeoutAccountOf(report: TimeoutReport, conflicts: readonly ConflictDetail[]): TimeoutAccount {
  const causes: TimeoutCause[] = [];

  const rules = measuredRulesOf(conflicts);
  if (rules > 0) causes.push({ kind: "RULES_MEASURED", count: rules });

  const changed = changedWeekProbesOf(conflicts);
  if (changed > 0) causes.push({ kind: "PROBE_CHANGED_WEEK", count: changed });

  const years = tightYearsOf(conflicts);
  if (years.length > 0) causes.push({ kind: "TIGHT_WEEK", years });

  if (report.configuredBudgetSeconds - report.budgetSeconds >= SHORT_CLOCK_MIN_SECONDS) {
    causes.push({
      kind: "SHORT_CLOCK",
      budgetSeconds: report.budgetSeconds,
      configuredBudgetSeconds: report.configuredBudgetSeconds,
      callerWaitSeconds: report.callerWaitSeconds,
    });
  }

  const setupSeconds = report.stages
    .filter((stage) => SETUP_STAGES.includes(stage.stage))
    .reduce((sum, stage) => sum + stage.seconds, 0);
  if (report.totalSeconds > 0 && setupSeconds >= SLOW_SETUP_MIN_SECONDS && setupSeconds / report.totalSeconds >= SLOW_SETUP_SHARE) {
    causes.push({ kind: "SLOW_SETUP", setupSeconds: Math.round(setupSeconds * 10) / 10, totalSeconds: report.totalSeconds });
  }

  if (causes.length === 0) causes.push({ kind: "NOTHING_FOUND" });
  return { causes, weekLoadCut: report.weekLoadCut };
}
