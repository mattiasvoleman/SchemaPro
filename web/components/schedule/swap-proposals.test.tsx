import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";
import { swapPreview } from "@/lib/swap-store";
import type { SwapPair, SwapProposal, SwapSuggestion } from "@/lib/swaps";
import { SwapPairDialog, SwapProposals, type ProposalAsk } from "./swap-dialog";

/**
 * E5a: what the lists of Byt plats and Gör plats show of what the gateway answers, which proposal the board is told to draw, and what an apply
 * sends. The search, the judge and the price are the gateway's (src/swaps); what only this list can get wrong is the round trip, and the words.
 */

const swaps = vi.hoisted(() => ({
  suggest: { mutateAsync: vi.fn(), isPending: false },
  pair: { mutateAsync: vi.fn(), isPending: false },
  apply: { mutateAsync: vi.fn(), isPending: false },
}));

vi.mock("@/lib/swaps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swaps")>()),
  useSwaps: () => swaps,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The real catalogue through the real translator: what is asserted is what the reader reads.
vi.mock("next-intl", async () => {
  const { createTranslator } = await import("use-intl");
  const sv = (await import("@/messages/sv.json")).default;
  return {
    useLocale: () => "sv",
    useTranslations: (namespace: string) => createTranslator({ locale: "sv", messages: sv, namespace: namespace as never }),
  };
});

const slot = (dayOfWeek: number, start: number, length = 60) => ({ dayOfWeek, startMinutes: start, endMinutes: start + length });
const view = (id: string, subjectName: string, groupName: string, isLocked = false) => ({
  id,
  subjectName,
  groupName,
  teacherId: null,
  coTeacherId: null,
  roomId: null,
  isLocked,
});

/** Matematik 7A dropped on Tisdag 10:00, where Kemi 7B stands: Kemi goes to an empty place, Matematik takes its time. */
const MAKE_ROOM: SwapProposal = {
  id: "p-room-1",
  kind: "MAKE_ROOM",
  moves: [
    { lessonId: "l-a", from: slot(1, 480), to: slot(2, 600) },
    { lessonId: "l-b", from: slot(2, 600), to: slot(4, 540) },
  ],
  parallels: [],
  external: [],
  hard: ["CLASH", "FRAME"],
  soft: [
    { code: "PUPIL_GAPS", unit: "MINUTES", before: 60, after: 30, delta: -30 },
    { code: "TEACHER_GAPS", unit: "MINUTES", before: 0, after: 0, delta: 0 },
    { code: "DISTRIBUTION", unit: "BREACHES", before: 0, after: 0, delta: 0 },
    { code: "TEACHER_DAY", unit: "BREACHES", before: 0, after: 0, delta: 0 },
    { code: "MOVED_LESSONS", unit: "LESSONS", before: 0, after: 2, delta: 2 },
  ],
  lessons: [view("l-a", "Matematik", "7A", true), view("l-b", "Kemi", "7B")],
  removedCalendarLessons: 0,
  levels: { "l-a": 0, "l-b": 1 },
  depth: 1,
};
const SECOND: SwapProposal = { ...MAKE_ROOM, id: "p-room-2", moves: [MAKE_ROOM.moves[0]!, { lessonId: "l-b", from: slot(2, 600), to: slot(5, 600) }] };

const suggestion = (over: Partial<SwapSuggestion> = {}): SwapSuggestion => ({
  lessonId: "l-a",
  academicYearId: "y-1",
  unit: { lessonIds: ["l-a"], links: [] },
  selectedLocked: true,
  proposals: [MAKE_ROOM, SECOND],
  makeRoom: { target: slot(2, 600), blockers: [{ lessonIds: ["l-b"], subjectName: "Kemi", groupName: "7B", isLocked: false }], depth: 3, landingsCut: false },
  stats: { partners: 9, candidates: 4, judged: 4, refused: 0, truncated: false, chainsCut: false, elapsedMs: 100, phasesMs: { read: 1, index: 1, warm: 1, search: 1 } },
  ...over,
});

const SWAP: SwapProposal = { ...MAKE_ROOM, id: "p-swap", kind: "SWAP", moves: [MAKE_ROOM.moves[0]!, { lessonId: "l-b", from: slot(2, 600), to: slot(1, 480) }], levels: undefined, depth: undefined };
const pairOk = (over: Partial<SwapPair> = {}): SwapPair => ({ academicYearId: "y-1", ok: true, proposal: SWAP, refusals: [], ...over });

const onApplied = vi.fn();
const onDone = vi.fn();

function list(ask: ProposalAsk, labelOf?: (id: string) => string | null) {
  return render(<SwapProposals ask={ask} labelOf={labelOf} teacherName={() => null} roomName={() => null} onApplied={onApplied} onDone={onDone} />);
}
const ROOM: ProposalAsk = { kind: "room", lessonId: "l-a", target: { dayOfWeek: 2, startMinutes: 600 } };

beforeEach(() => {
  vi.clearAllMocks();
  swapPreview.set(null);
  swaps.apply.mutateAsync.mockResolvedValue({
    propagatedLessons: 2,
    removedCalendarLessons: 0,
    versionId: "v-1",
    undo: [{ lessonId: "l-b", from: slot(4, 540), to: slot(2, 600) }],
    lockedByMove: true,
    lockedLessonIds: ["l-b"],
  });
});

describe("Gör plats: the list asks for the time the lesson was let go on, and shows what makes room", () => {
  it("asks the gateway for what has to move for the lesson to stand there, and shows each proposal's price before and after", async () => {
    swaps.suggest.mutateAsync.mockResolvedValue(suggestion());
    list(ROOM);
    await screen.findByText("2 förslag, de bästa först");
    expect(swaps.suggest.mutateAsync).toHaveBeenCalledWith({ lessonId: "l-a", makeRoom: { dayOfWeek: 2, startTime: "10:00" }, limit: 8 });
    const [first] = screen.getAllByRole("listitem").filter((li) => li.getAttribute("data-swap-proposal") === "MAKE_ROOM");
    // What moves where, who was picked and what stood in the way, in words.
    expect(within(first!).getByText("Matematik 7A")).toBeInTheDocument();
    expect(within(first!).getByText("(Vald)")).toBeInTheDocument();
    expect(within(first!).getByText("Kemi 7B")).toBeInTheDocument();
    expect(within(first!).getByText("(flyttas för att göra plats, nivå 1)")).toBeInTheDocument();
    // The price, before and after, in the figures the gateway ordered them by.
    expect(within(first!).getByText("60 min → 30 min")).toBeInTheDocument();
    expect(within(first!).getByText("2 lektioner")).toBeInTheDocument();
    expect(screen.getByText("Det som står där:")).toBeInTheDocument();
  });

  it("tells the board to draw the first proposal and then the one chosen, and nothing when the list goes", async () => {
    const user = userEvent.setup();
    swaps.suggest.mutateAsync.mockResolvedValue(suggestion());
    const { unmount } = list(ROOM);
    await screen.findByText("2 förslag, de bästa först");
    expect(swapPreview.get()?.id).toBe("p-room-1");
    const [, second] = screen.getAllByRole("button", { name: /Visa på brädet|Visas på brädet/ });
    await user.click(second!);
    expect(swapPreview.get()?.id).toBe("p-room-2");
    expect(screen.getAllByRole("button", { name: "Visas på brädet" })).toHaveLength(1);
    unmount();
    expect(swapPreview.get()).toBeNull();
  });

  it("applies the proposal chosen with the picked lesson alone, and Ångra sends the same moves back", async () => {
    const user = userEvent.setup();
    swaps.suggest.mutateAsync.mockResolvedValue(suggestion());
    list(ROOM);
    await screen.findByText("2 förslag, de bästa först");
    await user.click(screen.getAllByRole("button", { name: "Tillämpa" })[1]!);
    await waitFor(() => expect(swaps.apply.mutateAsync).toHaveBeenCalledTimes(1));
    expect(swaps.apply.mutateAsync.mock.calls[0]![0]).toEqual({
      lessonId: "l-a",
      moves: [
        { lessonId: "l-a", from: { dayOfWeek: 1, startTime: "08:00", endTime: "09:00" }, to: { dayOfWeek: 2, startTime: "10:00", endTime: "11:00" } },
        { lessonId: "l-b", from: { dayOfWeek: 2, startTime: "10:00", endTime: "11:00" }, to: { dayOfWeek: 5, startTime: "10:00", endTime: "11:00" } },
      ],
    });
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
    const toastOptions = vi.mocked(toast.success).mock.calls[0]![1] as unknown as { action: { onClick: () => void } };
    toastOptions.action.onClick();
    await waitFor(() => expect(swaps.apply.mutateAsync).toHaveBeenCalledTimes(2));
    expect(swaps.apply.mutateAsync.mock.calls[1]![0]).toMatchObject({ lessonId: "l-a", versionName: "Före ångra", moves: [{ lessonId: "l-b" }] });
  });

  it("says why there is nothing when a locked lesson is in the way, and names it", async () => {
    swaps.suggest.mutateAsync.mockResolvedValue(
      suggestion({
        proposals: [],
        makeRoom: { target: slot(2, 600), blockers: [{ lessonIds: ["l-b"], subjectName: "Kemi", groupName: "7B", isLocked: true }], stuck: "LOCKED_IN_THE_WAY", depth: 3, landingsCut: false },
      }),
    );
    list(ROOM);
    await screen.findByText(/En låst lektion står i vägen/);
    expect(screen.getByText("Kemi 7B (låst)", { exact: false })).toBeInTheDocument();
    expect(swapPreview.get()).toBeNull();
    expect(screen.queryByRole("button", { name: "Tillämpa" })).not.toBeInTheDocument();
  });

  it.each([
    ["CLOSED", /stängd av en regel/],
    ["TOO_MANY", /Fler lektioner står i vägen/],
  ] as const)("says what %s means in words", async (stuck, words) => {
    swaps.suggest.mutateAsync.mockResolvedValue(suggestion({ proposals: [], makeRoom: { target: slot(2, 600), blockers: [], stuck, depth: 3, landingsCut: false } }));
    list(ROOM);
    await screen.findByText(words);
  });

  it.each([
    ["PLACED", /Lektionen är förlagd/],
    ["EXEMPT", /ett undantag/],
  ] as const)("says why a lesson that is %s has nothing to make room for", async (immovable, words) => {
    swaps.suggest.mutateAsync.mockResolvedValue(suggestion({ proposals: [], immovable, makeRoom: undefined }));
    list(ROOM);
    await screen.findByText(words);
  });

  it("asks again and says so when the timetable has moved since the proposals were made", async () => {
    const user = userEvent.setup();
    swaps.suggest.mutateAsync.mockResolvedValue(suggestion());
    swaps.apply.mutateAsync.mockRejectedValueOnce(new ApiError(409, "stale", "SWAP_STALE"));
    list(ROOM);
    await screen.findByText("2 förslag, de bästa först");
    await user.click(screen.getAllByRole("button", { name: "Tillämpa" })[0]!);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("Schemat har ändrats")));
    await waitFor(() => expect(swaps.suggest.mutateAsync).toHaveBeenCalledTimes(2));
    expect(onDone).not.toHaveBeenCalled();
  });

  it("says the gateway could not answer, and tries again when asked", async () => {
    const user = userEvent.setup();
    swaps.suggest.mutateAsync.mockRejectedValueOnce(new Error("down")).mockResolvedValue(suggestion());
    list(ROOM);
    await screen.findByText("Förslagen kunde inte hämtas.");
    await user.click(screen.getByRole("button", { name: "Försök igen" }));
    await screen.findByText("2 förslag, de bästa först");
  });
});

describe("Byt: a lesson let go on a taken time offers the swap with the one lesson that stands there", () => {
  const SWAP_ASK: ProposalAsk = { kind: "swap", lessonId: "l-a", target: { dayOfWeek: 2, startMinutes: 600 } };

  it("asks who stands there, then asks the pair, and applies it with the other lesson named as chosen, locked or not", async () => {
    const user = userEvent.setup();
    swaps.suggest.mutateAsync.mockResolvedValue(suggestion({ proposals: [MAKE_ROOM] }));
    swaps.pair.mutateAsync.mockResolvedValue(pairOk());
    list(SWAP_ASK);
    await screen.findByText("1 förslag, de bästa först");
    expect(swaps.pair.mutateAsync).toHaveBeenCalledWith({ lessonId: "l-a", otherLessonId: "l-b" });
    expect(swapPreview.get()?.id).toBe("p-swap");
    await user.click(screen.getByRole("button", { name: "Tillämpa" }));
    await waitFor(() => expect(swaps.apply.mutateAsync).toHaveBeenCalledTimes(1));
    expect(swaps.apply.mutateAsync.mock.calls[0]![0]).toMatchObject({ lessonId: "l-a", alsoPicked: ["l-b"] });
  });

  it("says there is no one to swap with when nothing stands there, or when several lessons do, and asks no pair", async () => {
    swaps.suggest.mutateAsync.mockResolvedValueOnce(suggestion({ proposals: [], makeRoom: { target: slot(2, 600), blockers: [], depth: 3, landingsCut: false } }));
    const first = list(SWAP_ASK);
    await screen.findByText(/Ingen lektion står i vägen/);
    first.unmount();
    swaps.suggest.mutateAsync.mockResolvedValueOnce(
      suggestion({
        proposals: [],
        makeRoom: { target: slot(2, 600), blockers: [{ lessonIds: ["l-b"], subjectName: "Kemi", groupName: "7B", isLocked: false }, { lessonIds: ["l-c"], subjectName: "Biologi", groupName: "7C", isLocked: false }], depth: 3, landingsCut: false },
      }),
    );
    list(SWAP_ASK);
    await screen.findByText(/Flera lektioner står i vägen/);
    expect(swaps.pair.mutateAsync).not.toHaveBeenCalled();
  });
});

describe("Byt plats: two marked lessons", () => {
  const PAIR: ProposalAsk = { kind: "pair", lessonId: "l-a", otherLessonId: "l-b" };

  it("shows the swap with its price when both fit where the other stands", async () => {
    swaps.pair.mutateAsync.mockResolvedValue(pairOk());
    list(PAIR);
    await screen.findByText("1 förslag, de bästa först");
    expect(swaps.pair.mutateAsync).toHaveBeenCalledWith({ lessonId: "l-a", otherLessonId: "l-b" });
    expect(screen.getByRole("heading", { level: 3, name: /^Byte/ })).toBeInTheDocument();
    expect(screen.getByText("60 min → 30 min")).toBeInTheDocument();
    expect(swaps.suggest.mutateAsync).not.toHaveBeenCalled();
  });

  it("says why it does not go, in the gateway's words, by lesson", async () => {
    swaps.pair.mutateAsync.mockResolvedValue({
      academicYearId: "y-1",
      ok: false,
      refusals: [
        { lessonId: "l-a", reason: "TEACHER", params: {}, text: "Läraren är upptagen. C. Ås har Kemi 8B onsdag 14:10–15:10." },
        { lessonId: "l-b", reason: "FRAME", params: {}, text: "Tiden ligger utanför klassens ramtid." },
      ],
    });
    list(PAIR, (id) => (id === "l-a" ? "Måndag 08:00" : "Tisdag 10:00"));
    await screen.findByText("Bytet går inte:");
    expect(screen.getByText("Måndag 08:00:")).toBeInTheDocument();
    expect(screen.getByText(/C\. Ås har Kemi 8B/)).toBeInTheDocument();
    expect(screen.getByText(/utanför klassens ramtid/)).toBeInTheDocument();
    expect(swapPreview.get()).toBeNull();
    expect(screen.queryByRole("button", { name: "Tillämpa" })).not.toBeInTheDocument();
  });

  it.each([
    ["SAME_UNIT", /ligger parallellt och flyttas alltid tillsammans/],
    ["SAME_PLACE", /börjar samtidigt/],
    ["PARKED", /ligger på Parkering/],
  ] as const)("says what %s means", async (immovable, words) => {
    swaps.pair.mutateAsync.mockResolvedValue({ academicYearId: "y-1", ok: false, refusals: [], immovable });
    list(PAIR);
    await screen.findByText(words);
  });

  it("applies with the second lesson named as the person's own choice, and sends it back with it on Ångra", async () => {
    const user = userEvent.setup();
    swaps.pair.mutateAsync.mockResolvedValue(pairOk());
    list(PAIR);
    await screen.findByText("1 förslag, de bästa först");
    await user.click(screen.getByRole("button", { name: "Tillämpa" }));
    await waitFor(() => expect(swaps.apply.mutateAsync).toHaveBeenCalledTimes(1));
    expect(swaps.apply.mutateAsync.mock.calls[0]![0]).toMatchObject({ lessonId: "l-a", alsoPicked: ["l-b"] });
    const toastOptions = vi.mocked(toast.success).mock.calls[0]![1] as unknown as { action: { onClick: () => void } };
    toastOptions.action.onClick();
    await waitFor(() => expect(swaps.apply.mutateAsync).toHaveBeenCalledTimes(2));
    expect(swaps.apply.mutateAsync.mock.calls[1]![0]).toMatchObject({ lessonId: "l-a", alsoPicked: ["l-b"], versionName: "Före ångra" });
  });
});

describe("SwapPairDialog: the dialog of the two marked lessons", () => {
  it("asks for the two lessons in the order they were marked, names a refusal by the day and clock they stand at, and asks nothing when closed", async () => {
    swaps.pair.mutateAsync.mockResolvedValue({
      academicYearId: "y-1",
      ok: false,
      refusals: [{ lessonId: "l-b", reason: "FRAME", params: {}, text: "Tiden ligger utanför klassens ramtid." }],
    });
    const lessons = [
      { id: "l-a", dayOfWeek: 1, startTime: "08:00:00" },
      { id: "l-b", dayOfWeek: 2, startTime: "10:00:00" },
    ];
    const { rerender } = render(<SwapPairDialog open={false} onOpenChange={vi.fn()} lessons={lessons} onApplied={onApplied} />);
    expect(swaps.pair.mutateAsync).not.toHaveBeenCalled();
    rerender(<SwapPairDialog open onOpenChange={vi.fn()} lessons={lessons} onApplied={onApplied} />);
    await screen.findByText("Bytet går inte:");
    expect(swaps.pair.mutateAsync).toHaveBeenCalledWith({ lessonId: "l-a", otherLessonId: "l-b" });
    expect(screen.getByText("Tisdag 10:00:")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Byt plats" })).toBeInTheDocument();
  });
});
