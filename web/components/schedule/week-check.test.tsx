import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WeekCheckPanel } from "@/components/schedule/week-check";
import type { WeekCheckOutcome, WeekCheckResult } from "@/lib/week-check";

/** Message keys this build has no translation for; the next-intl stub below answers `.has` by it. */
const untranslated = vi.hoisted(() => [] as string[]);

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace: string) => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${namespace}.${key}(${Object.values(values).join("|")})` : `${namespace}.${key}`;
    return Object.assign(t, { has: (key: string) => !untranslated.includes(key) });
  },
}));

afterEach(() => {
  cleanup();
  untranslated.length = 0;
});

const base: WeekCheckResult = {
  verdict: "OK",
  years: [],
  conflicts: null,
  skipped: ["LUNCH_STAGE"],
  elapsedMs: 120,
  checkedBy: "ENGINE",
};
const result = (over: Partial<WeekCheckResult>): WeekCheckOutcome => ({ kind: "result", result: { ...base, ...over } });

const tightRow = {
  category: "REQUIREMENT_DEMAND",
  code: "TIGHT_WEEK_LOAD",
  message: "Year 9 needs at least 2120 of the 2275 minutes (93 %).",
  params: { grades: "9", demandMinutes: 2120, capacityMinutes: 2275, percent: 93 },
  resourceNames: [],
};

const props = (outcome: WeekCheckOutcome | null, over: Partial<Parameters<typeof WeekCheckPanel>[0]> = {}) => ({
  outcome,
  pending: false,
  asking: false,
  onRunAnyway: vi.fn(),
  onCancelRun: vi.fn(),
  ...over,
});

describe("WeekCheckPanel", () => {
  it("draws nothing before a check has been asked for", () => {
    const { container } = render(<WeekCheckPanel {...props(null)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("is busy and says so to assistive technology while a check is on its way", () => {
    render(<WeekCheckPanel {...props(null, { pending: true })} />);

    expect(screen.getByRole("region", { name: "weekCheck.title" })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("weekCheck.checking");
  });

  it("says OK as nothing found, never as a timetable that exists, and names what did not run", () => {
    render(<WeekCheckPanel {...props(result({ skipped: ["LUNCH_STAGE", "WEEK_LOAD_DEADLINE"] }))} />);

    expect(screen.getByText("weekCheck.verdict.OK")).toBeInTheDocument();
    expect(screen.getByText("weekCheck.okBody")).toBeInTheDocument();
    expect(screen.getByText("weekCheck.skipped.LUNCH_STAGE")).toBeInTheDocument();
    expect(screen.getByText("weekCheck.skipped.WEEK_LOAD_DEADLINE")).toBeInTheDocument();
    expect(screen.queryByText(/weekCheck\.skipped\.PLACEMENTS_PROBE/)).toBeNull();
  });

  it("says a tight year as its share of the frame, with the rows a refused run carries beneath it", () => {
    render(
      <WeekCheckPanel
        {...props(
          result({
            verdict: "TIGHT",
            years: [{ year: 9, demandMinutes: 2120, capacityMinutes: 2275, percent: 93, over: false }],
            conflicts: { summary: "", summaryCode: "", summaryParams: {}, conflicts: [tightRow] },
          }),
        )}
      />,
    );

    expect(screen.getByText("weekCheck.verdict.TIGHT")).toBeInTheDocument();
    expect(screen.getByText("weekCheck.yearTight(9|93)")).toBeInTheDocument();
    expect(screen.getByText("weekCheck.tightBody")).toBeInTheDocument();
    expect(screen.getByText("engineMessages.TIGHT_WEEK_LOAD(9|2120|2275|93)")).toBeInTheDocument();
    expect(screen.getByText("conflictCategories.REQUIREMENT_DEMAND")).toBeInTheDocument();
    // No headline: a tight week has none, and an empty one must not be drawn. The one muted line is the body.
    expect(document.querySelectorAll("p.text-muted-foreground")).toHaveLength(1);
  });

  it("says an impossible year as what it needs against what it has, under the refusal's own summary", () => {
    render(
      <WeekCheckPanel
        {...props(
          result({
            verdict: "IMPOSSIBLE",
            years: [{ year: null, demandMinutes: 2365, capacityMinutes: 2275, percent: 103, over: true }],
            conflicts: {
              summary: "English summary.",
              summaryCode: "DEMAND_YEAR_WEEK_SHORT",
              summaryParams: { grades: "any" },
              conflicts: [
                {
                  category: "TEACHER_OVERLAP",
                  code: "TEACHER_SHARED_BY_PARALLEL_GROUPS",
                  message: "A teacher.",
                  params: { groups: 3 },
                  resourceNames: ["Svenska 9a", "Svenska 9b"],
                },
              ],
            },
          }),
        )}
      />,
    );

    expect(screen.getByText("weekCheck.verdict.IMPOSSIBLE")).toBeInTheDocument();
    // "Any" year: the classes of unknown year, as the engine's own sentence says it.
    expect(screen.getByText("weekCheck.yearOver(any|2365|2275)")).toBeInTheDocument();
    expect(screen.getByText("weekCheck.impossibleBody")).toBeInTheDocument();
    expect(screen.getByText("engineMessages.DEMAND_YEAR_WEEK_SHORT(any)")).toBeInTheDocument();
    expect(screen.getByText("Svenska 9a, Svenska 9b")).toBeInTheDocument();
  });

  it("falls back to the engine's English for a category and a sentence this build has not translated", () => {
    untranslated.push("TIGHT_WEEK_LOAD", "REQUIREMENT_DEMAND");
    render(
      <WeekCheckPanel
        {...props(
          result({
            verdict: "TIGHT",
            years: [{ year: 9, demandMinutes: 2120, capacityMinutes: 2275, percent: 93, over: false }],
            conflicts: { summary: "", summaryCode: "", summaryParams: {}, conflicts: [tightRow] },
          }),
        )}
      />,
    );

    expect(screen.getByText(tightRow.message)).toBeInTheDocument();
    expect(screen.getByText("REQUIREMENT_DEMAND")).toBeInTheDocument();
  });

  it("says a refusal of the payload in the engine's sentence", () => {
    render(
      <WeekCheckPanel
        {...props({ kind: "refused", code: "LUNCH_HEADCOUNT_EXCEEDS_SEATS", message: "English.", params: { seats: 20 } })}
      />,
    );

    expect(screen.getByText("weekCheck.refusedTitle")).toBeInTheDocument();
    expect(screen.getByText("engineMessages.LUNCH_HEADCOUNT_EXCEEDS_SEATS(20)")).toBeInTheDocument();
  });

  it.each([
    ["ENGINE_OLDER", "weekCheck.unavailableOlder"],
    ["ERROR", "weekCheck.unavailable"],
  ] as const)("says %s in words, and not as an error", (reason, text) => {
    render(<WeekCheckPanel {...props({ kind: "unavailable", reason, message: "m" })} />);

    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("the question before a run", () => {
  const tight = result({
    verdict: "TIGHT",
    years: [
      { year: 7, demandMinutes: 2068, capacityMinutes: 2200, percent: 94, over: false },
      { year: 8, demandMinutes: 1980, capacityMinutes: 2200, percent: 90, over: false },
    ],
    conflicts: { summary: "", summaryCode: "", summaryParams: {}, conflicts: [tightRow] },
  });

  it("is not open unless the run asked", () => {
    render(<WeekCheckPanel {...props(tight)} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks about the heaviest year in its title and lists them all", () => {
    render(<WeekCheckPanel {...props(tight, { asking: true })} />);

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("weekCheck.ask.titleTight(7|94)")).toBeInTheDocument();
    expect(within(dialog).getByText("weekCheck.yearTight(7|94)")).toBeInTheDocument();
    expect(within(dialog).getByText("weekCheck.yearTight(8|90)")).toBeInTheDocument();
  });

  it("asks without a year when a tight answer carries none, rather than naming nobody", () => {
    render(<WeekCheckPanel {...props(result({ verdict: "TIGHT" }), { asking: true })} />);

    expect(within(screen.getByRole("dialog")).getByText("weekCheck.ask.titleTightPlain")).toBeInTheDocument();
  });

  it("is not open while a new check is on its way, whatever the run asked", () => {
    render(<WeekCheckPanel {...props(tight, { asking: true, pending: true })} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("runs on yes and only on yes; no is no run", async () => {
    const onRunAnyway = vi.fn();
    const onCancelRun = vi.fn();
    render(<WeekCheckPanel {...props(tight, { asking: true, onRunAnyway, onCancelRun })} />);
    const dialog = screen.getByRole("dialog");

    await userEvent.setup().click(within(dialog).getByRole("button", { name: "common.cancel" }));
    expect(onCancelRun).toHaveBeenCalledTimes(1);
    expect(onRunAnyway).not.toHaveBeenCalled();

    await userEvent.setup().click(within(dialog).getByRole("button", { name: "weekCheck.ask.confirm" }));
    expect(onRunAnyway).toHaveBeenCalledTimes(1);
  });

  it("is a no when the dialog is dismissed by its own close", async () => {
    const onCancelRun = vi.fn();
    render(<WeekCheckPanel {...props(tight, { asking: true, onCancelRun })} />);

    await userEvent.setup().keyboard("{Escape}");

    expect(onCancelRun).toHaveBeenCalled();
  });

  it("says an impossible week would be refused in seconds, and a payload refusal the same", () => {
    const { unmount } = render(
      <WeekCheckPanel
        {...props(
          result({
            verdict: "IMPOSSIBLE",
            years: [{ year: 9, demandMinutes: 2365, capacityMinutes: 2275, percent: 103, over: true }],
          }),
          { asking: true },
        )}
      />,
    );
    let dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("weekCheck.ask.titleImpossible")).toBeInTheDocument();
    expect(within(dialog).getByText("weekCheck.ask.bodyImpossible")).toBeInTheDocument();
    expect(within(dialog).getByText("weekCheck.yearOver(9|2365|2275)")).toBeInTheDocument();
    unmount();

    render(
      <WeekCheckPanel {...props({ kind: "refused", code: "X", message: "m", params: null }, { asking: true })} />,
    );
    dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("weekCheck.ask.titleRefused")).toBeInTheDocument();
  });
});
