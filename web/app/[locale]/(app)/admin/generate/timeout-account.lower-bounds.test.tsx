import { cleanup, render } from "@testing-library/react";
import { IntlMessageFormat } from "intl-messageformat";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import type { ConflictDetail, TimeoutReport } from "@/lib/queries";
import { TimeoutAccount } from "./timeout-account";

/*
 * THE LOWER-BOUND TRAP, PLANTED AND READ AS A SCHOOL READS IT (omgång 13, M2, granskningen av #378). The week load's percentage is a
 * proved LOWER bound, and a year the count did not reach is NOT counted: so every percent on the card says "minst"/"at least", the
 * years come in grade order whatever order the engine's rows came in, a cut count never becomes "no other year is tight", and a
 * refusal's rows (which belong to a run that never times out) are not drawn as a tight week. The other card tests echo keys; this
 * renders the real Swedish and English into the DOM.
 */

const locale = vi.hoisted(() => ({ current: "sv" as "sv" | "en" }));
vi.mock("next-intl", () => ({
  useLocale: () => locale.current,
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) => {
    let node: unknown = locale.current === "sv" ? sv : en;
    for (const part of `${namespace}.${key}`.split(".")) node = (node as Record<string, unknown>)[part];
    return String(new IntlMessageFormat(node as string, locale.current).format(values as never));
  },
}));

afterEach(cleanup);

const report = (over: Partial<TimeoutReport> = {}): TimeoutReport => ({
  totalSeconds: 190,
  budgetSeconds: 180,
  configuredBudgetSeconds: 180,
  callerWaitSeconds: 240,
  stages: [
    { stage: "PRECHECKS", seconds: 1 },
    { stage: "BUILD", seconds: 8 },
    { stage: "SEARCH_CLEAN", seconds: 60 },
    { stage: "SEARCH_CLONE", seconds: 110 },
    { stage: "PROBE", seconds: 11 },
  ],
  search: { solutions: 0, phases: [{ phase: "CLEAN", seconds: 60, conflicts: 5, branches: 9 }, { phase: "CLONE", seconds: 110, conflicts: 7, branches: 11 }] },
  weekLoadCut: false,
  ...over,
});

const tight = (grades: string, percent: number): ConflictDetail => ({
  category: "REQUIREMENT_DEMAND",
  code: "TIGHT_WEEK_LOAD",
  message: "…",
  params: { grades, demandMinutes: 2000, capacityMinutes: 2300, percent },
  resourceNames: [],
});

/** What the card says, as one string per paragraph and list item. */
const said = (loc: "sv" | "en", rep: TimeoutReport, conflicts: ConflictDetail[]): string => {
  locale.current = loc;
  const { container } = render(<TimeoutAccount report={rep} conflicts={conflicts} />);
  return Array.from(container.querySelectorAll("p, li, summary, h3, h4"))
    .map((node) => node.textContent ?? "")
    .join("\n");
};

const AT_LEAST = { sv: /minst/i, en: /at least/i };
const NO_OTHER_YEAR = /inga andra|övriga (år|årskurser)|alla andra|no other year|other years are|all other years|the rest are/i;
const RANKING = /trängst|värst|fullast|mest full|tightest|worst|heaviest|most full/i;

describe.each(["sv", "en"] as const)("the card in %s", (loc) => {
  it("says every percent of a tight year as a lower bound, in grade order, whatever order the rows came in", () => {
    const heaviestFirst = said(loc, report(), [tight("9", 97), tight("any", 90), tight("7", 88)]);
    const lightestFirst = said(loc, report(), [tight("7", 88), tight("any", 90), tight("9", 97)]);

    expect(heaviestFirst).toBe(lightestFirst);
    const years = heaviestFirst.split("\n").filter((line) => /\d+ %$/.test(line) && !/85/.test(line) && !/^\s*$/.test(line));
    expect(years.map((line) => line.match(/(\d+) %$/)?.[1])).toEqual(["88", "97", "90"]);
    for (const line of years) expect(line).toMatch(AT_LEAST[loc]);
    expect(heaviestFirst).not.toMatch(RANKING);
  });

  it("says no percent at all without 'at least' or 'under the threshold': a figure is a bound or it is not on the card", () => {
    for (const text of [
      said(loc, report(), [tight("8", 91)]),
      said(loc, report({ weekLoadCut: true }), [tight("8", 91)]),
      said(loc, report({ weekLoadCut: true }), []),
    ]) {
      for (const line of text.split("\n")) {
        if (!/%/.test(line)) continue;
        // The threshold the count compares with, named only to say what a year with no figure is not.
        expect(line).toMatch(/minst|at least|85 %/i);
      }
    }
  });

  it("says a cut count as 'not counted' beside a tight year, and never as 'no other year is tight'", () => {
    const text = said(loc, report({ weekLoadCut: true }), [tight("8", 91)]);
    expect(text).toMatch(loc === "sv" ? /inte räknad/ : /not counted/);
    expect(text).not.toMatch(NO_OTHER_YEAR);
  });

  it("says a cut count with nothing else found as that, not as a week with no tight year", () => {
    const text = said(loc, report({ weekLoadCut: true }), []);
    expect(text).toMatch(loc === "sv" ? /inte räknad/ : /not counted/);
    expect(text).not.toMatch(NO_OTHER_YEAR);
    expect(text).not.toMatch(/trång|tight week|The week is tight/i);
  });

  it("names the threshold of a cut count from the engine's own row, and writes none when the row names none", () => {
    const row = (percent: number): ConflictDetail => ({
      category: "REQUIREMENT_DEMAND",
      code: "WEEK_LOAD_NOT_COUNTED",
      message: "…",
      params: { seconds: 4, percent },
      resourceNames: [],
    });
    const named = said(loc, report({ weekLoadCut: true }), [row(90)]);
    expect(named).toMatch(/under 90 %/);
    expect(named).not.toMatch(/85/);
    const unnamed = said(loc, report({ weekLoadCut: true }), []);
    expect(unnamed).not.toMatch(/\d+ %/);
    expect(unnamed).toMatch(loc === "sv" ? /inte räknad/ : /not counted/);
  });

  it("does not draw a refusal's rows as a tight week", () => {
    const refusal: ConflictDetail[] = [
      {
        category: "REQUIREMENT_DEMAND",
        code: "DEMAND_REQUIREMENTS_EXCEED_WEEK",
        message: "…",
        params: { requirements: 9, demandMinutes: 2400, capacityMinutes: 2300 },
        resourceNames: [],
      },
      {
        category: "REQUIREMENT_DEMAND",
        code: "DEMAND_YEAR_WEEK_SHORT",
        message: "…",
        // A figure over 100 % is the proof that the week has no timetable (a refusal), never a "tight" week: even with a percent
        // beside its year, a row of another code is not one of the years the arithmetic found tight.
        params: { grades: "9", demandMinutes: 2400, capacityMinutes: 2300, percent: 104, shared: "none" },
        resourceNames: [],
      },
    ];
    const text = said(loc, report(), refusal);
    expect(text).not.toMatch(/\d+ %/);
    expect(text).not.toMatch(loc === "sv" ? /Åk 9/ : /Year 9/);
  });
});
