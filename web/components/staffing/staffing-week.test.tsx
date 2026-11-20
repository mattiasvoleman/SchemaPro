import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StaffingWeek, STAFFING_WEEK_SETTLE_MS, type StaffingWeekProps } from "@/components/staffing/staffing-week";
import { ApiError } from "@/lib/api";
import type {
  ChoiceCount,
  StaffingWeekChange,
  StaffingWeekVerdict,
  StaffingWeekView,
  StaffingWeekYear,
} from "@/lib/staffing-week";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/**
 * Föreslå bemanning, the week before and after, drawn over the real hook and the real messages (Swedish and English:
 * a missing key or argument throws, as it does for a reader), with the gateway mocked at lib/api. What matters most:
 * a week that gets tighter is said so and never shown as an improvement, and two figures the engine cannot set in
 * order are not.
 */

const asked = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { post: asked },
}));

const WEEK = "/api/v1/optimization/staffing/proposal/week";
const BASIS = "a".repeat(64);
const WITH_WEEK = "c".repeat(64);

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
const over = (percent: number): ChoiceCount => load(percent, { over: true });
const year = (before: ChoiceCount, after: ChoiceCount, verdict: StaffingWeekVerdict, number = 9): StaffingWeekYear => ({
  year: number,
  before,
  after,
  verdict,
});
const done = (years: StaffingWeekYear[], overrides: Partial<StaffingWeekView> = {}): StaffingWeekView => ({
  status: "DONE",
  years,
  verdicts: { before: "TIGHT", after: "TIGHT" },
  worse: years.some((entry) => entry.verdict === "TIGHTER" || entry.verdict === "NEWLY_REFUSED"),
  basisSha256: WITH_WEEK,
  overlay: { given: 2, laidOver: 2, notLaidOver: 0, fromNobody: 0, newToTheWeek: 0 },
  calls: 2,
  elapsedMs: 3000,
  ...overrides,
});
const change = (n: number): StaffingWeekChange => ({ requirementId: `r-${n}`, fromTeacherId: null, toTeacherId: `t-${n}` });

const onBasis = vi.fn();
type Messages = typeof sv;

const renderWeek = (
  props: Partial<StaffingWeekProps> = {},
  { locale = "sv", messages = sv }: { locale?: string; messages?: Messages } = {},
) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const element = (next: Partial<StaffingWeekProps>) => (
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider
        locale={locale}
        messages={messages}
        timeZone="Europe/Stockholm"
        onError={(error) => {
          throw error;
        }}
      >
        <StaffingWeek
          academicYearId="year-1"
          serial={1}
          basisSha256={BASIS}
          changes={[change(1), change(2)]}
          onBasis={onBasis}
          {...props}
          {...next}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
  const view = render(element({}));
  return { rerender: (next: Partial<StaffingWeekProps>) => view.rerender(element(next)), queryClient };
};

const answer = (view: StaffingWeekView) => asked.mockResolvedValue(view);

beforeEach(() => {
  asked.mockReset();
  onBasis.mockReset();
});
afterEach(() => {
  cleanup();
});

describe("what is asked", () => {
  it("asks its own route for the selected changes under the proposal's basis, and says it is counting meanwhile", async () => {
    let resolve!: (view: StaffingWeekView) => void;
    asked.mockImplementation(() => new Promise<StaffingWeekView>((done) => (resolve = done)));
    renderWeek();

    expect(await screen.findByText("Räknar veckan före och efter förslaget…")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Veckan före och efter", busy: true })).toBeInTheDocument();
    const [path, body, signal] = asked.mock.calls[0]!;
    expect(path).toBe(WEEK);
    expect(body).toEqual({ academicYearId: "year-1", basisSha256: BASIS, changes: [change(1), change(2)] });
    expect(signal).toBeInstanceOf(AbortSignal);

    await act(async () => resolve(done([year(load(95), load(95), "SAME")])));
    await waitFor(() => expect(screen.queryByText("Räknar veckan före och efter förslaget…")).not.toBeInTheDocument());
    expect(screen.getByText("95 % → 95 %: den trängsta perioden är oförändrad")).toBeInTheDocument();
  });

  it("asks nothing when nothing is selected, and says what to do", () => {
    renderWeek({ changes: [] });

    expect(screen.getByText("Välj minst en ändring ovan för att se vad den gör med veckan.")).toBeInTheDocument();
    expect(asked).not.toHaveBeenCalled();
  });

  it("waits for the selection to stand still before it asks again, asks once for a burst of clicks, and says it is counting again", async () => {
    answer(done([year(load(95), load(97), "TIGHTER")]));
    const { rerender } = renderWeek();
    await screen.findByText(/Veckan blir trängre|veckan blir trängre/i);
    expect(asked).toHaveBeenCalledTimes(1);

    rerender({ changes: [change(1)] });
    rerender({ changes: [change(1), change(3)] });
    rerender({ changes: [change(3)] });
    // The question for the first selection is on the screen as stale: it is not shown as the answer for this one.
    expect(await screen.findByText("Räknar om veckan för ditt urval…")).toBeInTheDocument();
    expect(asked).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(asked).toHaveBeenCalledTimes(2), { timeout: STAFFING_WEEK_SETTLE_MS * 4 });
    expect(asked.mock.calls[1]![1]).toMatchObject({ changes: [change(3)] });
    await waitFor(() => expect(screen.queryByText("Räknar om veckan för ditt urval…")).not.toBeInTheDocument());
  });

  it("does not ask the same selection twice when it comes back, and asks afresh for a new proposal with the same basis", async () => {
    answer(done([year(load(95), load(95), "SAME")]));
    const { rerender } = renderWeek();
    await waitFor(() => expect(asked).toHaveBeenCalledTimes(1));

    rerender({ changes: [change(1)] });
    await waitFor(() => expect(asked).toHaveBeenCalledTimes(2), { timeout: STAFFING_WEEK_SETTLE_MS * 4 });
    rerender({ changes: [change(1), change(2)] });
    await new Promise((resolve) => setTimeout(resolve, STAFFING_WEEK_SETTLE_MS + 200));
    expect(asked).toHaveBeenCalledTimes(2);

    rerender({ serial: 2 });
    await waitFor(() => expect(asked).toHaveBeenCalledTimes(3), { timeout: STAFFING_WEEK_SETTLE_MS * 4 });
  });
});

describe("the figures", () => {
  it("says a week that gets tighter in words, with both figures and the warning above them, and never as an improvement", async () => {
    answer(done([year(load(95), load(98), "TIGHTER")]));
    renderWeek();

    expect(await screen.findByText("Förslaget gör veckan trängre")).toBeInTheDocument();
    expect(screen.getByText(/ligger veckan närmare gränsen, eller över den/)).toBeInTheDocument();
    expect(screen.getByText("95 % → 98 %: veckan blir trängre")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Åk 9" })).toBeInTheDocument();
    expect(screen.queryByText(/Förslaget gör inte den trängsta veckan trängre/)).not.toBeInTheDocument();
    expect(screen.queryByText(/den trängsta perioden blir lättare/)).not.toBeInTheDocument();
  });

  it("says a week that gets lighter or stays the same, and that the proposal does not make it tighter, only then", async () => {
    answer(done([year(load(98), load(93), "LOOSER"), year({ kind: "UNDER", below: 85 }, { kind: "UNDER", below: 85 }, "SAME", 8)]));
    renderWeek();

    expect(await screen.findByText("98 % → 93 %: den trängsta perioden blir lättare")).toBeInTheDocument();
    expect(screen.getByText("under 85 % → under 85 %: den trängsta perioden är oförändrad")).toBeInTheDocument();
    expect(screen.getByText("Förslaget gör inte den trängsta veckan trängre i någon av årskurserna nedan.")).toBeInTheDocument();
    expect(screen.queryByText("Förslaget gör veckan trängre")).not.toBeInTheDocument();
  });

  it("does not say the proposal does not make the week tighter when one year cannot be set against the other, and does not warn either", async () => {
    answer(done([year(load(98), load(93), "LOOSER"), year(over(107), over(144), "STILL_OVER", 8)]));
    renderWeek();

    await screen.findByText("98 % → 93 %: den trängsta perioden blir lättare");
    expect(screen.queryByText(/Förslaget gör inte den trängsta veckan trängre/)).not.toBeInTheDocument();
    expect(screen.queryByText("Förslaget gör veckan trängre")).not.toBeInTheDocument();
  });

  it("sets two figures over the supply side by side as lower bounds and says nothing of which is heavier", async () => {
    answer(done([year(over(107), over(144), "STILL_OVER")]));
    renderWeek();

    const line = await screen.findByText(/Före: minst 107 %\. Efter: minst 144 %\./);
    expect(line).toHaveTextContent("Veckan ligger över ramtiden både före och efter, så vi kan inte säga om förslaget gör den bättre eller sämre.");
    expect(screen.getByText(/så de två siffrorna är nedre gränser för olika perioder/)).toBeInTheDocument();
    expect(screen.queryByText(/blir trängre|blir lättare/)).not.toBeInTheDocument();
  });

  it("says 'minst' for a figure the engine's seconds cut and does not set it against the other", async () => {
    answer(done([year(load(95), load(99, { atLeast: true }), "NOT_COMPARED")]));
    renderWeek();

    expect(await screen.findByText("Före: 95 %. Efter: minst 99 %. De två går inte att jämföra.")).toBeInTheDocument();
    expect(screen.getByText(/Minst en av siffrorna är en nedre gräns eller saknas/)).toBeInTheDocument();
    expect(screen.queryByText("Förslaget gör veckan trängre")).not.toBeInTheDocument();
    expect(screen.queryByText(/inte den trängsta veckan trängre/)).not.toBeInTheDocument();
  });

  it("says an unreached year as not counted", async () => {
    answer(done([year(load(95), { kind: "UNKNOWN" }, "NOT_COMPARED")]));
    renderWeek();

    expect(await screen.findByText("Före: 95 %. Efter: inte räknad. De två går inte att jämföra.")).toBeInTheDocument();
  });

  it("warns, with the engine's own sentence, when the week is refused after the proposal by another count than the load", async () => {
    answer(
      done([year(load(95), { kind: "REFUSED", code: "STAFF_TEACHER_CAPACITY_ZERO", params: {} }, "NEWLY_REFUSED")], {
        verdicts: { before: "TIGHT", after: "IMPOSSIBLE" },
      }),
    );
    renderWeek();

    expect(await screen.findByText("Förslaget gör veckan trängre")).toBeInTheDocument();
    expect(screen.getByText("Före: 95 %. Efter: motorn nekar veckan av en annan räkning än veckolasten.")).toBeInTheDocument();
  });

  it("names the period each figure was counted in, as a refusal does, and does not invent one", async () => {
    const period = { from: "2026-08-17", to: "2026-12-18", more: true };
    answer(done([year(load(95, { period }), load(98, { period: { from: "2027-01-11", to: "2027-06-11", more: false } }), "TIGHTER")]));
    renderWeek();

    expect(await screen.findByText(/Före: räknat för veckorna 17 augusti 2026 – 18 december 2026 och övriga veckor med samma poster\./)).toBeInTheDocument();
    expect(screen.getByText(/Efter: räknat för veckorna 11 januari 2027 – 11 juni 2027\./)).toBeInTheDocument();
  });

  it("says when no year the changes touch is at the threshold before or after", async () => {
    answer(done([], { verdicts: { before: "OK", after: "OK" } }));
    renderWeek();

    expect(await screen.findByText(/ligger vid 85 % av ramtiden eller mer, varken före eller efter förslaget/)).toBeInTheDocument();
  });

  it("says what the figures are and are not, and what the proposal's posts were counted as", async () => {
    answer(
      done([year(load(90), load(97), "TIGHTER")], {
        overlay: { given: 4, laidOver: 2, notLaidOver: 2, fromNobody: 1, newToTheWeek: 2 },
      }),
    );
    renderWeek();

    expect(await screen.findByText(/Siffrorna är nedre gränser som motorn kan bevisa/)).toBeInTheDocument();
    expect(screen.getByText(/En vecka över ramtiden räknas bara till den första period motorn nekar/)).toBeInTheDocument();
    expect(screen.getByText(/1 post saknar lärare i dag. Veckan före är räknad utan lärare på dem/)).toBeInTheDocument();
    expect(screen.getByText(/2 lärare har inget annat i veckan i dag/)).toBeInTheDocument();
    expect(screen.getByText(/2 valda ändringar syns inte i veckan motorn räknar på/)).toBeInTheDocument();
  });

  it("names the years in order and no person", async () => {
    answer(done([year(load(95), load(97), "TIGHTER", 9), year(load(90), load(91), "TIGHTER", 8)]));
    renderWeek();

    await screen.findByText("Förslaget gör veckan trängre");
    expect(screen.getAllByRole("group").map((group) => within(group).getByRole("heading").textContent)).toEqual(["Åk 9", "Åk 8"]);
  });

  it("reads in English too, key for key", async () => {
    answer(done([year(over(107), over(144), "STILL_OVER"), year(load(95), load(98), "TIGHTER", 8)]));
    renderWeek({}, { locale: "en", messages: en as unknown as Messages });

    expect(await screen.findByText("The proposal makes the week tighter")).toBeInTheDocument();
    expect(screen.getByText("95 % → 98 %: the week gets tighter")).toBeInTheDocument();
    expect(screen.getByText(/Before: at least 107 %\. After: at least 144 %\./)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "The week before and after" })).toBeInTheDocument();
  });
});

describe("advice, not a gate: a figure that could not be made says so, and that the proposal can be applied", () => {
  it.each([
    ["ENGINE_ERROR", "Motorn svarade inte på veckan just nu. Förslaget går att tillämpa ändå."],
    ["ENGINE_OLDER", "Schemamotorn uppdateras och kan inte räkna veckan ännu. Förslaget går att tillämpa ändå."],
    ["TOO_SLOW", "Veckan hann inte räknas inom tiden, så vi kan inte säga hur förslaget påverkar den. Förslaget går att tillämpa ändå."],
    ["NOT_READY", "Veckan går inte att räkna på just nu: schemat är i ett läge som Generera också nekar, till exempel ett block som är delvis låst. Förslaget går att tillämpa ändå."],
  ] as const)("says %s", async (reason, text) => {
    answer({ ...done([]), status: "NOT_CHECKED", reason, verdicts: null, basisSha256: null });
    renderWeek();

    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByText("Förslaget gör veckan trängre")).not.toBeInTheDocument();
  });

  it("says a selection that changes nothing of the week as it is", async () => {
    answer({ ...done([]), status: "NOT_CHECKED", reason: "NO_CHANGES", verdicts: null, basisSha256: null });
    renderWeek();

    expect(await screen.findByText(/Ingen av de valda ändringarna ändrar veckan som motorn räknar på/)).toBeInTheDocument();
  });

  it.each([
    ["an engine that does not know the route", new ApiError(404, "Cannot POST /api/v1/optimization/staffing/proposal/week"), /kan inte räkna veckan ännu/],
    ["a throttled ask", new ApiError(429, "Too many requests"), /Det har frågats för ofta/],
    ["a request that failed", new Error("network"), /Veckan kunde inte räknas just nu\. Förslaget går att tillämpa ändå\./],
  ])("says %s, and never throws", async (_name, error, text) => {
    asked.mockRejectedValue(error);
    renderWeek();

    expect(await screen.findByText(text)).toBeInTheDocument();
  });

  it("says a proposal that has gone old as that, and not that it can be applied", async () => {
    asked.mockRejectedValue(new ApiError(409, "old", "STAFF_PROPOSAL_STALE"));
    renderWeek();

    expect(await screen.findByText(/Tjänstefördelningen har ändrats sedan förslaget beräknades/)).toBeInTheDocument();
    expect(screen.queryByText(/går att tillämpa ändå/)).not.toBeInTheDocument();
  });
});

describe("the basis an apply carries", () => {
  it("hands up the proposal's and the week's digest together once a figure for the selection on the screen has been shown", async () => {
    answer(done([year(load(95), load(98), "TIGHTER")]));
    renderWeek();

    await waitFor(() => expect(onBasis).toHaveBeenLastCalledWith(WITH_WEEK));
  });

  it("hands up nothing while it counts, when no figure was made, and when the request failed", async () => {
    answer({ ...done([]), status: "NOT_CHECKED", reason: "ENGINE_ERROR", verdicts: null, basisSha256: null });
    renderWeek();
    await screen.findByText(/Motorn svarade inte/);
    expect(onBasis).not.toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(onBasis).toHaveBeenLastCalledWith(null);

    cleanup();
    onBasis.mockReset();
    asked.mockRejectedValue(new Error("network"));
    renderWeek();
    await screen.findByText(/Veckan kunde inte räknas just nu/);
    expect(onBasis).toHaveBeenLastCalledWith(null);
  });

  it("hands up no digest for a week that was not counted, whatever a view says: a digest stands for a figure that was shown", async () => {
    answer({ ...done([]), status: "NOT_CHECKED", reason: "TOO_SLOW", verdicts: null, basisSha256: WITH_WEEK });
    renderWeek();
    await screen.findByText(/Veckan hann inte räknas inom tiden/);

    expect(onBasis).not.toHaveBeenCalledWith(WITH_WEEK);
    expect(onBasis).toHaveBeenLastCalledWith(null);
  });

  it("takes the digest back the moment the selection changes: a figure for another selection is not the one on the screen", async () => {
    answer(done([year(load(95), load(98), "TIGHTER")]));
    const { rerender } = renderWeek();
    await waitFor(() => expect(onBasis).toHaveBeenLastCalledWith(WITH_WEEK));

    rerender({ changes: [change(1)] });
    await waitFor(() => expect(onBasis).toHaveBeenLastCalledWith(null));
    // And a figure for the new selection gives it again.
    await waitFor(() => expect(onBasis).toHaveBeenLastCalledWith(WITH_WEEK), { timeout: STAFFING_WEEK_SETTLE_MS * 4 });
  });

  it("keeps what it handed up when it goes away: the second confirmation takes its place and the figure still stands", async () => {
    answer(done([year(load(95), load(98), "TIGHTER")]));
    renderWeek();
    await waitFor(() => expect(onBasis).toHaveBeenLastCalledWith(WITH_WEEK));

    cleanup();

    expect(onBasis).toHaveBeenLastCalledWith(WITH_WEEK);
  });
});
