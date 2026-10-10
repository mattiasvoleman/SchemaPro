import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import sv from "@/messages/sv.json";
import { ApiError, api } from "@/lib/api";
import type { Board, BoardItem, Candidates, DayProposal } from "@/lib/cover-types";
import { CoverBoard } from "./cover-board";
import { shouldRefetch } from "./use-cover-realtime";

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
 * Vikarietavla over the real cover hooks and the real Swedish messages, the
 * gateway answering by path. What only the board decides: which decision a
 * pair is offered, that every decision carries the status the admin saw
 * (`expected`, so a second admin's change is COVER_STALE and not a silent
 * overwrite), that a cancel sends no reason, that bulk sends only the
 * eligible pairs, and that "Fördela dagen" applies exactly the ticked
 * proposals with the proposal's basis.
 *
 * The lessons are in 2030, so none has started when the test runs.
 */

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() } };
});
const get = api.get as unknown as Mock;
const post = api.post as unknown as Mock;
const del = api.delete as unknown as Mock;

vi.mock("@/lib/queries", () => ({
  usePeople: () => ({
    data: [
      { id: "t-anna", role: "TEACHER", isActive: true, firstName: "Anna", lastName: "Lind" },
      { id: "t-bo", role: "TEACHER", isActive: true, firstName: "Bo", lastName: "Ek" },
      { id: "t-cia", role: "TEACHER", isActive: true, firstName: "Cia", lastName: "Holm" },
      { id: "t-dan", role: "TEACHER", isActive: true, firstName: "Dan", lastName: "Ström" },
    ],
  }),
  useSubjects: () => ({
    data: [
      { id: "s-ma", name: "Matematik" },
      { id: "s-en", name: "Engelska" },
      { id: "s-sv", name: "Svenska" },
    ],
  }),
  useGroups: () => ({ data: [{ id: "g-7a", name: "7A" }, { id: "g-8b", name: "8B" }] }),
  useRooms: () => ({ data: [{ id: "r-12", name: "Sal 12" }] }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const DATE = "2030-10-14";

function pair(overrides: Partial<BoardItem>): BoardItem {
  return {
    absenceId: "a-anna",
    absentTeacherId: "t-anna",
    absentRole: "LEAD",
    lessonId: "l-ma",
    date: DATE,
    startsAt: `${DATE}T07:00:00.000Z`,
    endsAt: `${DATE}T08:00:00.000Z`,
    subjectId: "s-ma",
    studentGroupId: "g-7a",
    extraGroupIds: [],
    roomId: "r-12",
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

const OPEN_MA = pair({});
const OPEN_EN = pair({
  lessonId: "l-en",
  subjectId: "s-en",
  studentGroupId: "g-8b",
  roomId: null,
  startsAt: `${DATE}T09:00:00.000Z`,
  endsAt: `${DATE}T10:00:00.000Z`,
});
const COVERED = pair({
  lessonId: "l-cov",
  subjectId: "s-sv",
  startsAt: `${DATE}T11:00:00.000Z`,
  endsAt: `${DATE}T12:00:00.000Z`,
  teachers: [{ teacherId: "t-dan", role: "SUBSTITUTE" }],
  substituteId: "t-dan",
  decision: "SUBSTITUTE",
  status: "COVERED",
});

const BOARD: Board = {
  from: DATE,
  to: DATE,
  items: [OPEN_MA, OPEN_EN, COVERED],
  summary: { open: 2, covered: 1, cancelled: 0, handled: 0, passedOpen: 0 },
  absences: [{ id: "a-anna", userId: "t-anna", startsAt: `${DATE}T00:00:00Z`, endsAt: "2030-10-15T00:00:00Z" }],
};

const CANDIDATES: Candidates = {
  lessonId: "l-ma",
  candidates: [
    {
      userId: "t-bo",
      kind: "STAFF",
      score: 52,
      qualificationKind: "LEGITIMATION",
      reasons: [
        { code: "QUAL_LEGITIMATION", params: { subject: "Matematik", grades: "7–9" }, points: 40 },
        { code: "GAP_FILL", params: {}, points: 12 },
      ],
      counter: { weekLessons: 0, termLessons: 2 },
      load: { weekMinutes: 900, targetMinutes: 1100 },
    },
    {
      userId: "t-cia",
      kind: "POOL",
      score: 0,
      qualificationKind: null,
      reasons: [{ code: "POOL", params: {}, points: 0 }],
      counter: { weekLessons: 1, termLessons: 4 },
      load: { weekMinutes: 0, targetMinutes: null },
    },
  ],
  excluded: [{ userId: "t-dan", codes: [{ code: "ABSENT", params: {} }] }],
};

const PROPOSAL: DayProposal = {
  date: DATE,
  basis: "b".repeat(64),
  items: [
    { lessonId: "l-ma", absenceId: "a-anna", userId: "t-bo", score: 52, reasons: [] },
    { lessonId: "l-en", absenceId: "a-anna", userId: "t-cia", score: 0, reasons: [] },
  ],
  unassigned: [],
};

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

const rowOf = (subject: string) => screen.getByRole("cell", { name: subject }).closest("tr")!;

beforeEach(() => {
  vi.resetAllMocks();
  get.mockImplementation(async (path: string) => {
    if (path.startsWith("/api/v1/cover/board")) return BOARD;
    if (path.startsWith("/api/v1/cover/counter")) return { date: DATE, rows: [] };
    if (path.includes("/candidates")) return CANDIDATES;
    throw new Error(`unexpected GET ${path}`);
  });
});

describe("Vikarietavla", () => {
  it("shows each pair's status in Swedish, the day's summary, and no reason anywhere", async () => {
    renderBoard();
    expect(await screen.findByRole("cell", { name: "Matematik" })).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith(`/api/v1/cover/board?from=${DATE}&to=${DATE}`);
    expect(within(rowOf("Matematik")).getByText("Behöver vikarie")).toBeInTheDocument();
    expect(within(rowOf("Svenska")).getByText("Vikarie tillsatt")).toBeInTheDocument();
    expect(within(rowOf("Svenska")).getByText("Dan Ström")).toBeInTheDocument();
    expect(screen.getByText("2 behöver vikarie")).toBeInTheDocument();
    expect(screen.queryByText(/Sjuk|Vård av barn/)).not.toBeInTheDocument();
  });

  it("assigns a ranked candidate with the status the admin saw, the reasons in plain Swedish", async () => {
    post.mockResolvedValue({ lessonId: "l-ma", absenceId: "a-anna", warnings: [] });
    const user = userEvent.setup();
    renderBoard();
    await screen.findByRole("cell", { name: "Matematik" });
    await user.click(within(rowOf("Matematik")).getByRole("button", { name: /Tillsätt vikarie/ }));

    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Legitimerad i Matematik för åk 7–9")).toBeInTheDocument();
    expect(within(dialog).getByText("Har håltimme – lektioner före och efter")).toBeInTheDocument();
    expect(within(dialog).getByText("Vikariepoolen", { selector: "div" })).toBeInTheDocument();
    // Who could not, and why — "away", never the reason.
    expect(within(dialog).getByText("Kan inte (1)")).toBeInTheDocument();
    expect(within(dialog).getByText("Är själv frånvarande")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: /Bo Ek/ }));
    await user.click(within(dialog).getByRole("button", { name: "Tillsätt" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/cover/lessons/l-ma/decision", {
        absenceId: "a-anna",
        kind: "SUBSTITUTE",
        substituteId: "t-bo",
        expected: "OPEN",
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Vikarie tillsatt");
  });

  it("cancels after a confirmation, as TEACHER_UNAVAILABLE on the gateway, with no reason and no note", async () => {
    post.mockResolvedValue({ lessonId: "l-ma", absenceId: "a-anna", warnings: [] });
    const user = userEvent.setup();
    renderBoard();
    await screen.findByRole("cell", { name: "Matematik" });
    await user.click(within(rowOf("Matematik")).getByRole("button", { name: /Ställ in/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Ingen anledning skickas till elever eller vårdnadshavare.");
    await user.click(within(dialog).getByRole("button", { name: "Ställ in" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/cover/lessons/l-ma/decision", {
        absenceId: "a-anna",
        kind: "CANCELLED",
        expected: "OPEN",
      }),
    );
  });

  it("says a stale decision in words and reads the board again", async () => {
    post.mockRejectedValue(new ApiError(409, "Lektionen har ändrats sedan tavlan lästes.", "COVER_STALE", { current: "COVERED" }));
    const user = userEvent.setup();
    renderBoard();
    await screen.findByRole("cell", { name: "Matematik" });
    const reads = get.mock.calls.filter(([path]) => String(path).startsWith("/api/v1/cover/board")).length;
    await user.click(within(rowOf("Matematik")).getByRole("button", { name: /Fler val/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Självstudier under tillsyn" }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Lektionen har ändrats sedan tavlan lästes. Tavlan är uppdaterad – titta och försök igen.",
      ),
    );
    await waitFor(() =>
      expect(get.mock.calls.filter(([path]) => String(path).startsWith("/api/v1/cover/board")).length).toBeGreaterThan(reads),
    );
  });

  it("undoes a decision on the lesson it was made for", async () => {
    del.mockResolvedValue({ lessonId: "l-cov", absenceId: "a-anna" });
    const user = userEvent.setup();
    renderBoard();
    await screen.findByRole("cell", { name: "Matematik" });
    const covered = rowOf("Svenska");
    expect(within(covered).queryByRole("button", { name: /Tillsätt vikarie/ })).not.toBeInTheDocument();
    await user.click(within(covered).getByRole("button", { name: /Ångra/ }));
    await waitFor(() => expect(del).toHaveBeenCalledWith("/api/v1/cover/lessons/l-cov/decision?absenceId=a-anna"));
  });

  it("sends a bulk action for the selected pairs it applies to, and only those", async () => {
    post.mockResolvedValue({ done: 2 });
    const user = userEvent.setup();
    renderBoard();
    await screen.findByRole("cell", { name: "Matematik" });
    for (const box of screen.getAllByRole("checkbox")) await user.click(box);
    // Three selected; two are open, one is covered.
    expect(screen.getByText("3 valda")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Självstudier för valda (2)" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/api/v1/cover/bulk", {
        action: "SUPERVISED_STUDY",
        items: [
          { lessonId: "l-ma", absenceId: "a-anna", expected: "OPEN" },
          { lessonId: "l-en", absenceId: "a-anna", expected: "OPEN" },
        ],
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("2 lektioner uppdaterade");
  });

  it("applies the day's proposal as ticked, with its basis, and asks again when the day moved", async () => {
    let applies = 0;
    post.mockImplementation(async (path: string) => {
      if (path.endsWith("/proposal")) return PROPOSAL;
      if (path.endsWith("/apply")) {
        applies += 1;
        if (applies === 1) throw new ApiError(409, "Dagen har ändrats.", "COVER_PROPOSAL_STALE");
        return { applied: 1 };
      }
      throw new Error(`unexpected POST ${path}`);
    });
    const user = userEvent.setup();
    renderBoard();
    await screen.findByRole("cell", { name: "Matematik" });
    await user.click(screen.getByRole("button", { name: /Fördela dagen/ }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Anna Lind → Bo Ek")).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith(`/api/v1/cover/days/${DATE}/proposal`, {});

    // Untick the English lesson; apply keeps the mathematics one.
    const boxes = within(dialog).getAllByRole("checkbox");
    await user.click(boxes[1]!);
    await user.click(within(dialog).getByRole("button", { name: "Tillämpa 1" }));
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(`/api/v1/cover/days/${DATE}/apply`, {
        basis: PROPOSAL.basis,
        items: [{ lessonId: "l-ma", absenceId: "a-anna", userId: "t-bo" }],
      }),
    );
    // Stale: said in words, and a fresh proposal is computed.
    expect(toast.error).toHaveBeenCalledWith("Dagen har ändrats sedan förslaget gjordes. Ett nytt förslag räknas fram.");
    await waitFor(() =>
      expect(post.mock.calls.filter(([path]) => String(path).endsWith("/proposal"))).toHaveLength(2),
    );
    await user.click(await within(dialog).findByRole("button", { name: "Tillämpa 2" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("1 vikarie tillsatt"));
  });
});

describe("the board's realtime", () => {
  const window = { from: "2030-10-14", to: "2030-10-20" };

  it("refetches on a cover change that touches the dates on screen, and not on one that does not", () => {
    expect(shouldRefetch("cover_board_updated", { from: "2030-10-16", to: "2030-10-16", changedAt: "x" }, window)).toBe(true);
    expect(shouldRefetch("cover_board_updated", { from: "2030-10-21", to: "2030-10-22" }, window)).toBe(false);
  });

  it("refetches on a published or regenerated timetable, and on a payload it cannot read", () => {
    expect(shouldRefetch("master_timetable_updated", {}, window)).toBe(true);
    expect(shouldRefetch("cover_board_updated", null, window)).toBe(true);
    expect(shouldRefetch("timetable_presence", {}, window)).toBe(false);
  });
});
