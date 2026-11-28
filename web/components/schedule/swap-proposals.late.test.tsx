import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { swapPreview } from "@/lib/swap-store";
import type { SwapPair, SwapProposal, SwapSuggestion } from "@/lib/swaps";
import { SwapProposals, type ProposalAsk } from "./swap-dialog";

/**
 * The lists of Byt and Gör plats are not in a modal dialog, so the ask they were opened with can change under them (a second drop, another pair), and
 * an answer can come after the list has gone. What is shown, and what the board is told to draw, is the answer to the ask that stands, and no other.
 */

const swaps = vi.hoisted(() => ({
  suggest: { mutateAsync: vi.fn(), isPending: false },
  pair: { mutateAsync: vi.fn(), isPending: false },
  apply: { mutateAsync: vi.fn(), isPending: false },
}));
vi.mock("@/lib/swaps", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/swaps")>()), useSwaps: () => swaps }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next-intl", async () => {
  const { createTranslator } = await import("use-intl");
  const sv = (await import("@/messages/sv.json")).default;
  return {
    useLocale: () => "sv",
    useTranslations: (namespace: string) => createTranslator({ locale: "sv", messages: sv, namespace: namespace as never }),
  };
});

const slot = (dayOfWeek: number, start: number) => ({ dayOfWeek, startMinutes: start, endMinutes: start + 60 });
const view = (id: string, subjectName: string, groupName: string) => ({ id, subjectName, groupName, teacherId: null, coTeacherId: null, roomId: null, isLocked: false });
const swapOf = (id: string, a: string, b: string): SwapProposal => ({
  id,
  kind: "SWAP",
  moves: [
    { lessonId: a, from: slot(1, 480), to: slot(2, 600) },
    { lessonId: b, from: slot(2, 600), to: slot(1, 480) },
  ],
  parallels: [],
  external: [],
  hard: ["CLASH"],
  soft: [],
  lessons: [view(a, "Matematik", "7A"), view(b, "Kemi", "7B")],
  removedCalendarLessons: 0,
});
const pairOf = (proposal: SwapProposal): SwapPair => ({ academicYearId: "y", ok: true, proposal, refusals: [] });
const roomAnswer = (over: Partial<SwapSuggestion> = {}): SwapSuggestion => ({
  lessonId: "l-a",
  academicYearId: "y",
  unit: { lessonIds: ["l-a"], links: [] },
  selectedLocked: false,
  proposals: [],
  stats: { partners: 0, candidates: 0, judged: 0, refused: 0, truncated: false, chainsCut: false, elapsedMs: 1, phasesMs: { read: 0, index: 0, warm: 0, search: 0 } },
  ...over,
});
const later = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const pair = (lessonId: string, otherLessonId: string): ProposalAsk => ({ kind: "pair", lessonId, otherLessonId });
const draw = (ask: ProposalAsk) => <SwapProposals ask={ask} teacherName={() => null} roomName={() => null} onApplied={vi.fn()} onDone={vi.fn()} />;

beforeEach(() => {
  vi.clearAllMocks();
  swapPreview.set(null);
});

describe("an answer that comes late", () => {
  it("is not shown when the ask has changed since: the board and the list are the answer to the ask that stands", async () => {
    const first = later<SwapPair>();
    swaps.pair.mutateAsync.mockImplementation((body: { lessonId: string }) => (body.lessonId === "l-a" ? first.promise : Promise.resolve(pairOf(swapOf("p-2", "l-c", "l-d")))));
    const view_ = render(draw(pair("l-a", "l-b")));
    view_.rerender(draw(pair("l-c", "l-d")));
    await screen.findByText("1 förslag, de bästa först");
    expect(swapPreview.get()?.id).toBe("p-2");
    // The first ask answers now, after the second has.
    await act(async () => {
      first.resolve(pairOf(swapOf("p-1", "l-a", "l-b")));
      await Promise.resolve();
    });
    expect(swapPreview.get()?.id).toBe("p-2");
    expect(screen.getAllByRole("listitem").filter((li) => li.hasAttribute("data-swap-proposal"))).toHaveLength(1);
  });

  it("is not drawn on the board when the list has gone", async () => {
    const answer = later<SwapPair>();
    swaps.pair.mutateAsync.mockReturnValue(answer.promise);
    const view_ = render(draw(pair("l-a", "l-b")));
    view_.unmount();
    await act(async () => {
      answer.resolve(pairOf(swapOf("p-1", "l-a", "l-b")));
      await Promise.resolve();
    });
    expect(swapPreview.get()).toBeNull();
  });

  it("asks again, and only once, when the lessons asked about are other ones", async () => {
    swaps.pair.mutateAsync.mockResolvedValue(pairOf(swapOf("p-1", "l-a", "l-b")));
    const view_ = render(draw(pair("l-a", "l-b")));
    await screen.findByText("1 förslag, de bästa först");
    expect(swaps.pair.mutateAsync).toHaveBeenCalledTimes(1);
    view_.rerender(draw(pair("l-a", "l-b")));
    expect(swaps.pair.mutateAsync).toHaveBeenCalledTimes(1);
    swaps.pair.mutateAsync.mockResolvedValue(pairOf(swapOf("p-2", "l-c", "l-d")));
    view_.rerender(draw(pair("l-c", "l-d")));
    await waitFor(() => expect(swapPreview.get()?.id).toBe("p-2"));
    expect(swaps.pair.mutateAsync).toHaveBeenCalledTimes(2);
    expect(swaps.pair.mutateAsync).toHaveBeenLastCalledWith({ lessonId: "l-c", otherLessonId: "l-d" });
  });
});

describe("what the list says of the two lessons the person marked", () => {
  it("calls both of them Vald, the second one as well", async () => {
    swaps.pair.mutateAsync.mockResolvedValue(pairOf(swapOf("p-1", "l-a", "l-b")));
    render(draw(pair("l-a", "l-b")));
    await screen.findByText("1 förslag, de bästa först");
    expect(screen.getAllByText("(Vald)")).toHaveLength(2);
  });
});

describe("Byt at a drop on a lesson that cannot be moved", () => {
  it.each([
    ["PLACED", /Lektionen är förlagd/],
    ["EXEMPT", /ett undantag/],
  ] as const)("says why a picked lesson that is %s has nothing to swap, and asks no pair", async (immovable, words) => {
    swaps.suggest.mutateAsync.mockResolvedValue(roomAnswer({ immovable }));
    render(draw({ kind: "swap", lessonId: "l-a", target: { dayOfWeek: 2, startMinutes: 600 } }));
    await screen.findByText(words);
    expect(swaps.pair.mutateAsync).not.toHaveBeenCalled();
  });
});
