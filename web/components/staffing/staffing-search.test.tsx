import { QueryClient, QueryClientProvider, notifyManager } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffingProposal } from "@/app/[locale]/(app)/admin/staffing/use-staffing-proposal";
import { StaffingSearch, StaffingSearchLeftOut, type StaffingSearchProps } from "@/components/staffing/staffing-search";
import { ApiError } from "@/lib/api";
import {
  STAFFING_SEARCH_POLL_MS,
  latestSearchKey,
  type StaffingSearchLeftOut as LeftOut,
  type StaffingSearchStatus,
  type StaffingSearchStop,
  type StaffingSearchView,
  type StaffingSearchWeekFigure,
} from "@/lib/staffing-search";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/**
 * Lärarval F3, the panel of the proposal dialog, drawn over the real hooks and the real messages (Swedish and English: a
 * missing key or argument throws, as it does for a reader), with the gateway mocked at lib/api. What matters most: each
 * state says what is true of it and no more (a bound is never a schedule), only one short sentence is a live region,
 * the proposal is handed over whole, and a proposal that has gone old is not shown.
 */

const gateway = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: gateway,
}));

const YEAR = "year-1";
const BASE = "/api/v1/optimization/staffing/search";
const LATEST = `${BASE}/latest?academicYearId=${YEAR}`;

const week = (before: [number, number], after: [number, number], period: number | null = null): StaffingSearchWeekFigure => ({
  period,
  parity: null,
  from: null,
  to: null,
  before: { demandMinutes: before[0], capacityMinutes: before[1] },
  after: { demandMinutes: after[0], capacityMinutes: after[1] },
});

const NOTHING_LEFT_OUT: LeftOut = { posts: [], years: [] };

/** Åk 9 from 100,2 % to 96,4 %, Åk 8 from 91,2 % to 91,2 % (nothing moved it). */
const figures = (leftOut: LeftOut = NOTHING_LEFT_OUT) => ({
  years: [
    { year: 9, weeks: [week([2280, 2275], [2193, 2275], 0), week([1000, 2275], [1000, 2275], 1)] },
    { year: 8, weeks: [week([2075, 2275], [2075, 2275])] },
  ],
  leftOut,
});

/** Every reason a post can be left out for, each with a count, and two years that were not judged. */
const EVERYTHING_LEFT_OUT: LeftOut = {
  posts: [
    { reason: "NOT_FREE", count: 3 },
    { reason: "UNSTAFFED", count: 1 },
    { reason: "NO_CHOICE", count: 2 },
    { reason: "NOT_IN_WEEK", count: 1 },
    { reason: "YEAR_LIMIT", count: 2 },
    { reason: "YEAR_NOT_COUNTED", count: 1 },
  ],
  years: [
    { year: 6, reason: "YEAR_LIMIT" },
    { year: 7, reason: "YEAR_NOT_COUNTED" },
  ],
};
const LEFT_OUT_TITLE = "Det sökningen lämnade orört";
/** The lines of EVERYTHING_LEFT_OUT in Swedish, in order. */
const LEFT_OUT_LINES = [
  "3 poster är inte släppta åt motorn, eller är fästa, och behåller sina lärare.",
  "1 post saknar lärare och söks inte: att bemanna den är en fråga för Föreslå bemanning, som du kan köra efter att du har tillämpat det här förslaget.",
  "2 poster har ingen annan som får ta dem (behörighet, tjänstgrad eller medlärare) och kan inte byta lärare.",
  "1 post ligger inte i veckan som sökningen räknar (alla dess lektioner är handplacerade, eller årskurserna är okända) och flyttades inte.",
  "2 poster flyttades inte: en årskurs de spänner över är inte bland de fyra trängsta, som är de årskurser sökningen värderar.",
  "1 post flyttades inte: en årskurs den spänner över kunde inte räknas till slut som veckan är i dag, så det går inte att avgöra där om veckan blir trängre än i dag.",
  "Åk 6 värderades inte: sökningen värderar högst fyra årskurser, de trängsta.",
  "Åk 7 värderades inte: veckan kunde inte räknas till slut som den är i dag.",
];

const view = (status: StaffingSearchStatus, overrides: Partial<StaffingSearchView> = {}): StaffingSearchView => ({
  id: "run-1",
  academicYearId: YEAR,
  status,
  stopReason: null,
  budgetMs: 600_000,
  elapsedMs: 80_000,
  round: 3,
  evaluations: 41,
  acceptedMoves: 2,
  figures: figures(),
  tally: null,
  errorCode: null,
  errorParams: null,
  error: null,
  hasProposal: false,
  createdAt: "2026-11-20T10:00:00.000Z",
  startedAt: "2026-11-20T10:00:01.000Z",
  finishedAt: null,
  ...overrides,
});

const ended = (status: StaffingSearchStatus, stopReason: StaffingSearchStop | null, overrides: Partial<StaffingSearchView> = {}) =>
  view(status, { stopReason, finishedAt: "2026-11-20T10:09:00.000Z", ...overrides });

const PROPOSAL = { basisSha256: "a".repeat(64), assignments: [{ requirementId: "r-1" }] } as unknown as StaffingProposal;

/** What the gateway answers: the newest run is whatever `server.latest` is. */
const server: { latest: StaffingSearchView | null; proposal: unknown } = { latest: null, proposal: null };

type Messages = typeof sv;

function renderPanel(
  props: Partial<StaffingSearchProps> = {},
  { locale = "sv", messages = sv }: { locale?: string; messages?: Messages } = {},
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onProposal = vi.fn();
  const onBack = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider
        locale={locale}
        messages={messages}
        timeZone="Europe/Stockholm"
        onError={(error) => {
          throw error;
        }}
      >
        <StaffingSearch academicYearId={YEAR} onProposal={onProposal} onBack={onBack} {...props} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return { queryClient, onProposal, onBack };
}

const posts = () => gateway.post.mock.calls.map(([path, body]) => ({ path, body }));
const sentence = (text: string | RegExp) => screen.getByText(text);

beforeEach(() => {
  gateway.get.mockReset();
  gateway.post.mockReset();
  server.latest = null;
  server.proposal = { proposal: PROPOSAL, figures: null };
  gateway.get.mockImplementation(async (path: string) => {
    if (path === LATEST) return server.latest ?? undefined;
    if (path.endsWith("/proposal")) return server.proposal;
    throw new Error(`unexpected GET ${path}`);
  });
  gateway.post.mockImplementation(async (path: string) => {
    if (path === BASE) {
      server.latest = view("PENDING", { elapsedMs: 0, round: 0, evaluations: 0, acceptedMoves: 0, figures: null, startedAt: null });
      return { runId: "run-1" };
    }
    throw new Error(`unexpected POST ${path}`);
  });
});
afterEach(() => {
  cleanup();
});

describe("before a search", () => {
  it("says in one sentence what it does, that nothing is changed, and offers Sök lärarval; focus starts on the panel's heading", async () => {
    renderPanel();

    const heading = await screen.findByRole("heading", { name: "Sök lärarval", level: 3 });
    expect(heading).toHaveFocus();
    expect(
      await screen.findByText(
        "Sök de byten av lärare på släppta poster som gör veckan lättare. Det tar några minuter; du kan stänga rutan, sökningen fortsätter.",
      ),
    ).toBeInTheDocument();
    expect(sentence(/Sökningen ändrar ingenting\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sök lärarval" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Tillbaka" })).toBeInTheDocument();
    // Nothing is live yet, and there are no figures to caveat.
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
    expect(screen.queryByText(/nedre gräns/)).toBeNull();
  });

  it("starts the year's search, and shows it running as soon as the gateway has it; focus is not left to fall to the page", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "Sök lärarval" }));

    expect(posts()).toEqual([{ path: BASE, body: { academicYearId: YEAR } }]);
    expect(await screen.findByRole("button", { name: "Avbryt sökningen" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Sökningen väntar på att få börja.");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Sök lärarval", level: 3 })).toHaveFocus());
  });

  it("sends the posts the dialog was told to keep, and says they are not moved", async () => {
    const user = userEvent.setup();
    renderPanel({ pinnedRequirementIds: ["r-7", "r-9"] });
    expect(await screen.findByText("2 poster du har valt att behålla som de är flyttas inte.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sök lärarval" }));

    expect(posts()[0]).toEqual({ path: BASE, body: { academicYearId: YEAR, pinnedRequirementIds: ["r-7", "r-9"] } });
  });

  it("goes back to what the dialog showed", async () => {
    const user = userEvent.setup();
    const { onBack } = renderPanel();
    await user.click(await screen.findByRole("button", { name: "Tillbaka" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("says it is fetching, and that it could not, with the way to try again", async () => {
    // A refused read is an answer and is not tried again (a blip is, twice: lib/staffing-search.test.tsx).
    gateway.get.mockRejectedValueOnce(new ApiError(404, "Academic year not found."));
    const user = userEvent.setup();
    renderPanel();

    expect(await screen.findByText("Sökningen kunde inte hämtas just nu. Ingenting har ändrats.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Försök igen" }));
    expect(await screen.findByRole("button", { name: "Sök lärarval" })).toBeInTheDocument();
  });
});

describe("a start that is refused", () => {
  it.each([
    ["STAFFING_SEARCH_NO_QUALIFICATIONS", "Sökningen kan inte starta utan registrerade behörigheter: ingen vet då vem som får ta en post. Registrera behörigheterna och försök igen."],
    [
      "STAFFING_SEARCH_NOT_READY",
      "Sökningen kan inte starta: veckan går inte att räkna som den står, eftersom Generera nekar den av ett skäl som inte handlar om lärarval (till exempel ett block som är delvis låst). Åtgärda det och försök igen.",
    ],
    ["STAFFING_SEARCH_NO_POSTS", "Sökningen kan inte starta: alla poster är förlagda för hand, så det finns ingen vecka att räkna på."],
  ])("%s is said in a sentence of its own, and the start can be pressed again", async (code, text) => {
    gateway.post.mockRejectedValueOnce(new ApiError(409, "The gateway's English", code));
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "Sök lärarval" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(text);
    expect(screen.queryByText("The gateway's English")).toBeNull();
    expect(screen.getByRole("button", { name: "Sök lärarval" })).toBeEnabled();
  });

  it("shows the search that is already running instead, and says so", async () => {
    gateway.post.mockImplementationOnce(async () => {
      server.latest = view("RUNNING");
      throw new ApiError(409, "A search is already running", "STAFFING_SEARCH_ALREADY_RUNNING");
    });
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "Sök lärarval" }));

    expect(await screen.findByText("En sökning pågår redan för läsåret. Den visas här.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Avbryt sökningen" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Sökningen pågår.");
  });

  it("says a throttled start and an engine that cannot answer in plain sentences", async () => {
    gateway.post.mockRejectedValueOnce(new ApiError(429, "Too Many Requests"));
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "Sök lärarval" }));
    expect(await screen.findByText("Det har frågats för ofta. Vänta en minut och försök igen.")).toBeInTheDocument();

    gateway.post.mockRejectedValueOnce(new ApiError(503, "Service Unavailable"));
    await user.click(screen.getByRole("button", { name: "Sök lärarval" }));
    expect(await screen.findByText("Motorn kan inte svara just nu. Försök igen om en stund.")).toBeInTheDocument();
  });

  it("says a refusal of the week itself in the engine catalogue's words when it has them, and in the gateway's own when it has not", async () => {
    gateway.post.mockRejectedValueOnce(new ApiError(409, "Teacher cannot work that many days", "NO_SUCH_ENGINE_CODE", {}));
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "Sök lärarval" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Teacher cannot work that many days");
  });

  it("says the general sentence, and not the log's English, for a start that failed with a 500", async () => {
    gateway.post.mockRejectedValueOnce(new ApiError(500, "An unexpected error occurred. Please try again later."));
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "Sök lärarval" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Något gick fel");
    expect(alert).not.toHaveTextContent("unexpected error");
  });
});

describe("a search that goes on", () => {
  it("says how long it has gone against its budget, how far it has come, and each judged year's tightest week before and now", async () => {
    server.latest = view("RUNNING");
    renderPanel();

    expect(await screen.findByText("Tid använd: 1 min 20 s av 10 min")).toBeInTheDocument();
    const bar = screen.getByRole("progressbar", { name: "Tid använd: 1 min 20 s av 10 min" });
    expect(bar).toHaveAttribute("value", "80000");
    expect(bar).toHaveAttribute("max", "600000");
    expect(sentence(/Varv 3, 41 värderingar\./)).toBeInTheDocument();
    expect(sentence(/Hittills: 2 byten som underlättar veckan\./)).toBeInTheDocument();
    expect(sentence("Åk 9: 100,2 % → 96,4 % hittills")).toBeInTheDocument();
    // Åk 8 has not moved: said as it stands, not as an arrow from a figure to itself.
    expect(sentence("Åk 8: 91,2 %")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Avbryt sökningen" })).toBeEnabled();
  });

  it("says the best so far is shown when the search ends or is cancelled, and offers no proposal while it goes on", async () => {
    server.latest = view("RUNNING", { hasProposal: false });
    renderPanel();

    expect(await screen.findByText("Det hittills bästa förslaget kan visas när sökningen är klar eller har avbrutits.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Visa/ })).toBeNull();
  });

  it("does not promise a proposal before a move has been accepted", async () => {
    // Nothing accepted: every week's figure now is the one it began with.
    server.latest = view("RUNNING", {
      acceptedMoves: 0,
      figures: { years: [{ year: 9, weeks: [week([2280, 2275], [2280, 2275])] }], leftOut: NOTHING_LEFT_OUT },
    });
    renderPanel();

    expect(await screen.findByText(/Hittills: inget byte som underlättar veckan\./)).toBeInTheDocument();
    expect(screen.getByText("Åk 9: 100,2 %")).toBeInTheDocument();
    expect(screen.queryByText(/kan visas när sökningen/)).toBeNull();
    expect(screen.queryByText(/→/)).toBeNull();
  });

  it("says the honest limit beside the figures, as a sentence on the page, not in a tooltip", async () => {
    server.latest = view("RUNNING");
    renderPanel();

    const limit = await screen.findByText(
      "Siffrorna är motorns nedre gräns för varje årskurs och vecka. De visar att veckan går att lätta, inte att ett schema finns, och lärarnas lektioner i andra årskurser syns inte i dem. Poster som ingen leder är inte med.",
    );
    expect(limit).toBeVisible();
    expect(limit).not.toHaveAttribute("title");
    const figuresSection = limit.closest("section")!;
    expect(within(figuresSection).getByRole("heading", { name: "Tyngsta veckan i varje årskurs" })).toBeInTheDocument();
    expect(within(figuresSection).getByText("Åk 9: 100,2 % → 96,4 % hittills")).toBeInTheDocument();
  });

  it("holds only one short sentence in a live region: the figures are not read out at every poll", async () => {
    server.latest = view("RUNNING");
    renderPanel();
    await screen.findByText("Åk 9: 100,2 % → 96,4 % hittills");

    const live = screen.getAllByRole("status");
    expect(live).toHaveLength(1);
    expect(live[0]).toHaveTextContent(/^Sökningen pågår\.$/);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says that the engine has not counted the week yet when there are no figures", async () => {
    server.latest = view("PENDING", { figures: null, acceptedMoves: 0, round: 0, evaluations: 0, elapsedMs: 0, startedAt: null });
    renderPanel();

    expect(await screen.findByText("Sökningen har inte räknat veckan än.")).toBeInTheDocument();
    expect(screen.getByText("Tid använd: 0 s av 10 min")).toBeInTheDocument();
    // The limit is said all the same.
    expect(screen.getByText(/Siffrorna är motorns nedre gräns/)).toBeInTheDocument();
  });

  it("says what the search left untouched while it goes on: how many posts under each reason, and each year it did not judge, in a section of its own", async () => {
    server.latest = view("RUNNING", { figures: figures(EVERYTHING_LEFT_OUT) });
    renderPanel();

    const heading = await screen.findByRole("heading", { name: LEFT_OUT_TITLE, level: 4 });
    const section = heading.closest("section")!;
    // One line per reason and one per year, in order, and nothing else in the list.
    const items = within(section).getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual(LEFT_OUT_LINES);
    // The section is its own: neither the figures' nor the honest limit sits in it, and it is not a live region.
    expect(within(section).queryByText(/nedre gräns/)).toBeNull();
    expect(within(section).queryByRole("status")).toBeNull();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    // The old sentences are gone.
    expect(screen.queryByText(/släppt post ingår inte|kan inte byta lärare: ingen annan får ta den, eller/)).toBeNull();
  });

  it("says one post in the singular, and only the reasons that have posts", async () => {
    server.latest = view("RUNNING", {
      figures: figures({ posts: [{ reason: "UNSTAFFED", count: 1 }], years: [] }),
    });
    renderPanel();

    const heading = await screen.findByRole("heading", { name: LEFT_OUT_TITLE });
    const items = within(heading.closest("section")!).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent(/^1 post saknar lärare och söks inte: att bemanna den är en fråga för Föreslå bemanning/);
  });

  it("says a year that was not judged although no post is counted, and a post count although no year is named", async () => {
    server.latest = view("RUNNING", { figures: figures({ posts: [], years: [{ year: 6, reason: "YEAR_LIMIT" }] }) });
    renderPanel();
    const heading = await screen.findByRole("heading", { name: LEFT_OUT_TITLE });
    expect(within(heading.closest("section")!).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Åk 6 värderades inte: sökningen värderar högst fyra årskurser, de trängsta.",
    ]);
    cleanup();

    server.latest = view("RUNNING", { figures: figures({ posts: [{ reason: "NO_CHOICE", count: 5 }], years: [] }) });
    renderPanel();
    const again = await screen.findByRole("heading", { name: LEFT_OUT_TITLE });
    expect(within(again.closest("section")!).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByText(/Åk \d+ värderades inte/)).toBeNull();
  });

  it("renders nothing, not even the heading, when nothing was left out or the run has no figures yet", async () => {
    server.latest = view("RUNNING", { figures: figures(NOTHING_LEFT_OUT) });
    renderPanel();
    await screen.findByText("Åk 9: 100,2 % → 96,4 % hittills");
    expect(screen.queryByText(LEFT_OUT_TITLE)).toBeNull();
    cleanup();

    server.latest = view("PENDING", { figures: null, acceptedMoves: 0, round: 0, evaluations: 0, elapsedMs: 0, startedAt: null });
    renderPanel();
    await screen.findByText("Sökningen har inte räknat veckan än.");
    expect(screen.queryByText(LEFT_OUT_TITLE)).toBeNull();
    cleanup();

    // A reason with a count of nothing is not a line.
    server.latest = view("RUNNING", { figures: figures({ posts: [{ reason: "NOT_FREE", count: 0 }], years: [] }) });
    renderPanel();
    await screen.findByText("Åk 9: 100,2 % → 96,4 % hittills");
    expect(screen.queryByText(LEFT_OUT_TITLE)).toBeNull();
  });

  it("stops it when asked, says it is being cancelled and takes the button away: the run goes on until its task sees it", async () => {
    server.latest = view("RUNNING");
    gateway.post.mockImplementation(async (path: string) => {
      if (path === `${BASE}/run-1/cancel`) {
        server.latest = view("CANCELLING");
        return server.latest;
      }
      throw new Error(`unexpected POST ${path}`);
    });
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "Avbryt sökningen" }));

    expect(posts()).toEqual([{ path: `${BASE}/run-1/cancel`, body: undefined }]);
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Sökningen avbryts …"));
    expect(screen.queryByRole("button", { name: "Avbryt sökningen" })).toBeNull();
    // Focus did not fall with the button.
    await waitFor(() => expect(screen.getByRole("heading", { name: "Sök lärarval", level: 3 })).toHaveFocus());
  });

  it("says a cancel that did not go through, and leaves the button", async () => {
    server.latest = view("RUNNING");
    gateway.post.mockRejectedValueOnce(new ApiError(500, "Internal"));
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "Avbryt sökningen" }));

    expect(await screen.findByText("Sökningen kunde inte avbrytas just nu. Försök igen.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Avbryt sökningen" })).toBeEnabled();
  });

  it("is read again every few seconds and turns into the ended search when the gateway says it has ended", async () => {
    vi.useFakeTimers();
    notifyManager.setScheduler((callback) => callback());
    try {
      server.latest = view("RUNNING");
      renderPanel();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByRole("status")).toHaveTextContent("Sökningen pågår.");

      server.latest = ended("SUCCEEDED", "LOCAL_OPTIMUM", { hasProposal: true, elapsedMs: 200_000 });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(STAFFING_SEARCH_POLL_MS);
      });
      expect(screen.getByRole("status")).toHaveTextContent("Sökningen är klar.");
      expect(screen.getByRole("button", { name: "Visa förslaget" })).toBeEnabled();

      const reads = gateway.get.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10 * STAFFING_SEARCH_POLL_MS);
      });
      expect(gateway.get).toHaveBeenCalledTimes(reads);
    } finally {
      notifyManager.setScheduler((callback) => setTimeout(callback, 0));
      vi.useRealTimers();
    }
  });

  it("says that what is shown may be old when a read fails, keeps the figures it has, and reads again on Försök igen", async () => {
    server.latest = view("RUNNING");
    const user = userEvent.setup();
    const { queryClient } = renderPanel();
    await screen.findByText("Åk 9: 100,2 % → 96,4 % hittills");

    gateway.get.mockRejectedValueOnce(new ApiError(404, "gone"));
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: latestSearchKey(YEAR) });
    });
    expect(await screen.findByText(/kan vara äldre/)).toBeInTheDocument();
    expect(screen.getByText("Åk 9: 100,2 % → 96,4 % hittills")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Försök igen" }));
    await waitFor(() => expect(screen.queryByText(/kan vara äldre/)).toBeNull());
  });
});

describe("a search that has ended", () => {
  const cases: [string, StaffingSearchView, string | RegExp][] = [
    [
      "nothing to win",
      ended("SUCCEEDED", "NOT_TIGHT", { acceptedMoves: 0 }),
      "Veckan ligger redan under 85 % i de årskurser som kan påverkas: det finns inget att vinna.",
    ],
    [
      "no released post has another teacher",
      ended("SUCCEEDED", "NO_MOVES", { acceptedMoves: 0, figures: null }),
      "Ingen släppt post har en annan lärare som får ta den, så det finns inget byte att pröva.",
    ],
    ["a local optimum with nothing found", ended("SUCCEEDED", "LOCAL_OPTIMUM", { acceptedMoves: 0 }), "Inget av de byten och parbyten som sökningen prövade gör veckan lättare."],
    [
      "a local optimum with moves",
      ended("SUCCEEDED", "LOCAL_OPTIMUM", { acceptedMoves: 3, hasProposal: true }),
      "Inget av de byten och parbyten som sökningen prövade gör veckan lättare än så här. Bästa läget sökningen hittade har 3 byten.",
    ],
    [
      "some moves could not be counted to the end: no local optimum is claimed",
      ended("SUCCEEDED", "NOT_ALL_COUNTED", { acceptedMoves: 3, hasProposal: true }),
      /Inget fler byte som motorn räknade klart gör veckan lättare än så här, men en del byten gick inte att räkna till slut.*Bästa läget sökningen hittade har 3 byten\./,
    ],
    [
      "none could be counted to the end and nothing was found",
      ended("SUCCEEDED", "NOT_ALL_COUNTED", { acceptedMoves: 0 }),
      /Det är alltså inte visat att inget byte hjälper/,
    ],
    [
      "the time ran out",
      ended("SUCCEEDED", "BUDGET", { acceptedMoves: 1, hasProposal: true }),
      "Sökningen stannade för att tiden tog slut, inte för att inget mer gick att vinna: med mer tid kan den hitta fler byten. Bästa läget hittills har 1 byte.",
    ],
    [
      "the time ran out before anything was found",
      ended("SUCCEEDED", "BUDGET", { acceptedMoves: 0 }),
      "Sökningen stannade för att tiden tog slut innan den hittade något byte som gör veckan lättare. Med mer tid kan den hitta fler.",
    ],
    [
      "the rounds ran out",
      ended("SUCCEEDED", "MAX_ROUNDS", { acceptedMoves: 4, hasProposal: true }),
      "Sökningen stannade vid sin gräns för antal varv: fler varv kan hitta fler byten. Bästa läget hittills har 4 byten.",
    ],
    [
      "the evaluations ran out",
      ended("SUCCEEDED", "MAX_EVALUATIONS", { acceptedMoves: 2, hasProposal: true }),
      "Sökningen stannade vid sin gräns för antal värderingar: fler värderingar kan hitta fler byten. Bästa läget hittills har 2 byten.",
    ],
    [
      "cancelled with moves",
      ended("CANCELLED", "CANCELLED", { acceptedMoves: 2, hasProposal: true }),
      "Sökningen avbröts. Bästa läget den hann hitta har 2 byten.",
    ],
    [
      "cancelled before anything was found",
      ended("CANCELLED", "CANCELLED", { acceptedMoves: 0, figures: null }),
      "Sökningen avbröts innan den hann hitta något byte som gör veckan lättare.",
    ],
  ];

  it.each(cases)("says %s", async (_name, run, text) => {
    server.latest = run;
    renderPanel();

    expect(await screen.findByText(text)).toBeInTheDocument();
    // However it ended, what its figures are is said beside them, and nothing of it is a live region but the short sentence.
    expect(screen.getByText(/Siffrorna är motorns nedre gräns/)).toBeInTheDocument();
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status").textContent!.length).toBeLessThan(40);
  });

  it("shows the best state as each year's tightest week before → after, and the number of moves, when there are moves", async () => {
    server.latest = ended("SUCCEEDED", "LOCAL_OPTIMUM", { acceptedMoves: 3, hasProposal: true });
    renderPanel();

    expect(await screen.findByText("Åk 9: 100,2 % → 96,4 %")).toBeInTheDocument();
    expect(screen.getByText("Åk 8: 91,2 %")).toBeInTheDocument();
    expect(screen.queryByText(/hittills$/)).toBeNull();
  });

  it("names no teacher and no post: the panel's text is the year's figures and counts", async () => {
    server.latest = ended("SUCCEEDED", "LOCAL_OPTIMUM", { acceptedMoves: 3, hasProposal: true });
    renderPanel();
    await screen.findByText("Åk 9: 100,2 % → 96,4 %");

    expect(document.body.textContent).not.toMatch(/Anna|Bo |lärare:|[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it.each([
    ["SEARCH_ABANDONED", "Tjänsten startades om medan sökningen pågick, så sökningen stannade."],
    ["SEARCH_INTERRUPTED", "Tjänsten startades om medan sökningen pågick, så sökningen stannade."],
    [
      "SEARCH_START_REFUSED",
      "Motorn nekar veckan som den står redan vid en snabb räkning, så det är inte valet av lärare som är problemet. Åtgärda det först (Kontrollera veckan visar vad som nekas) och sök igen.",
    ],
    [
      "SEARCH_START_NOT_EXACT",
      "Ingen årskurs hann räknas till slut inom de sekunder motorn har för en räkning, så sökningen har inget att jämföra med. Försök igen om en stund.",
    ],
    [
      "SEARCH_ENGINE_OLDER",
      "Schemamotorn är äldre än API:t och kan inte räkna veckan för en sökning ännu. Det brukar vara uppdaterat inom några minuter: försök igen då.",
    ],
    ["SEARCH_ENGINE_FAILING", "Motorn misslyckades med flera räkningar i rad, så sökningen stannade. Försök igen om en stund."],
    [
      "SEARCH_ENGINE_BUSY",
      "Motorn var upptagen för länge (den delas med andra skolor), så sökningen stannade. Väntan räknas inte in i sökningens tid. Försök igen om en stund.",
    ],
    ["SEARCH_FAILED", "Sökningen misslyckades. Ingenting har ändrats. Försök igen."],
    ["SOME_CODE_FROM_A_NEWER_GATEWAY", "Sökningen misslyckades. Ingenting har ändrats. Försök igen."],
  ])("says a failed search by its code (%s), never by the gateway's English", async (code, text) => {
    server.latest = ended("FAILED", null, { errorCode: code, error: "The gateway's English", acceptedMoves: 0, figures: null });
    renderPanel();

    expect(await screen.findByText(text)).toBeInTheDocument();
    expect(screen.queryByText("The gateway's English")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Sökningen stannade.");
    expect(screen.getByRole("button", { name: "Sök igen" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /Visa/ })).toBeNull();
  });

  it("says that a restarted service stopped the search, and still offers the best it had found when it had found something", async () => {
    server.latest = ended("FAILED", null, { errorCode: "SEARCH_INTERRUPTED", acceptedMoves: 2, hasProposal: true });
    renderPanel();

    expect(
      await screen.findByText(/Tjänsten startades om medan sökningen pågick, så sökningen stannade\. Bästa läget den hann hitta har 2 byten och kan visas\./),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Visa det hittills bästa" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Sök igen" })).toBeEnabled();
  });

  it("says a search the engine kept waiting too long, by its stop as well as its code, and still offers the best it had found", async () => {
    server.latest = ended("FAILED", "ENGINE_BUSY", { errorCode: "SEARCH_ENGINE_BUSY", acceptedMoves: 2, hasProposal: true });
    renderPanel();

    expect(
      await screen.findByText(
        /Motorn var upptagen för länge \(den delas med andra skolor\), så sökningen stannade\. Väntan räknas inte in i sökningens tid\. Försök igen om en stund\. Bästa läget den hann hitta har 2 byten och kan visas\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Visa det hittills bästa" })).toBeEnabled();
    cleanup();

    // Without the code, the stop alone gives the same sentence.
    server.latest = ended("FAILED", "ENGINE_BUSY", { errorCode: null, acceptedMoves: 0, figures: null });
    renderPanel();
    expect(await screen.findByText(/Motorn var upptagen för länge/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Visa/ })).toBeNull();
  });

  it.each([
    ["it ended with a proposal", ended("SUCCEEDED", "LOCAL_OPTIMUM", { acceptedMoves: 3, hasProposal: true, figures: figures(EVERYTHING_LEFT_OUT) })],
    ["it was cancelled", ended("CANCELLED", "CANCELLED", { acceptedMoves: 1, hasProposal: true, figures: figures(EVERYTHING_LEFT_OUT) })],
    ["it failed with moves in hand", ended("FAILED", "ENGINE_BUSY", { errorCode: "SEARCH_ENGINE_BUSY", acceptedMoves: 1, hasProposal: true, figures: figures(EVERYTHING_LEFT_OUT) })],
    ["it found nothing", ended("SUCCEEDED", "LOCAL_OPTIMUM", { acceptedMoves: 0, figures: figures(EVERYTHING_LEFT_OUT) })],
  ])("says what the search left untouched when %s, in the same lines as while it went on", async (_name, run) => {
    server.latest = run;
    renderPanel();

    const heading = await screen.findByRole("heading", { name: LEFT_OUT_TITLE, level: 4 });
    expect(within(heading.closest("section")!).getAllByRole("listitem").map((item) => item.textContent)).toEqual(LEFT_OUT_LINES);
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("says what a search with no judged year left untouched: no year line, but the posts it did not search, and the honest limit", async () => {
    // NO_MOVES: the figures hold no year (nothing was counted), but the posts were still counted under their reasons.
    server.latest = ended("SUCCEEDED", "NO_MOVES", {
      acceptedMoves: 0,
      figures: { years: [], leftOut: { posts: [{ reason: "NOT_FREE", count: 4 }, { reason: "UNSTAFFED", count: 2 }], years: [] } },
    });
    renderPanel();

    const heading = await screen.findByRole("heading", { name: LEFT_OUT_TITLE });
    expect(within(heading.closest("section")!).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("4 poster är inte släppta åt motorn, eller är fästa, och behåller sina lärare.")).toBeInTheDocument();
    expect(screen.getByText(/Siffrorna är motorns nedre gräns/)).toBeInTheDocument();
  });

  it("renders nothing of it for an ended search that left nothing out", async () => {
    server.latest = ended("SUCCEEDED", "LOCAL_OPTIMUM", { acceptedMoves: 3, hasProposal: true });
    renderPanel();
    await screen.findByText("Åk 9: 100,2 % → 96,4 %");
    expect(screen.queryByText(LEFT_OUT_TITLE)).toBeNull();
  });

  it("searches again with Sök igen: a new start, and the new run replaces the ended one", async () => {
    server.latest = ended("SUCCEEDED", "NOT_TIGHT", { acceptedMoves: 0 });
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "Sök igen" }));

    expect(posts()).toEqual([{ path: BASE, body: { academicYearId: YEAR } }]);
    expect(await screen.findByRole("button", { name: "Avbryt sökningen" })).toBeInTheDocument();
  });
});

describe("the proposal", () => {
  it("is offered only when the run has ended with a proposal: Visa förslaget for a search that finished, the best so far for one that was cancelled", async () => {
    server.latest = ended("SUCCEEDED", "LOCAL_OPTIMUM", { acceptedMoves: 3, hasProposal: true });
    renderPanel();
    expect(await screen.findByRole("button", { name: "Visa förslaget" })).toBeEnabled();
    cleanup();

    server.latest = ended("CANCELLED", "CANCELLED", { acceptedMoves: 1, hasProposal: true });
    renderPanel();
    expect(await screen.findByRole("button", { name: "Visa det hittills bästa" })).toBeEnabled();
    cleanup();

    server.latest = ended("SUCCEEDED", "LOCAL_OPTIMUM", { acceptedMoves: 0, hasProposal: false });
    renderPanel();
    await screen.findByText("Inget av de byten och parbyten som sökningen prövade gör veckan lättare.");
    expect(screen.queryByRole("button", { name: /Visa/ })).toBeNull();
  });

  it("is read from the run's proposal route and handed to the dialog whole", async () => {
    server.latest = ended("SUCCEEDED", "LOCAL_OPTIMUM", { acceptedMoves: 3, hasProposal: true });
    const user = userEvent.setup();
    const { onProposal } = renderPanel();
    await user.click(await screen.findByRole("button", { name: "Visa förslaget" }));

    await waitFor(() => expect(onProposal).toHaveBeenCalledTimes(1));
    // The run's figures are not in the answer here: the dialog is told so, with null, and says nothing of what was left out.
    expect(onProposal).toHaveBeenCalledWith(PROPOSAL, null);
    expect(gateway.get).toHaveBeenCalledWith(`${BASE}/run-1/proposal`);
  });

  it("hands over the figures the run kept with it, so that the dialog can say what was left out beside the proposal", async () => {
    server.latest = ended("SUCCEEDED", "LOCAL_OPTIMUM", { acceptedMoves: 3, hasProposal: true });
    const kept = figures(EVERYTHING_LEFT_OUT);
    server.proposal = { proposal: PROPOSAL, figures: kept };
    const user = userEvent.setup();
    const { onProposal } = renderPanel();
    await user.click(await screen.findByRole("button", { name: "Visa förslaget" }));

    await waitFor(() => expect(onProposal).toHaveBeenCalledTimes(1));
    expect(onProposal).toHaveBeenCalledWith(PROPOSAL, kept);
  });

  it("hands over null for figures a gateway left out of its answer", async () => {
    server.latest = ended("SUCCEEDED", "LOCAL_OPTIMUM", { acceptedMoves: 3, hasProposal: true });
    server.proposal = { proposal: PROPOSAL };
    const user = userEvent.setup();
    const { onProposal } = renderPanel();
    await user.click(await screen.findByRole("button", { name: "Visa förslaget" }));

    await waitFor(() => expect(onProposal).toHaveBeenCalledTimes(1));
    expect(onProposal).toHaveBeenCalledWith(PROPOSAL, null);
  });

  it("says a proposal that has gone old, offers a new search and no proposal, and hands nothing over", async () => {
    server.latest = ended("SUCCEEDED", "LOCAL_OPTIMUM", { acceptedMoves: 3, hasProposal: true });
    gateway.get.mockImplementation(async (path: string) => {
      if (path === LATEST) return server.latest;
      throw new ApiError(409, "The proposal is old", "STAFF_PROPOSAL_STALE");
    });
    const user = userEvent.setup();
    const { onProposal } = renderPanel();
    await user.click(await screen.findByRole("button", { name: "Visa förslaget" }));

    expect(
      await screen.findByText("Förslaget är gammalt: tjänstefördelningen, släppningarna eller veckan har ändrats sedan sökningen. Sök igen."),
    ).toBeInTheDocument();
    expect(onProposal).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /Visa/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Sök igen" })).toBeEnabled();
    // Said at once to a screen reader: the sentence is an alert, and the one status sentence is unchanged.
    expect(screen.getByRole("alert")).toHaveTextContent(/Förslaget är gammalt/);
  });

  it("says a run that is gone, and reads the runs again", async () => {
    server.latest = ended("SUCCEEDED", "LOCAL_OPTIMUM", { acceptedMoves: 3, hasProposal: true });
    gateway.get.mockImplementation(async (path: string) => {
      if (path === LATEST) return server.latest;
      server.latest = null;
      throw new ApiError(404, "Sökningen finns inte längre.", "STAFFING_SEARCH_GONE");
    });
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "Visa förslaget" }));

    expect(await screen.findByRole("button", { name: "Sök lärarval" })).toBeInTheDocument();
    expect(screen.getByText("Sökningen finns inte längre. Sök igen.")).toBeInTheDocument();
  });

  it("says another failure in the gateway's own words, when a thrower wrote them for the reader, and lets the admin press again", async () => {
    server.latest = ended("SUCCEEDED", "LOCAL_OPTIMUM", { acceptedMoves: 3, hasProposal: true });
    gateway.get.mockImplementation(async (path: string) => {
      if (path === LATEST) return server.latest;
      throw new ApiError(500, "Förslaget kunde inte läsas just nu.");
    });
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "Visa förslaget" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Förslaget kunde inte läsas just nu.");
    expect(screen.getByRole("button", { name: "Visa förslaget" })).toBeEnabled();
  });

  it("says the general sentence, in the reader's language, for a failure whose words are only a log's", async () => {
    server.latest = ended("SUCCEEDED", "LOCAL_OPTIMUM", { acceptedMoves: 3, hasProposal: true });
    gateway.get.mockImplementation(async (path: string) => {
      if (path === LATEST) return server.latest;
      throw new ApiError(500, "Internal server error");
    });
    const user = userEvent.setup();
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "Visa förslaget" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Något gick fel");
    expect(alert).not.toHaveTextContent("Internal server error");
    expect(screen.getByRole("button", { name: "Visa förslaget" })).toBeEnabled();
  });
});

describe("in English", () => {
  it("says a running search with the decimal point and the same figures, from the same keys", async () => {
    server.latest = view("RUNNING");
    renderPanel({}, { locale: "en", messages: en as unknown as Messages });

    expect(await screen.findByText("Time used: 1 min 20 s of 10 min")).toBeInTheDocument();
    expect(screen.getByText("Year 9: 100.2 % → 96.4 % so far")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("The search is running.");
    expect(screen.getByRole("button", { name: "Cancel the search" })).toBeInTheDocument();
    expect(screen.getByText(/The figures are the engine's lower bound/)).toBeInTheDocument();
  });

  it("says an ended search and its proposal", async () => {
    server.latest = ended("SUCCEEDED", "BUDGET", { acceptedMoves: 1, hasProposal: true });
    renderPanel({}, { locale: "en", messages: en as unknown as Messages });

    expect(await screen.findByText(/The search stopped because the time ran out, not because nothing more could be gained/)).toBeInTheDocument();
    expect(screen.getByText("Year 9: 100.2 % → 96.4 %")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show the proposal" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Search again" })).toBeInTheDocument();
  });

  it("says what the search left untouched, with the plural where there are several", async () => {
    server.latest = ended("SUCCEEDED", "LOCAL_OPTIMUM", {
      acceptedMoves: 1,
      hasProposal: true,
      figures: figures({
        posts: [
          { reason: "NOT_FREE", count: 1 },
          { reason: "NO_CHOICE", count: 2 },
        ],
        years: [{ year: 7, reason: "YEAR_NOT_COUNTED" }],
      }),
    });
    renderPanel({}, { locale: "en", messages: en as unknown as Messages });

    const heading = await screen.findByRole("heading", { name: "What the search left alone" });
    expect(within(heading.closest("section")!).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "1 entry is not released for the engine, or is pinned, and keeps its teacher.",
      "2 entries have nobody else who may take them (qualification, employment rate or co-teacher) and cannot change teacher.",
      "Year 7 was not judged: the week could not be counted to the end as it stands today.",
    ]);
  });

  it("says a search the engine kept waiting too long", async () => {
    server.latest = ended("FAILED", "ENGINE_BUSY", { errorCode: "SEARCH_ENGINE_BUSY", acceptedMoves: 0, figures: null });
    renderPanel({}, { locale: "en", messages: en as unknown as Messages });
    expect(await screen.findByText(/The engine was busy for too long \(it is shared with other schools\)/)).toBeInTheDocument();
  });

  it("says each refusal of a start and each failure of a run in a sentence", async () => {
    server.latest = ended("FAILED", null, { errorCode: "SEARCH_ENGINE_OLDER", acceptedMoves: 0, figures: null });
    renderPanel({}, { locale: "en", messages: en as unknown as Messages });
    expect(await screen.findByText(/The scheduling engine is older than the API/)).toBeInTheDocument();
  });
});

describe("StaffingSearchLeftOut, the lines the dialog shows under a proposal too", () => {
  function renderLeftOut(props: Parameters<typeof StaffingSearchLeftOut>[0], { locale = "sv", messages = sv }: { locale?: string; messages?: Messages } = {}) {
    render(
      <NextIntlClientProvider
        locale={locale}
        messages={messages}
        timeZone="Europe/Stockholm"
        onError={(error) => {
          throw error;
        }}
      >
        <StaffingSearchLeftOut {...props} />
      </NextIntlClientProvider>,
    );
  }

  it("is a heading and a list of the same lines the panel says, labelled by the heading", () => {
    renderLeftOut({ leftOut: EVERYTHING_LEFT_OUT });

    const section = screen.getByRole("region", { name: LEFT_OUT_TITLE });
    expect(within(section).getByRole("heading", { name: LEFT_OUT_TITLE, level: 4 })).toBeInTheDocument();
    expect(within(section).getAllByRole("listitem").map((item) => item.textContent)).toEqual(LEFT_OUT_LINES);
  });

  it("takes the heading's level from where it is shown", () => {
    renderLeftOut({ leftOut: EVERYTHING_LEFT_OUT, level: 3 });
    expect(screen.getByRole("heading", { name: LEFT_OUT_TITLE, level: 3 })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 4 })).toBeNull();
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an empty answer", NOTHING_LEFT_OUT],
  ])("renders nothing for %s", (_name, leftOut) => {
    renderLeftOut({ leftOut });
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(document.body.textContent).toBe("");
  });

  it("names no teacher, no post and no id: counts and years only", () => {
    renderLeftOut({ leftOut: EVERYTHING_LEFT_OUT });
    expect(document.body.textContent).not.toMatch(/Anna|Bo |[0-9a-f]{8}-[0-9a-f]{4}/);
  });
});
