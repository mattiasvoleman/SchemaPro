import { cleanup, render, screen, within } from "@testing-library/react";
import { IntlMessageFormat } from "intl-messageformat";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import type { ConflictDetail, TimeoutReport } from "@/lib/queries";
import { TimeoutAccount } from "./timeout-account";

/*
 * WHAT A RUN THAT RAN OUT OF TIME SAYS FOR ITSELF (omgång 13, M2). The stub echoes a sentence's key and its figures in the order
 * the card passes them; the second half formats the real Swedish and English texts, so that a word a school reads is checked.
 */

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) =>
    values ? `${namespace}.${key}(${Object.values(values).join("|")})` : `${namespace}.${key}`,
}));

afterEach(cleanup);

const NS = "generate.timeoutAccount";

const report = (over: Partial<TimeoutReport> = {}): TimeoutReport => ({
  totalSeconds: 109,
  budgetSeconds: 100,
  configuredBudgetSeconds: 100,
  callerWaitSeconds: null,
  stages: [
    { stage: "PRECHECKS", seconds: 0.4 },
    { stage: "BUILD", seconds: 4 },
    { stage: "SEARCH_CLEAN", seconds: 60 },
    { stage: "SEARCH_CLONE", seconds: 40 },
    { stage: "PROBE", seconds: 5 },
  ],
  search: {
    solutions: 0,
    phases: [
      { phase: "CLEAN", seconds: 60, conflicts: 118344, branches: 920113 },
      { phase: "CLONE", seconds: 40, conflicts: null, branches: null },
    ],
  },
  weekLoadCut: false,
  ...over,
});

const tight = (grades: string, percent: number): ConflictDetail => ({
  category: "REQUIREMENT_DEMAND",
  code: "TIGHT_WEEK_LOAD",
  message: "…",
  params: { grades, demandMinutes: 2120, capacityMinutes: 2275, percent },
  resourceNames: [],
});

describe("TimeoutAccount", () => {
  it("lists every step with its seconds as text, and the bar beside it is a picture only", () => {
    const { container } = render(<TimeoutAccount report={report()} conflicts={[]} />);

    for (const [stage, seconds] of [["PRECHECKS", 0.4], ["BUILD", 4], ["SEARCH_CLEAN", 60], ["SEARCH_CLONE", 40], ["PROBE", 5]] as const) {
      expect(screen.getByText(`${NS}.stage(${stage}|${seconds})`)).toBeInTheDocument();
    }
    expect(screen.getByText(`${NS}.total(109)`)).toBeInTheDocument();
    expect(container.querySelector('[aria-hidden="true"].flex')).not.toBeNull();
  });

  it("says how far the search got: that none of its searches found a timetable, and how long they ran", () => {
    render(<TimeoutAccount report={report()} conflicts={[]} />);

    expect(screen.getByText(`${NS}.searchNone(2|100)`)).toBeInTheDocument();
    // Never a share of the way: a search for a timetable has no bound.
    expect(screen.queryByText(/%/)).toBeNull();
  });

  it("says a search that never began as that", () => {
    render(<TimeoutAccount report={report({ search: { solutions: 0, phases: [] }, stages: [{ stage: "BUILD", seconds: 20 }] })} conflicts={[]} />);

    expect(screen.getByText(`${NS}.searchNotRun`)).toBeInTheDocument();
  });

  it("counts the walk's search with the others, so the sentence never says less than the list above it (60 s and 30 s are 90 s)", () => {
    // The walk's planned-sites search has no phase (the engine notes one only for the two satisfaction searches), but the list names it
    // as a search with its seconds: the sentence under "Hur långt sökningen kom" is made of the same steps.
    render(
      <TimeoutAccount
        report={report({
          stages: [
            { stage: "PRECHECKS", seconds: 1 },
            { stage: "SITES", seconds: 60 },
            { stage: "SEARCH_CLEAN", seconds: 30 },
          ],
          search: { solutions: 0, phases: [{ phase: "CLEAN", seconds: 30, conflicts: 5, branches: 9 }] },
        })}
        conflicts={[]}
      />,
    );

    expect(screen.getByText(`${NS}.stage(SITES|60)`)).toBeInTheDocument();
    expect(screen.getByText(`${NS}.stage(SEARCH_CLEAN|30)`)).toBeInTheDocument();
    expect(screen.getByText(`${NS}.searchNone(2|90)`)).toBeInTheDocument();
    expect(screen.queryByText(`${NS}.searchNone(1|30)`)).toBeNull();
  });

  it("does not say that no search began when only the walk's search ran", () => {
    render(
      <TimeoutAccount
        report={report({
          stages: [{ stage: "BUILD", seconds: 20 }, { stage: "SITES", seconds: 60 }],
          search: { solutions: 0, phases: [] },
        })}
        conflicts={[]}
      />,
    );

    expect(screen.queryByText(`${NS}.searchNotRun`)).toBeNull();
    expect(screen.getByText(`${NS}.searchNone(1|60)`)).toBeInTheDocument();
  });

  it("says that no search began when the walk's step took no time and nothing else searched", () => {
    render(
      <TimeoutAccount
        report={report({
          stages: [{ stage: "BUILD", seconds: 9.8 }, { stage: "SITES", seconds: 0 }, { stage: "PROBE", seconds: 0 }],
          search: { solutions: 0, phases: [] },
        })}
        conflicts={[]}
      />,
    );

    expect(screen.getByText(`${NS}.searchNotRun`)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(`^${NS.replace(".", "\\.")}\\.searchNone`))).toBeNull();
  });

  it("does not say that no search began when the seconds went to steps the gateway has no name for (g458)", () => {
    // An engine newer than the gateway: its YEARS step (a search) was left out of `stages`, and its seconds are `otherSeconds`.
    const { container } = render(
      <TimeoutAccount
        report={report({
          totalSeconds: 99.4,
          stages: [{ stage: "PRECHECKS", seconds: 0.4 }, { stage: "BUILD", seconds: 4 }, { stage: "PROBE", seconds: 5 }],
          otherSeconds: 90,
          search: { solutions: 0, phases: [] },
        })}
        conflicts={[]}
      />,
    );

    expect(screen.queryByText(`${NS}.searchNotRun`)).toBeNull();
    expect(screen.getByText(`${NS}.otherSteps(90)`)).toBeInTheDocument();
    expect(screen.getByText(`${NS}.searchOther(90)`)).toBeInTheDocument();
    // The bar is a picture of the whole run: the probe's 5 s of 99.4 is a twentieth of it, not half.
    const widths = [...container.querySelectorAll('[aria-hidden="true"].flex > div')].map((bar) => parseFloat((bar as HTMLElement).style.width));
    expect(widths).toHaveLength(4);
    expect(widths[2]).toBeCloseTo((5 / 99.4) * 100, 1);
    expect(widths.reduce((sum, width) => sum + width, 0)).toBeCloseTo(100, 5);
  });

  it("says a search that did run, and the seconds the gateway has no name for beside it", () => {
    render(<TimeoutAccount report={report({ otherSeconds: 30 })} conflicts={[]} />);

    expect(screen.getByText(`${NS}.searchNone(2|100)`)).toBeInTheDocument();
    expect(screen.getByText(`${NS}.searchOther(30)`)).toBeInTheDocument();
    expect(screen.getByText(`${NS}.otherSteps(30)`)).toBeInTheDocument();
  });

  it("says nothing of steps it has no name for when there were none", () => {
    render(<TimeoutAccount report={report()} conflicts={[]} />);

    expect(screen.queryByText(new RegExp(`^${NS.replace(".", "\\.")}\\.(otherSteps|searchOther)`))).toBeNull();
  });

  it("says what the search was given, and against what the engine is set to give it when it was less", () => {
    const { rerender } = render(<TimeoutAccount report={report()} conflicts={[]} />);
    expect(screen.getByText(`${NS}.budget(100)`)).toBeInTheDocument();

    rerender(<TimeoutAccount report={report({ budgetSeconds: 94, configuredBudgetSeconds: 180 })} conflicts={[]} />);
    expect(screen.getByText(`${NS}.budgetShort(94|180)`)).toBeInTheDocument();
  });

  it("names the cause, and gives each cause its own next step", () => {
    render(<TimeoutAccount report={report()} conflicts={[tight("7", 94)]} />);

    const cause = screen.getByRole("heading", { name: `${NS}.causeTitle` }).parentElement as HTMLElement;
    const next = screen.getByRole("heading", { name: `${NS}.nextTitle` }).parentElement as HTMLElement;
    expect(within(cause).getByText(`${NS}.cause.TIGHT_WEEK`, { exact: false })).toBeInTheDocument();
    expect(within(next).getByText(`${NS}.next.TIGHT_WEEK`)).toBeInTheDocument();
  });

  it("lists the tight years in grade order with 'at least', and says the figures are lower limits", () => {
    render(<TimeoutAccount report={report()} conflicts={[tight("9", 97), tight("7", 91), tight("any", 88)]} />);

    const years = screen.getAllByText(new RegExp(`^${NS.replace(".", "\\.")}\\.tightYear\\(`)).map((node) => node.textContent);
    expect(years).toEqual([`${NS}.tightYear(7|91)`, `${NS}.tightYear(9|97)`, `${NS}.tightYear(any|88)`]);
    expect(screen.getByText(`${NS}.tightYearsBound`)).toBeInTheDocument();
  });

  const notCounted = (percent?: number): ConflictDetail => ({
    category: "REQUIREMENT_DEMAND",
    code: "WEEK_LOAD_NOT_COUNTED",
    message: "…",
    params: percent === undefined ? { seconds: 4 } : { seconds: 4, percent },
    resourceNames: [],
  });

  it("says a week load that was cut short against the threshold the engine's own row names, and never that no other year is tight", () => {
    render(<TimeoutAccount report={report({ weekLoadCut: true })} conflicts={[notCounted(90)]} />);

    expect(screen.getByText(`${NS}.weekLoadCut(90)`)).toBeInTheDocument();
    expect(screen.queryByText(/noOtherYear|inga andra/i)).toBeNull();
  });

  it("does not write a threshold of its own when the engine's row does not say one", () => {
    const { rerender } = render(<TimeoutAccount report={report({ weekLoadCut: true })} conflicts={[]} />);
    expect(screen.getByText(`${NS}.weekLoadCutPlain`)).toBeInTheDocument();

    rerender(<TimeoutAccount report={report({ weekLoadCut: true })} conflicts={[notCounted()]} />);
    expect(screen.getByText(`${NS}.weekLoadCutPlain`)).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(`^${NS.replace(".", "\\.")}\\.weekLoadCut\\(`))).toBeNull();
  });

  it("writes the threshold of a row that says 0 as 0, and not as a row with no figure", () => {
    render(<TimeoutAccount report={report({ weekLoadCut: true })} conflicts={[notCounted(0)]} />);
    expect(screen.getByText(`${NS}.weekLoadCut(0)`)).toBeInTheDocument();
    expect(screen.queryByText(`${NS}.weekLoadCutPlain`)).toBeNull();
  });

  it("says nothing of a cut count that did not happen", () => {
    render(<TimeoutAccount report={report()} conflicts={[notCounted(90)]} />);

    expect(screen.queryByText(new RegExp(`^${NS.replace(".", "\\.")}\\.weekLoadCut`))).toBeNull();
  });

  it("says nothing of the caller's wait in the fold when the request did not say one", () => {
    render(<TimeoutAccount report={report({ callerWaitSeconds: null })} conflicts={[]} />);

    const fold = screen.getByText(`${NS}.technicalTitle`).closest("details") as HTMLElement;
    expect(within(fold).queryByText(new RegExp(`^${NS.replace(".", "\\.")}\\.callerWait`))).toBeNull();
    expect(within(fold).getByText(`${NS}.configured(100|100)`)).toBeInTheDocument();
  });

  it("keeps the solver's own counts in a fold, with what they do not mean said beside them", () => {
    render(<TimeoutAccount report={report({ callerWaitSeconds: 94 })} conflicts={[]} />);

    const fold = screen.getByText(`${NS}.technicalTitle`).closest("details") as HTMLElement;
    expect(fold).not.toHaveAttribute("open");
    expect(within(fold).getByText(`${NS}.technicalNote`)).toBeInTheDocument();
    expect(within(fold).getByText(`${NS}.phase(CLEAN|60|118344|920113)`)).toBeInTheDocument();
    // A search CP-SAT gave no figures for says so and makes none up.
    expect(within(fold).getByText(`${NS}.phaseNoFigures(CLONE|40)`)).toBeInTheDocument();
    expect(within(fold).getByText(`${NS}.callerWait(94)`)).toBeInTheDocument();
    expect(within(fold).getByText(`${NS}.configured(100|100)`)).toBeInTheDocument();
  });

  it.each([
    ["both missing", { conflicts: undefined, branches: undefined }],
    ["the conflicts missing", { conflicts: undefined, branches: 920113 }],
    ["the branches missing", { conflicts: 118344, branches: undefined }],
  ])("says a search with no figures as that when the gateway leaves a count out altogether (%s), as it does for null", (_name, counts) => {
    // The gateway turns a missing count into null (countOrNull); a gateway that did not would send nothing, and the sentence with a
    // number in it cannot be formatted without one.
    const phase = { phase: "CLONE" as const, seconds: 40, ...counts } as unknown as TimeoutReport["search"]["phases"][number];
    render(<TimeoutAccount report={report({ search: { solutions: 0, phases: [phase] } })} conflicts={[]} />);

    const fold = screen.getByText(`${NS}.technicalTitle`).closest("details") as HTMLElement;
    expect(within(fold).getByText(`${NS}.phaseNoFigures(CLONE|40)`)).toBeInTheDocument();
    expect(within(fold).queryByText(new RegExp(`^${NS.replace(".", "\\.")}\\.phase\\(`))).toBeNull();
  });

  it("says a search with a count of zero as figures, and not as a search with none", () => {
    render(
      <TimeoutAccount report={report({ search: { solutions: 0, phases: [{ phase: "CLEAN", seconds: 1, conflicts: 0, branches: 0 }] } })} conflicts={[]} />,
    );

    expect(screen.getByText(`${NS}.phase(CLEAN|1|0|0)`)).toBeInTheDocument();
  });

  it("names a short clock with the caller's wait where it has one, and without it where it has not", () => {
    const { rerender } = render(
      <TimeoutAccount report={report({ budgetSeconds: 94, configuredBudgetSeconds: 180, callerWaitSeconds: 99 })} conflicts={[]} />,
    );
    expect(screen.getByText(`${NS}.cause.SHORT_CLOCK_WAIT(94|180|99)`)).toBeInTheDocument();

    rerender(<TimeoutAccount report={report({ budgetSeconds: 94, configuredBudgetSeconds: 180 })} conflicts={[]} />);
    expect(screen.getByText(`${NS}.cause.SHORT_CLOCK(94|180)`)).toBeInTheDocument();
  });
});

describe("the texts a school reads", () => {
  const texts = (messages: unknown): Record<string, unknown> =>
    (messages as { generate: { timeoutAccount: Record<string, unknown> } }).generate.timeoutAccount;
  const say = (messages: unknown, locale: string, path: string[], values: Record<string, unknown> = {}): string => {
    let node: unknown = texts(messages);
    for (const key of path) node = (node as Record<string, unknown>)[key];
    return String(new IntlMessageFormat(node as string, locale).format(values));
  };

  it("says a tight year as at least, in both languages", () => {
    expect(say(sv, "sv", ["tightYear"], { grades: "7", percent: 94 })).toBe("Åk 7: minst 94 %");
    expect(say(sv, "sv", ["tightYear"], { grades: "any", percent: 88 })).toBe("Klasser med okänd årskurs: minst 88 %");
    expect(say(en, "en", ["tightYear"], { grades: "7", percent: 94 })).toBe("Year 7: at least 94 %");
  });

  it("says the lower-bound caveat and the cut count, in words a school can read", () => {
    expect(say(sv, "sv", ["tightYearsBound"])).toContain("minst-tal");
    expect(say(sv, "sv", ["tightYearsBound"])).toContain("går inte att jämföra");
    expect(say(sv, "sv", ["weekLoadCut"], { percent: 85 })).toContain("är inte räknad");
    expect(say(en, "en", ["weekLoadCut"], { percent: 85 })).toContain("was not counted");
    expect(say(sv, "sv", ["weekLoadCutPlain"])).toContain("är inte räknad");
    expect(say(en, "en", ["weekLoadCutPlain"])).toContain("was not counted");
  });

  it("says the threshold the engine's row names, and a sentence with no figure when the row names none", () => {
    expect(say(sv, "sv", ["weekLoadCut"], { percent: 90 })).toMatch(/under 90 %\.$/);
    expect(say(en, "en", ["weekLoadCut"], { percent: 90 })).toMatch(/under 90 %\.$/);
    for (const [messages, locale] of [[sv, "sv"], [en, "en"]] as const) {
      expect(say(messages, locale, ["weekLoadCut"], { percent: 90 }), locale).not.toContain("85");
      expect(say(messages, locale, ["weekLoadCutPlain"]), locale).not.toMatch(/\d/);
    }
  });

  it("says each step in a school's words, with its seconds in the reader's own notation", () => {
    expect(say(sv, "sv", ["stage"], { stage: "SEARCH_CLONE", seconds: 112.1 })).toBe("Andra sökningen: 112,1 s");
    expect(say(sv, "sv", ["stage"], { stage: "PRECHECKS", seconds: 0.4 })).toBe("Kontroller före sökningen: 0,4 s");
    expect(say(en, "en", ["stage"], { stage: "SEARCH_CLEAN", seconds: 60 })).toBe("The first search: 60 s");
    expect(say(sv, "sv", ["stage"], { stage: "SOMETHING_NEW", seconds: 1 })).toBe("Ett steg: 1 s");
  });

  it("has words for the step that reads the schedule a week starts from (START) and for the search year by year (YEARS), in both languages (G6b)", () => {
    expect(say(sv, "sv", ["stage"], { stage: "START", seconds: 1.5 })).toBe("Läsningen av schemat veckan utgår från: 1,5 s");
    expect(say(sv, "sv", ["stage"], { stage: "YEARS", seconds: 40 })).toBe("Sökningen årskurs för årskurs: 40 s");
    expect(say(en, "en", ["stage"], { stage: "START", seconds: 1.5 })).toBe("Reading the schedule the week starts from: 1.5 s");
    expect(say(en, "en", ["stage"], { stage: "YEARS", seconds: 40 })).toBe("The search year by year: 40 s");
  });

  it("says how many searches and for how long, singular and plural", () => {
    expect(say(sv, "sv", ["searchNone"], { count: 1, seconds: 60 })).toBe("En sökning pågick i sammanlagt 60 s, och ingen hittade ett schema.");
    expect(say(sv, "sv", ["searchNone"], { count: 2, seconds: 100 })).toBe("2 sökningar pågick i sammanlagt 100 s, och ingen hittade ett schema.");
  });

  it("says a short clock with its three figures, and never asks a school to raise the engine's time limit", () => {
    expect(say(sv, "sv", ["cause", "SHORT_CLOCK_WAIT"], { budget: 94, configured: 180, wait: 99 })).toBe(
      "Sökningen fick 94 s av de 180 s som motorn är inställd på. Tjänsten väntade 99 s på svaret.",
    );
    for (const messages of [sv, en]) {
      const every = JSON.stringify(texts(messages));
      expect(every).not.toMatch(/höja lösarens tidsgräns|raise the solver time limit|administratör/i);
    }
  });

  it("does not name the caller's wait as the reason when the wait is longer than the engine needs (the production settings)", () => {
    // Engine 180 s + probe 20 s + 30 s of headroom = a ceiling of 230 s; the gateway waits 240 s and sends deadlineSeconds 240, always.
    // With 45 s of builds the search is given 167 s of 180 and the report says callerWaitSeconds 240: the wait did not shorten
    // anything, the builds did, and the report cannot tell the two apart, so the sentence states the figures and no cause.
    for (const [messages, locale] of [[sv, "sv"], [en, "en"]] as const) {
      const sentence = say(messages, locale, ["cause", "SHORT_CLOCK_WAIT"], { budget: 167, configured: 180, wait: 240 });
      expect(sentence).toContain("167");
      expect(sentence).toContain("180");
      expect(sentence).toContain("240");
      expect(sentence).not.toMatch(/eftersom|because|måste komma|had to come/i);
    }
  });

  it("has every cause, in both languages, with a sentence and a next step", () => {
    for (const messages of [sv, en]) {
      for (const kind of ["RULES_MEASURED", "PROBE_CHANGED_WEEK", "TIGHT_WEEK", "SHORT_CLOCK", "SLOW_SETUP", "NOTHING_FOUND"]) {
        expect(typeof (texts(messages).next as Record<string, unknown>)[kind]).toBe("string");
      }
      for (const kind of ["RULES_MEASURED", "PROBE_CHANGED_WEEK", "TIGHT_WEEK", "SHORT_CLOCK", "SHORT_CLOCK_WAIT", "SLOW_SETUP", "NOTHING_FOUND"]) {
        expect(typeof (texts(messages).cause as Record<string, unknown>)[kind]).toBe("string");
      }
    }
  });

  it("says the hint of a run with no account without the advice nobody could follow", () => {
    const hint = (messages: unknown) => (messages as { generate: { timeoutHint: string } }).generate.timeoutHint;
    expect(hint(sv)).not.toContain("administratör");
    expect(hint(en)).not.toContain("administrator");
    expect(hint(sv)).toContain("försök köra igen");
  });

  it("says no word of a ranking: the tight years are never 'the tightest' or 'the worst'", () => {
    for (const messages of [sv, en]) {
      expect(JSON.stringify(texts(messages))).not.toMatch(/trängst|värst|tightest|worst|most full|fullast/i);
    }
  });
});
