import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { ApiError, api } from "@/lib/api";
import type { BoardRequest } from "@/lib/cover-request-types";
import type { Board, BoardItem, Candidates } from "@/lib/cover-types";
import { lastDays } from "@/lib/cover-request-view";
import { toDateString } from "@/lib/utils";
import { CoverBoard } from "./cover-board";

Element.prototype.hasPointerCapture ??= () => false;
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
Element.prototype.scrollIntoView ??= () => {};
globalThis.ResizeObserver ??= class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
};

/**
 * Vikariefrågan on Vikarietavla over the real hooks and the real Swedish
 * messages: asking colleagues from the ranked suggestions of one lesson and
 * from a selection of several, what each pair says of its request, withdrawing
 * one, every refusal in words, the fairness view beside the counter, and that
 * every new write is Drift's (so a reading administrator is shown none).
 *
 * The lessons are in 2030, so none has started when the test runs.
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } };
});
const get = api.get as unknown as Mock;
const post = api.post as unknown as Mock;

vi.mock("@/lib/queries", () => ({
  usePeople: () => ({
    data: [
      { id: "t-anna", role: "TEACHER", isActive: true, firstName: "Anna", lastName: "Lind" },
      { id: "t-bo", role: "TEACHER", isActive: true, firstName: "Bo", lastName: "Ek" },
      { id: "t-cia", role: "TEACHER", isActive: true, firstName: "Cia", lastName: "Holm" },
      { id: "t-dan", role: "TEACHER", isActive: true, firstName: "Dan", lastName: "Ström" },
      { id: "t-eva", role: "TEACHER", isActive: true, firstName: "Eva", lastName: "Berg" },
    ],
  }),
  useSubjects: () => ({
    data: [
      { id: "s-ma", name: "Matematik" },
      { id: "s-en", name: "Engelska" },
      { id: "s-sv", name: "Svenska" },
      { id: "s-no", name: "Naturkunskap" },
      { id: "s-hi", name: "Historia" },
      { id: "s-ge", name: "Geografi" },
      { id: "s-fy", name: "Fysik" },
    ],
  }),
  useGroups: () => ({ data: [{ id: "g-7a", name: "7A" }, { id: "g-8b", name: "8B" }] }),
  useRooms: () => ({ data: [{ id: "r-12", name: "Sal 12" }] }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const DATE = "2030-10-14";

function pair(lessonId: string, subjectId: string, hour: number, overrides: Partial<BoardItem> = {}): BoardItem {
  const at = (h: number) => `${DATE}T${String(h).padStart(2, "0")}:00:00.000Z`;
  return {
    absenceId: "a-anna",
    absentTeacherId: "t-anna",
    absentRole: "LEAD",
    lessonId,
    date: DATE,
    startsAt: at(hour),
    endsAt: at(hour + 1),
    subjectId,
    studentGroupId: "g-7a",
    extraGroupIds: [],
    roomId: null,
    lessonStatus: "SCHEDULED",
    cancelCause: null,
    teachers: [{ teacherId: "t-anna", role: "LEAD" }],
    substituteId: null,
    decision: null,
    decidedAt: null,
    status: "OPEN",
    decisionStale: false,
    passed: false,
    outsideAbsence: false,
    ...overrides,
  };
}

const covered = (lessonId: string, subjectId: string, hour: number, substituteId: string) =>
  pair(lessonId, subjectId, hour, {
    substituteId,
    decision: "SUBSTITUTE",
    status: "COVERED",
    teachers: [{ teacherId: substituteId, role: "SUBSTITUTE" }],
  });

const ITEMS: BoardItem[] = [
  pair("l-ma", "s-ma", 6), // open, never asked
  pair("l-en", "s-en", 7), // an open request stands
  covered("l-sv", "s-sv", 8, "t-dan"), // covered by a request's yes, confirmed
  covered("l-no", "s-no", 9, "t-cia"), // covered directly, not confirmed
  pair("l-hi", "s-hi", 10), // the request ran out
  pair("l-ge", "s-ge", 11, { lessonStatus: "CANCELLED", status: "CANCELLED", decision: "CANCELLED", cancelCause: "EVENT" }),
  pair("l-fy", "s-fy", 12), // the request was withdrawn
];

const request = (id: string, status: BoardRequest["status"], lessonId: string, overrides: Partial<BoardRequest> = {}): BoardRequest => ({
  id,
  status,
  createdAt: `${DATE}T01:00:00.000Z`,
  expiresAt: `${DATE}T05:30:00.000Z`,
  requestedByUserId: "u-admin",
  acceptedByUserId: null,
  pairs: [{ absenceId: "a-anna", lessonId }],
  recipients: [
    { userId: "t-bo", answer: "PENDING", answeredAt: null },
    { userId: "t-cia", answer: "DECLINED", answeredAt: `${DATE}T01:10:00.000Z` },
    { userId: "t-eva", answer: "PENDING", answeredAt: null },
  ],
  ...overrides,
});

const BOARD: Board = {
  from: DATE,
  to: DATE,
  items: ITEMS,
  summary: { open: 3, covered: 2, cancelled: 1, handled: 0, passedOpen: 0 },
  absences: [{ id: "a-anna", userId: "t-anna", startsAt: `${DATE}T00:00:00Z`, endsAt: "2030-10-15T00:00:00Z" }],
  requests: [
    request("r-open", "OPEN", "l-en"),
    request("r-yes", "ACCEPTED", "l-sv", { acceptedByUserId: "t-dan" }),
    request("r-out", "EXPIRED", "l-hi"),
    request("r-back", "WITHDRAWN", "l-fy"),
  ],
  confirmations: [{ absenceId: "a-anna", lessonId: "l-sv", userId: "t-dan", confirmedAt: `${DATE}T02:00:00.000Z` }],
};

const candidates = (lessonId: string, list: [string, number][], excluded: Candidates["excluded"] = []): Candidates => ({
  lessonId,
  candidates: list.map(([userId, score]) => ({
    userId,
    kind: userId === "t-cia" ? ("POOL" as const) : ("STAFF" as const),
    score,
    qualificationKind: null,
    reasons: [{ code: "GAP_FILL", params: {}, points: score }],
    counter: { weekLessons: 1, termLessons: 4 },
    load: { weekMinutes: 600, targetMinutes: null },
  })),
  excluded,
});

const CANDIDATES: Record<string, Candidates> = {
  "l-ma": candidates("l-ma", [["t-bo", 52], ["t-cia", 10], ["t-eva", 5]], [{ userId: "t-dan", codes: [{ code: "ABSENT", params: {} }] }]),
  "l-hi": candidates("l-hi", [["t-bo", 30], ["t-dan", 20]]),
  "l-en": candidates("l-en", [["t-bo", 40]]),
};

const FAIRNESS = {
  from: lastDays(toDateString(new Date())).from,
  to: toDateString(new Date()),
  rows: [
    { userId: "t-bo", received: 2, accepted: 1, declined: 0, unanswered: 1 },
    { userId: "t-eva", received: 5, accepted: 0, declined: 3, unanswered: 2 },
    { userId: "t-anna", received: 2, accepted: 0, declined: 1, unanswered: 1 },
  ],
};

function answer(overrides: Partial<Record<string, unknown>> = {}) {
  get.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/v1/cover/board")) return overrides.board ?? BOARD;
    if (path.startsWith("/api/v1/cover/counter")) return { date: DATE, rows: [] };
    if (path.startsWith("/api/v1/cover/fairness")) return overrides.fairness ?? FAIRNESS;
    if (path === "/api/v1/retention/purged-before") return [];
    const match = /\/api\/v1\/cover\/lessons\/([^/]+)\/candidates$/.exec(path);
    if (match) return CANDIDATES[match[1]!] ?? candidates(match[1]!, []);
    throw new Error(`unexpected GET ${path}`);
  });
}

function renderBoard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <NextIntlClientProvider locale="sv" messages={sv} timeZone="Europe/Stockholm">
        <CoverBoard initialDate={DATE} initialView="day" />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const table = () => screen.getByRole("table", { name: /^Lektioner som behöver vikarie/ });
const rowOf = (subject: string) => within(table()).getByRole("cell", { name: subject }).closest("tr")!;
const tickAll = async (user: ReturnType<typeof userEvent.setup>) => {
  for (const box of within(table()).getAllByRole("checkbox")) await user.click(box);
};

beforeEach(() => {
  vi.resetAllMocks();
  answer();
});

describe("what a pair says of its request", () => {
  it("says how many colleagues were asked and how many said no, until when, and offers Dra tillbaka", async () => {
    renderBoard();
    await screen.findByRole("cell", { name: "Engelska" });
    const row = within(rowOf("Engelska"));
    expect(row.getByText("Fråga skickad till 3 kollegor (1 har tackat nej)")).toBeInTheDocument();
    expect(row.getByText(/^Gäller till \d{2}:\d{2}$/)).toBeInTheDocument();
    expect(row.getByRole("button", { name: /^Dra tillbaka Anna Lind/ })).toBeInTheDocument();
    // A pair nobody was asked about says nothing of requests.
    expect(within(rowOf("Matematik")).queryByText(/Fråga skickad/)).not.toBeInTheDocument();
    expect(within(rowOf("Matematik")).queryByRole("button", { name: /Dra tillbaka/ })).not.toBeInTheDocument();
  });

  it("says 'Tillsatt via förfrågan' on the covered pair a yes placed, and whether the vikarie has confirmed", async () => {
    renderBoard();
    await screen.findByRole("cell", { name: "Svenska" });
    expect(within(rowOf("Svenska")).getByText("Tillsatt via förfrågan")).toBeInTheDocument();
    expect(within(rowOf("Svenska")).getByText("Bekräftad av vikarien")).toBeInTheDocument();
    // Covered directly, nobody has tapped: not a request, and not confirmed.
    expect(within(rowOf("Naturkunskap")).queryByText("Tillsatt via förfrågan")).not.toBeInTheDocument();
    expect(within(rowOf("Naturkunskap")).getByText("Inte bekräftad")).toBeInTheDocument();
  });

  it("says in muted words that a question ran out or was withdrawn, and still offers a new one", async () => {
    renderBoard();
    await screen.findByRole("cell", { name: "Historia" });
    expect(within(rowOf("Historia")).getByText("Gick ut")).toBeInTheDocument();
    expect(within(rowOf("Historia")).getByText("Gick ut")).toHaveClass("text-muted-foreground");
    expect(within(rowOf("Fysik")).getByText("Återkallad")).toBeInTheDocument();
    expect(within(rowOf("Fysik")).getByText("Återkallad")).toHaveClass("text-muted-foreground");
    const user = userEvent.setup();
    await user.click(within(rowOf("Historia")).getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Fråga kollegor (1)" })).toBeEnabled();
  });

  it("reads the requests and the confirmations off an older gateway's board as none", async () => {
    answer({ board: { ...BOARD, requests: undefined, confirmations: undefined } });
    renderBoard();
    await screen.findByRole("cell", { name: "Svenska" });
    expect(screen.queryByText(/Fråga skickad|Tillsatt via förfrågan/)).not.toBeInTheDocument();
    expect(within(rowOf("Svenska")).getByText("Inte bekräftad")).toBeInTheDocument();
  });
});

describe("Fråga kollegor", () => {
  it("is offered from the ranked suggestions of an open lesson, not on a pair with an open request", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByRole("cell", { name: "Matematik" });
    await user.click(within(rowOf("Matematik")).getByRole("button", { name: /^Tillsätt vikarie/ }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByRole("button", { name: "Fråga kollegor" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Avbryt" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // The pair with an open request must not be asked twice (COVER_REQUEST_EXISTS).
    await user.click(within(rowOf("Engelska")).getByRole("button", { name: /^Tillsätt vikarie/ }));
    const second = await screen.findByRole("dialog");
    await within(second).findByRole("button", { name: /Bo Ek/ });
    expect(within(second).queryByRole("button", { name: "Fråga kollegor" })).not.toBeInTheDocument();
  });

  it("sends the chosen colleagues of one lesson, with the length picked, as the body the gateway reads", async () => {
    post.mockResolvedValue(request("r-new", "OPEN", "l-ma"));
    const user = userEvent.setup();
    renderBoard();
    await screen.findByRole("cell", { name: "Matematik" });
    await user.click(within(rowOf("Matematik")).getByRole("button", { name: /^Tillsätt vikarie/ }));
    await user.click(await screen.findByRole("button", { name: "Fråga kollegor" }));

    // The suggestions' dialog gives way to the question's.
    const dialog = await screen.findByRole("dialog", { name: "Fråga kollegor" });
    expect(await within(dialog).findByRole("checkbox", { name: /Bo Ek/ })).toBeInTheDocument();
    // Ranked as the suggestions are, with the reasons, and who cannot.
    const names = within(dialog).getAllByRole("checkbox").map((box) => box.closest("li")!.textContent ?? "");
    expect(names[0]).toContain("Bo Ek");
    expect(names[1]).toContain("Cia Holm");
    expect(names[1]).toContain("Vikariepoolen");
    expect(within(dialog).getAllByText("Har håltimme – lektioner före och efter").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("Kan inte (1)")).toBeInTheDocument();
    const send = within(dialog).getByRole("button", { name: "Skicka förfrågan" });
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute("data-writes", "DRIFT");

    await user.click(within(dialog).getByRole("checkbox", { name: /Bo Ek/ }));
    await user.click(within(dialog).getByRole("checkbox", { name: /Eva Berg/ }));
    // An hour is the default; the lesson is days away, so "until it starts" is not offered.
    expect(within(dialog).getByRole("radio", { name: "1 timme" })).toBeChecked();
    expect(within(dialog).queryByRole("radio", { name: /Tills/ })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("radio", { name: "2 timmar" }));
    await user.click(within(dialog).getByRole("button", { name: "Skicka till 2 kollegor" }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/cover/requests", {
        lessons: [{ lessonId: "l-ma", absenceId: "a-anna" }],
        recipientIds: ["t-bo", "t-eva"],
        expiresInMinutes: 120,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Förfrågan är skickad till 2 kollegor");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    // The board is read again: the request arrives with it.
    await waitFor(() => expect(get.mock.calls.filter(([path]) => String(path).startsWith("/api/v1/cover/board")).length).toBeGreaterThan(1));
  });

  it("asks for several selected lessons at once, offering only the colleagues every lesson holds, and counts only the lessons that can be asked", async () => {
    post.mockResolvedValue(request("r-new", "OPEN", "l-ma"));
    const user = userEvent.setup();
    renderBoard();
    await screen.findByRole("cell", { name: "Matematik" });
    await tickAll(user);
    // Seven ticked; the open ones without a question (Matematik, Historia, Fysik) can be asked about.
    // Not Engelska (a question stands), the two covered, nor the cancelled one.
    expect(screen.getByText("7 valda")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fråga kollegor (3)" })).toBeEnabled();
    // Untick Fysik; Matematik and Historia remain.
    await user.click(within(rowOf("Fysik")).getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Fråga kollegor (2)" })).toHaveAttribute("data-writes", "DRIFT");
    await user.click(screen.getByRole("button", { name: "Fråga kollegor (2)" }));

    const dialog = await screen.findByRole("dialog", { name: "Fråga kollegor" });
    expect(within(dialog).getByText("Lektionerna i förfrågan")).toBeInTheDocument();
    expect(within(dialog).getByText(/Matematik/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Historia/)).toBeInTheDocument();
    await within(dialog).findByRole("checkbox", { name: /Bo Ek/ });
    // Cia and Eva are fine for the mathematics only; Dan is out of the first. A question is for all its lessons or none.
    expect(within(dialog).getAllByRole("checkbox")).toHaveLength(1);
    await user.click(within(dialog).getByText("Kan inte (3)"));
    expect(within(dialog).getAllByText("Kan inte alla lektionerna")).toHaveLength(2);
    expect(within(dialog).getByText("Är själv frånvarande")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("checkbox", { name: /Bo Ek/ }));
    await user.click(within(dialog).getByRole("button", { name: "Skicka till 1 kollega" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/cover/requests", {
        lessons: [
          { lessonId: "l-ma", absenceId: "a-anna" },
          { lessonId: "l-hi", absenceId: "a-anna" },
        ],
        recipientIds: ["t-bo"],
        expiresInMinutes: 60,
      }),
    );
    // Sent: the selection it was made from is dropped.
    await waitFor(() => expect(screen.queryByText(/valda$/)).not.toBeInTheDocument());
  });

  it("offers no button for a selection of lessons that cannot be asked about", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByRole("cell", { name: "Engelska" });
    // A question stands, a cancelled lesson, a covered one.
    for (const subject of ["Engelska", "Geografi", "Svenska"]) await user.click(within(rowOf(subject)).getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Fråga kollegor (0)" })).toBeDisabled();
  });

  it("withdraws a question after asking, and tells the administrator so", async () => {
    post.mockResolvedValue({ ...request("r-open", "WITHDRAWN", "l-en") });
    const user = userEvent.setup();
    renderBoard();
    await screen.findByRole("cell", { name: "Engelska" });
    await user.click(within(rowOf("Engelska")).getByRole("button", { name: /^Dra tillbaka Anna Lind/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Dra tillbaka förfrågan?");
    expect(post).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Dra tillbaka" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/api/v1/cover/requests/r-open/withdraw"));
    expect(toast.success).toHaveBeenCalledWith("Förfrågan är tillbakadragen");
  });

  it("says a question already ended when it is withdrawn too late", async () => {
    post.mockRejectedValue(new ApiError(409, "Förfrågan är redan avslutad.", "COVER_REQUEST_ENDED", { current: "ACCEPTED" }));
    const user = userEvent.setup();
    renderBoard();
    await screen.findByRole("cell", { name: "Engelska" });
    await user.click(within(rowOf("Engelska")).getByRole("button", { name: /^Dra tillbaka Anna Lind/ }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Dra tillbaka" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Förfrågan är redan avslutad. Tavlan är uppdaterad."));
  });
});

describe("every refusal of a request, in words", () => {
  async function sendRefused(error: ApiError) {
    post.mockRejectedValue(error);
    const user = userEvent.setup();
    renderBoard();
    await screen.findByRole("cell", { name: "Matematik" });
    await user.click(within(rowOf("Matematik")).getByRole("button", { name: /^Tillsätt vikarie/ }));
    await user.click(await screen.findByRole("button", { name: "Fråga kollegor" }));
    const dialog = await screen.findByRole("dialog", { name: "Fråga kollegor" });
    await user.click(await within(dialog).findByRole("checkbox", { name: /Bo Ek/ }));
    await user.click(within(dialog).getByRole("button", { name: "Skicka till 1 kollega" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    return { dialog };
  }

  it("COVER_REQUEST_EXISTS: another administrator asked first; the board is read again and the dialog closes", async () => {
    await sendRefused(new ApiError(409, "Det finns redan en öppen förfrågan.", "COVER_REQUEST_EXISTS", { lessonId: "l-ma" }));
    expect(toast.error).toHaveBeenCalledWith("Det finns redan en öppen förfrågan för lektionen. Dra tillbaka den först.");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it.each([
    ["COVER_REQUEST_LESSON_COVERED", "Lektionen har redan en vikarie eller är ordnad på annat sätt."],
    ["COVER_REQUEST_LESSON_CANCELLED", "Lektionen är inställd och går inte att fråga om."],
    ["COVER_REQUEST_LESSON_STARTED", "Lektionen har redan börjat eller börjar inom en minut. Tillsätt en vikarie direkt på tavlan."],
    ["COVER_NOT_AFFECTED", "Lektionen berörs inte längre av frånvaron."],
  ])("%s says so and closes the dialog", async (code, text) => {
    await sendRefused(new ApiError(409, "English log text", code, { lessonId: "l-ma" }));
    expect(toast.error).toHaveBeenCalledWith(text);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("COVER_REQUEST_RECIPIENT_RULE: a chosen colleague breaks a hard rule; the gateway's sentence is shown, the dialog stays for another choice", async () => {
    const sentence = "Förfrågan om mån 14 okt 08:00 kan inte gå till Bo Ek, som undervisar på en annan lektion då.";
    const { dialog } = await sendRefused(
      new ApiError(409, sentence, "COVER_REQUEST_RECIPIENT_RULE", { userId: "t-bo", lessonId: "l-ma", rules: "BUSY_LESSON" }),
    );
    expect(toast.error).toHaveBeenCalledWith(sentence);
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByRole("checkbox", { name: /Bo Ek/ })).toBeChecked();
  });

  it("COVER_REQUEST_RECIPIENT_INVALID is said in words too", async () => {
    await sendRefused(new ApiError(400, "recipientIds: bara aktiva lärare.", "COVER_REQUEST_RECIPIENT_INVALID", { userId: "t-bo" }));
    expect(toast.error).toHaveBeenCalledWith("Bara aktiva lärare i skolan kan få en förfrågan, och inte den som själv är frånvarande.");
  });

  it("says a candidate list that could not be read as such, and sends nothing", async () => {
    get.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/v1/cover/board")) return BOARD;
      if (path.startsWith("/api/v1/cover/counter")) return { date: DATE, rows: [] };
      if (path.startsWith("/api/v1/cover/fairness")) return FAIRNESS;
      if (path === "/api/v1/retention/purged-before") return [];
      if (path === "/api/v1/cover/lessons/l-ma/candidates") throw new ApiError(500, "boom");
      throw new Error(`unexpected GET ${path}`);
    });
    const user = userEvent.setup();
    renderBoard();
    await screen.findByRole("cell", { name: "Matematik" });
    await user.click(within(rowOf("Matematik")).getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Fråga kollegor (1)" }));
    const dialog = await screen.findByRole("dialog", { name: "Fråga kollegor" });
    expect(await within(dialog).findByText("Kollegorna kunde inte hämtas")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Skicka förfrågan" })).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
  });
});

describe("Rättvisa", () => {
  const section = async () => (await screen.findByRole("heading", { name: "Rättvisa" })).closest("section")!;

  it("asks for the last 30 days and lists who was asked, most asked first, with names from the people list", async () => {
    renderBoard();
    const card = within(await section());
    const today = toDateString(new Date());
    const { from } = lastDays(today);
    await waitFor(() => expect(get).toHaveBeenCalledWith(`/api/v1/cover/fairness?from=${from}&to=${today}`));
    const table = await card.findByRole("table");
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "Namn",
      "Fått förfrågan",
      "Tackat ja",
      "Tackat nej",
      "Obesvarat",
    ]);
    const rows = within(table).getAllByRole("row").slice(1).map((row) => within(row).getAllByRole("cell").map((cell) => cell.textContent));
    expect(rows).toEqual([
      ["Eva Berg", "5", "0", "3", "2"],
      ["Anna Lind", "2", "0", "1", "1"],
      ["Bo Ek", "2", "1", "0", "1"],
    ]);
    // Beside the counter, in the same rail.
    expect(screen.getByRole("heading", { name: "Vikarieräknare" }).closest("section")!.parentElement).toBe(
      (await section()).parentElement,
    );
  });

  it("asks again for another period, and does not ask for one the gateway would refuse", async () => {
    const user = userEvent.setup();
    renderBoard();
    const card = within(await section());
    await card.findByRole("table");
    const to = card.getByRole("textbox", { name: "Till" });
    await user.clear(to);
    await user.type(to, "2031-06-30");
    // More than a year from the default start: not asked, and said.
    expect(await card.findByText("Välj en period på högst ett år, med från-dagen först.")).toBeInTheDocument();
    expect(get.mock.calls.some(([path]) => String(path).endsWith("&to=2031-06-30"))).toBe(false);
    const from = card.getByRole("textbox", { name: "Från" });
    await user.clear(from);
    await user.type(from, "2031-06-01");
    await waitFor(() => expect(get).toHaveBeenCalledWith("/api/v1/cover/fairness?from=2031-06-01&to=2031-06-30"));
    expect(card.queryByText(/Välj en period/)).not.toBeInTheDocument();
  });

  it("says in words that nobody was asked, rather than showing an empty table", async () => {
    answer({ fairness: { ...FAIRNESS, rows: [] } });
    renderBoard();
    const card = within(await section());
    expect(await card.findByText("Ingen har fått en vikarieförfrågan under perioden.")).toBeInTheDocument();
    expect(card.queryByRole("table")).not.toBeInTheDocument();
  });

  it("says it could not be read, and not that nobody was asked", async () => {
    get.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/v1/cover/board")) return BOARD;
      if (path.startsWith("/api/v1/cover/counter")) return { date: DATE, rows: [] };
      if (path.startsWith("/api/v1/cover/fairness")) throw new ApiError(500, "boom");
      if (path === "/api/v1/retention/purged-before") return [];
      throw new Error(`unexpected GET ${path}`);
    });
    renderBoard();
    const card = within(await section());
    expect(await card.findByText("Rättvisan kunde inte hämtas")).toBeInTheDocument();
    expect(card.queryByText("Ingen har fått en vikarieförfrågan under perioden.")).not.toBeInTheDocument();
  });

  it("says when the period reaches back past what gallring has taken", async () => {
    get.mockImplementation(async (path: string) => {
      if (path === "/api/v1/retention/purged-before") return [{ dataType: "COVER_REQUESTS", purgedBefore: toDateString(new Date()) }];
      if (path.startsWith("/api/v1/cover/fairness")) return { ...FAIRNESS, rows: [] };
      if (path.startsWith("/api/v1/cover/counter")) return { date: DATE, rows: [] };
      if (path.startsWith("/api/v1/cover/board")) return BOARD;
      throw new Error(`unexpected GET ${path}`);
    });
    renderBoard();
    const card = within(await section());
    expect(await card.findByText(/^Vikarieförfrågningar som avslutades före .+ är gallrade enligt skolans beslut\.$/)).toBeInTheDocument();
  });

  it("is a reading for every admin profile: nothing in it writes", async () => {
    renderBoard();
    const card = await section();
    await within(card).findByRole("table");
    expect(card.querySelector("[data-writes]")).toBeNull();
  });
});

describe("a reading administrator (LASARE)", () => {
  it("is shown none of the new buttons: each is marked as Drift's, the area the layout hides from a profile that does not write it", async () => {
    const user = userEvent.setup();
    renderBoard();
    await screen.findByRole("cell", { name: "Matematik" });
    expect(within(rowOf("Engelska")).getByRole("button", { name: /^Dra tillbaka/ }).closest("[data-writes]")).toHaveAttribute(
      "data-writes",
      "DRIFT",
    );
    await user.click(within(rowOf("Matematik")).getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Fråga kollegor (1)" })).toHaveAttribute("data-writes", "DRIFT");
    // The states a pair shows are for reading, and stay.
    expect(within(rowOf("Svenska")).getByText("Tillsatt via förfrågan").closest("[data-writes]")).toBeNull();
    await user.click(within(rowOf("Matematik")).getByRole("button", { name: /^Tillsätt vikarie/ }));
    expect(await screen.findByRole("button", { name: "Fråga kollegor" })).toHaveAttribute("data-writes", "DRIFT");
  });
});
