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

  it("says a week load that was cut short, and never that no other year is tight", () => {
    render(<TimeoutAccount report={report({ weekLoadCut: true })} conflicts={[]} />);

    expect(screen.getByText(`${NS}.weekLoadCut`)).toBeInTheDocument();
    expect(screen.queryByText(/noOtherYear|inga andra/i)).toBeNull();
  });

  it("says nothing of a cut count that did not happen", () => {
    render(<TimeoutAccount report={report()} conflicts={[]} />);

    expect(screen.queryByText(`${NS}.weekLoadCut`)).toBeNull();
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
    expect(say(sv, "sv", ["weekLoadCut"])).toContain("är inte räknad");
    expect(say(en, "en", ["weekLoadCut"])).toContain("was not counted");
  });

  it("says each step in a school's words, with its seconds in the reader's own notation", () => {
    expect(say(sv, "sv", ["stage"], { stage: "SEARCH_CLONE", seconds: 112.1 })).toBe("Andra sökningen: 112,1 s");
    expect(say(sv, "sv", ["stage"], { stage: "PRECHECKS", seconds: 0.4 })).toBe("Kontroller före sökningen: 0,4 s");
    expect(say(en, "en", ["stage"], { stage: "SEARCH_CLEAN", seconds: 60 })).toBe("The first search: 60 s");
    expect(say(sv, "sv", ["stage"], { stage: "SOMETHING_NEW", seconds: 1 })).toBe("Ett steg: 1 s");
  });

  it("says how many searches and for how long, singular and plural", () => {
    expect(say(sv, "sv", ["searchNone"], { count: 1, seconds: 60 })).toBe("En sökning pågick i sammanlagt 60 s, och ingen hittade ett schema.");
    expect(say(sv, "sv", ["searchNone"], { count: 2, seconds: 100 })).toBe("2 sökningar pågick i sammanlagt 100 s, och ingen hittade ett schema.");
  });

  it("says a short clock with its three figures, and never asks a school to raise the engine's time limit", () => {
    expect(say(sv, "sv", ["cause", "SHORT_CLOCK_WAIT"], { budget: 94, configured: 180, wait: 99 })).toBe(
      "Sökningen fick 94 s av de 180 s som motorn är inställd på, eftersom svaret måste komma inom 99 s.",
    );
    for (const messages of [sv, en]) {
      const every = JSON.stringify(texts(messages));
      expect(every).not.toMatch(/höja lösarens tidsgräns|raise the solver time limit|administratör/i);
    }
  });

  it("has every cause, in both languages, with a sentence and a next step", () => {
    for (const messages of [sv, en]) {
      for (const kind of ["RULES_MEASURED", "TIGHT_WEEK", "SHORT_CLOCK", "SLOW_SETUP", "NOTHING_FOUND"]) {
        expect(typeof (texts(messages).next as Record<string, unknown>)[kind]).toBe("string");
      }
      for (const kind of ["RULES_MEASURED", "TIGHT_WEEK", "SHORT_CLOCK", "SHORT_CLOCK_WAIT", "SLOW_SETUP", "NOTHING_FOUND"]) {
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
