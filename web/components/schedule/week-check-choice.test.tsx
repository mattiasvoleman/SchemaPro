import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WeekCheckChoice } from "@/components/schedule/week-check-choice";
import { ApiError } from "@/lib/api";
import type { ChoiceCount, ChoiceWhatIf, ChoiceYear, WeekCheckChoiceView } from "@/lib/week-check-choice";
import { ENGINE_LACKS_WEEK_CHECK, type WeekCheckResult } from "@/lib/week-check";

// The gateway, one level down: the hook asks through lib/week-check-choice, whose own function a mock of it would not reach.
const asked = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { post: asked },
}));

// Only what the memory says the catalogue stub has: useLocale and useTranslations, and the keys echoed with their values.
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: (namespace: string) => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${namespace}.${key}(${Object.values(values).join("|")})` : `${namespace}.${key}`;
    return Object.assign(t, { has: () => true });
  },
}));

const result: WeekCheckResult = {
  verdict: "TIGHT",
  years: [{ year: 9, demandMinutes: 2120, capacityMinutes: 2275, percent: 93, over: false }],
  conflicts: null,
  skipped: ["LUNCH_STAGE"],
  elapsedMs: 100,
  checkedBy: "ENGINE",
};
const engineText = vi.fn((sentence: { code: string | null; message: string }) => `engine:${sentence.code}`);

const load = (percent: number, over: Partial<Extract<ChoiceCount, { kind: "LOAD" }>> = {}): ChoiceCount => ({
  kind: "LOAD",
  demandMinutes: Math.round((percent * 2275) / 100),
  capacityMinutes: 2275,
  percent,
  over: false,
  atLeast: false,
  period: null,
  ...over,
});
const whatIf = (subject: string, count: ChoiceCount, over: Partial<ChoiceWhatIf> = {}): ChoiceWhatIf => ({
  subject,
  qualified: 1,
  moved: 2,
  of: 5,
  count,
  ranked: true,
  ...over,
});
const year = (over: Partial<ChoiceYear> = {}): ChoiceYear => ({
  year: 9,
  today: load(114),
  floor: load(94),
  whatIf: [whatIf("Hemkunskap", load(109)), whatIf("Musik", load(112))],
  ...over,
});
const done = (over: Partial<WeekCheckChoiceView> = {}): WeekCheckChoiceView => ({
  status: "DONE",
  years: [year()],
  qualificationsRecorded: true,
  releasedPosts: 12,
  notRun: 0,
  calls: 4,
  elapsedMs: 5000,
  ...over,
});

const renderChoice = (props: Partial<Parameters<typeof WeekCheckChoice>[0]> = {}) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <WeekCheckChoice academicYearId="year-1" result={result} engineText={engineText} {...props} />
    </QueryClientProvider>,
  );

const FAILURES = {
  ENGINE_OLDER: () => new ApiError(503, "m", ENGINE_LACKS_WEEK_CHECK),
  THROTTLED: () => new ApiError(429, "Too many requests"),
  ERROR: () => new Error("down"),
};
const ask = async (view: WeekCheckChoiceView | { kind: "unavailable"; reason: keyof typeof FAILURES }) => {
  if ("kind" in view) {
    asked.mockImplementation(async () => {
      throw FAILURES[view.reason]();
    });
  }
  else asked.mockResolvedValue(view);
  const user = userEvent.setup();
  renderChoice();
  await user.click(screen.getByRole("button", { name: "weekCheckChoice.button" }));
  return user;
};

beforeEach(() => {
  // A block, not an arrow that returns the mock: a function returned from beforeEach is run after the test as its teardown.
  asked.mockReset();
});
afterEach(cleanup);

describe("WeekCheckChoice", () => {
  it("offers the question by a button and asks nothing until it is pressed: it is up to twelve checks", () => {
    renderChoice();

    expect(screen.getByRole("heading", { name: "weekCheckChoice.title" })).toBeInTheDocument();
    expect(screen.getByText("weekCheckChoice.hint")).toBeInTheDocument();
    expect(asked).not.toHaveBeenCalled();
  });

  it("asks about the year the check was about, and keeps the button where focus was while it waits", async () => {
    let finish: (value: unknown) => void = () => undefined;
    asked.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const user = userEvent.setup();
    renderChoice({ academicYearId: "year-7" });

    const button = screen.getByRole("button", { name: "weekCheckChoice.button" });
    await user.click(button);

    expect(asked).toHaveBeenCalledWith("/api/v1/optimization/week-check/choice", { academicYearId: "year-7" }, expect.anything());
    const busy = await screen.findByRole("button", { name: "weekCheckChoice.asking" });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute("aria-busy", "true");
    finish(done());
    expect(await screen.findByRole("button", { name: "weekCheckChoice.again" })).toBeEnabled();
  });

  it("says the floor as a lower bound and never as a promise: under 100 % a choice might help, it does not fit", async () => {
    await ask(done());

    const group = await screen.findByRole("group", { name: "weekCheckChoice.year(9)" });
    expect(within(group).getByText(/weekCheckChoice\.floor\.load\(9\|94\)/)).toBeInTheDocument();
    expect(within(group).getByText("weekCheckChoice.floor.mayHelp")).toBeInTheDocument();
    expect(within(group).queryByText("weekCheckChoice.floor.overBody")).toBeNull();
  });

  it("says a floor over the supply plainly: no choice of teachers helps", async () => {
    await ask(done({ years: [year({ floor: load(104, { over: true }) })] }));

    const group = await screen.findByRole("group", { name: "weekCheckChoice.year(9)" });
    expect(within(group).getByText(/weekCheckChoice\.floor\.over\(9\|2366\|2275\)/)).toBeInTheDocument();
    expect(within(group).getByText("weekCheckChoice.floor.overBody")).toBeInTheDocument();
    expect(within(group).queryByText("weekCheckChoice.floor.mayHelp")).toBeNull();
  });

  it("says a floor the count's seconds cut is only a lower bound", async () => {
    await ask(done({ years: [year({ floor: load(96, { atLeast: true }) })] }));

    expect(await screen.findByText("weekCheckChoice.floor.cut")).toBeInTheDocument();
  });

  it("says a floor under the tight threshold as that, not as a number, and one not counted as not said", async () => {
    await ask(done({ years: [year({ floor: { kind: "UNDER", below: 85 } })] }));
    expect(await screen.findByText(/weekCheckChoice\.floor\.under\(9\|85\)/)).toBeInTheDocument();
    cleanup();

    await ask(done({ years: [year({ floor: { kind: "UNKNOWN" } })] }));
    expect(await screen.findByText(/weekCheckChoice\.floor\.unknown\(9\)/)).toBeInTheDocument();
    expect(screen.queryByText("weekCheckChoice.floor.mayHelp")).toBeNull();
  });

  it("says a week another count refuses by that count's own sentence", async () => {
    await ask(done({ years: [year({ floor: { kind: "REFUSED", code: "DEMAND_CLIQUE_HOURS_SHORT", params: { grades: "9" } } })] }));

    expect(await screen.findByText("engine:DEMAND_CLIQUE_HOURS_SHORT")).toBeInTheDocument();
    expect(engineText).toHaveBeenCalledWith({ code: "DEMAND_CLIQUE_HOURS_SHORT", message: "", params: { grades: "9" } });
  });

  it("lists the what-ifs best first, as from → to, naming subjects and never a person", async () => {
    await ask(done());

    const items = await screen.findAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("weekCheckChoice.whatIf.line(Hemkunskap|weekCheckChoice.count.short.load(114|no)|weekCheckChoice.count.short.load(109|no))");
    expect(items[1]).toHaveTextContent("Musik");
    expect(items[0]).toHaveTextContent("weekCheckChoice.whatIf.detail(1|2|5)");
    expect(screen.getByRole("list")).toBeInstanceOf(HTMLOListElement);
  });

  it("says a what-if that is still over the supply as that and not as from → to: its figure is a bound, and it is not ranked", async () => {
    await ask(done({ years: [year({ today: load(114, { over: true }), whatIf: [whatIf("Hemkunskap", load(109, { over: true }), { ranked: false })] })] }));

    const item = await screen.findByRole("listitem");
    expect(item).toHaveTextContent("weekCheckChoice.whatIf.lineOver(Hemkunskap|weekCheckChoice.count.short.over(109|2480|2275))");
    expect(item).not.toHaveTextContent("weekCheckChoice.whatIf.line(");
    expect(item).toHaveTextContent("weekCheckChoice.whatIf.stillOver");
    // Its reason is the first period the engine refuses, not a count that did not finish.
    expect(item).not.toHaveTextContent("weekCheckChoice.whatIf.unranked");
  });

  it("says a what-if that is over the supply and was also cut both ways", async () => {
    await ask(done({ years: [year({ whatIf: [whatIf("Hemkunskap", load(109, { over: true, atLeast: true }), { ranked: false })] })] }));

    const item = await screen.findByRole("listitem");
    expect(item).toHaveTextContent("weekCheckChoice.whatIf.stillOver");
    expect(item).toHaveTextContent("weekCheckChoice.whatIf.unranked");
  });

  it("says a what-if that was not ranked is not ranked, and a cut figure as at least", async () => {
    await ask(done({ years: [year({ whatIf: [whatIf("Bild", load(80, { atLeast: true }), { ranked: false })] })] }));

    const item = await screen.findByRole("listitem");
    expect(item).toHaveTextContent("weekCheckChoice.count.short.load(80|yes)");
    expect(item).toHaveTextContent("weekCheckChoice.whatIf.unranked");
  });

  it("names the tightest period of a figure, in dates, and says when the same posts run in other weeks", async () => {
    const period = { from: "2027-01-11", to: "2027-06-11", more: true };
    await ask(done({ years: [year({ today: load(114, { period }) })] }));

    // periodDay reads the day in UTC as written: "11 januari 2027".
    expect(await screen.findByText(/weekCheckChoice\.period\(11 januari 2027\|11 juni 2027\|yes\)/)).toBeInTheDocument();
  });

  it("says what is missing instead of a floor: no behörigheter recorded, or nobody with a second to release", async () => {
    await ask(done({ qualificationsRecorded: false, releasedPosts: 0, years: [year({ floor: null })] }));
    expect(await screen.findByText("weekCheckChoice.floor.noQualifications")).toBeInTheDocument();
    cleanup();

    await ask(done({ releasedPosts: 0, years: [year({ floor: null })] }));
    expect(await screen.findByText("weekCheckChoice.floor.nothingToRelease")).toBeInTheDocument();
    expect(screen.queryByText("weekCheckChoice.floor.noQualifications")).toBeNull();
  });

  it("says that the figures are bounds and not a timetable, and how many what-ifs the time left out", async () => {
    await ask(done({ notRun: 3 }));

    expect(await screen.findByText("weekCheckChoice.limits")).toBeInTheDocument();
    expect(screen.getByText("weekCheckChoice.notRun(3)")).toBeInTheDocument();
  });

  it.each([
    ["NO_TIGHT_YEAR", "weekCheckChoice.status.NO_TIGHT_YEAR"],
    ["NOT_ASKED", "weekCheckChoice.status.NOT_ASKED"],
  ] as const)("says a %s answer in a sentence of its own", async (status, sentence) => {
    await ask(done({ status, years: [] }));

    expect(await screen.findByText(sentence)).toBeInTheDocument();
  });

  it.each(["ENGINE_OLDER", "THROTTLED", "ERROR"] as const)("says an unavailable analysis (%s) without taking the check's answer with it", async (reason) => {
    await ask({ kind: "unavailable", reason });

    expect(await screen.findByText(`weekCheckChoice.unavailable.${reason}`)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "weekCheckChoice.again" })).toBeEnabled();
  });

  it("drops the answer when the check it belongs to is replaced by another", async () => {
    asked.mockResolvedValue(done());
    const user = userEvent.setup();
    const { rerender } = renderChoice();
    await user.click(screen.getByRole("button", { name: "weekCheckChoice.button" }));
    await screen.findByRole("group", { name: "weekCheckChoice.year(9)" });

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <WeekCheckChoice academicYearId="year-1" result={{ ...result, elapsedMs: 200 }} engineText={engineText} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.queryByRole("group", { name: "weekCheckChoice.year(9)" })).toBeNull());
    expect(screen.getByRole("button", { name: "weekCheckChoice.button" })).toBeInTheDocument();
  });
});
