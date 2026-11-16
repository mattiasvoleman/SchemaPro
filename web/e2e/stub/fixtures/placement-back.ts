import { YEAR } from "./world";

/**
 * The way back to the week (A3): what the stub says of the grundschema's förläggningar (the board's `timetable`) and which
 * scenarios hold a refused run. A scenario is named by the header the page sends (e2e/signed-in.ts askForScenario). The stub
 * remembers a write per scenario name (timplan-board.ts), so every test that writes or reads a state of its own takes a name of
 * its own: the cases here are `placement-write:back-<case>:<unique>`, which are the write family (the board remembers rows)
 * with a case in the name.
 *
 *   back-fresh      the grundschema holds the lessons of both rows (the default of every week scenario, so nothing is "changed")
 *   back-changed    the grundschema holds one lesson fewer than the rows: a row was laid after the run
 *   back-noschema   no run and nothing written: the first schema is still to come (the week's own sentence stands)
 *   back-refusal    the newest run was refused by name (misc-school.ts PLACEMENT_REFUSAL_JOB), with the grundschema as in back-fresh
 */
export const PLACEMENT_BACK_SCENARIO = "placement-write:back";

/** The scenario's case, or null for a scenario that is none of them. */
export const backCaseOf = (scenario: string | null): "fresh" | "changed" | "noschema" | "refusal" | null => {
  if (scenario === null || !scenario.startsWith(PLACEMENT_BACK_SCENARIO)) return null;
  const rest = scenario.slice(PLACEMENT_BACK_SCENARIO.length).replace(/^-/, "");
  for (const name of ["fresh", "changed", "noschema", "refusal"] as const) if (rest.startsWith(name)) return name;
  return "fresh";
};

/** When the stub's grundschema was written from the rows: after every row's changedAt (2026-11-13). */
const WRITTEN_AT = "2026-11-14T09:00:00.000Z";

/**
 * The board's `timetable`: how many lessons the grundschema holds from a förläggning and when the newest was written.
 * The week scenarios (A1, B2) and the write scenarios (A2) are given a grundschema that holds exactly their rows, so that the
 * week says nothing about a change in the tests that were written before the field.
 */
export function placementTimetable(yearId: string, scenario: string | null): { placedLessons: number; writtenAt: string | null } {
  if (yearId !== YEAR.id || scenario === null) return { placedLessons: 0, writtenAt: null };
  switch (backCaseOf(scenario)) {
    case "changed":
      return { placedLessons: 1, writtenAt: WRITTEN_AT };
    case "noschema":
      return { placedLessons: 0, writtenAt: null };
    case "fresh":
    case "refusal":
      return { placedLessons: 2, writtenAt: WRITTEN_AT };
    case null:
      break;
  }
  if (scenario === "placement-week-any-room") return { placedLessons: 4, writtenAt: WRITTEN_AT };
  if (scenario === "placement-week") return { placedLessons: 3, writtenAt: WRITTEN_AT };
  if (scenario.startsWith("placement-write")) return { placedLessons: 2, writtenAt: WRITTEN_AT };
  return { placedLessons: 0, writtenAt: null };
}
