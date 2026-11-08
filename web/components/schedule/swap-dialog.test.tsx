import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";
import type { SwapProposal, SwapSuggestion } from "@/lib/swaps";
import english from "@/messages/en.json";
import swedish from "@/messages/sv.json";
import { SwapDialog } from "./swap-dialog";

/**
 * What this file guards: that the proposals are SHOWN as the gateway judged
 * them — every moved lesson, every lesson that goes along and why, what the
 * other schools hold, what it costs — and that an apply sends exactly those
 * moves, whole, and every way out of it leaves the school somewhere it can see.
 *
 * The rules and the search are the gateway's (src/swaps). What only this
 * dialog can get wrong is the round trip.
 */

const swaps = vi.hoisted(() => ({
  suggest: { mutateAsync: vi.fn(), isPending: false },
  apply: { mutateAsync: vi.fn(), isPending: false },
}));

vi.mock("@/lib/swaps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/swaps")>()),
  useSwaps: () => swaps,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

const slot = (dayOfWeek: number, start: number) => ({ dayOfWeek, startMinutes: start, endMinutes: start + 60 });
const lesson = (id: string, subjectName: string, groupName: string, isLocked = false) => ({
  id,
  subjectName,
  groupName,
  teacherId: `t-${id}`,
  coTeacherId: null,
  roomId: `r-${id}`,
  isLocked,
});

const SWAP: SwapProposal = {
  id: "p-swap",
  kind: "SWAP",
  moves: [
    { lessonId: "l-a", from: slot(1, 480), to: slot(2, 600) },
    { lessonId: "l-b", from: slot(2, 600), to: slot(1, 480) },
    { lessonId: "l-c", from: slot(2, 600), to: slot(1, 480) },
  ],
  parallels: [{ kind: "BLOCK", lessonId: "l-c", viaLessonId: "l-b", outcome: "FOLLOWS" }],
  external: [
    { kind: "SHARED_TEACHER", lessonId: "l-a", resourceId: "t-l-a", schools: ["Norra skolan"], dayOfWeek: 2, startMinutes: 540, endMinutes: 600 },
  ],
  hard: ["CLASH", "FRAME", "OTHER_SCHOOL"],
  soft: [
    { code: "PUPIL_GAPS", unit: "MINUTES", before: 120, after: 60, delta: -60 },
    { code: "TEACHER_GAPS", unit: "MINUTES", before: 30, after: 30, delta: 0 },
    { code: "DISTRIBUTION", unit: "BREACHES", before: 0, after: 1, delta: 1 },
    { code: "TEACHER_DAY", unit: "BREACHES", before: 0, after: 0, delta: 0 },
    { code: "MOVED_LESSONS", unit: "LESSONS", before: 0, after: 3, delta: 3 },
  ],
  lessons: [lesson("l-a", "Matematik", "7A", true), lesson("l-b", "Tyska", "7B"), lesson("l-c", "Franska", "7C")],
  removedCalendarLessons: 2,
};

const CHAIN: SwapProposal = {
  ...SWAP,
  id: "p-chain",
  kind: "CHAIN",
  parallels: [],
  external: [],
  moves: [
    { lessonId: "l-a", from: slot(1, 480), to: slot(2, 600) },
    { lessonId: "l-b", from: slot(2, 600), to: slot(3, 660) },
    { lessonId: "l-d", from: slot(3, 660), to: slot(1, 480) },
  ],
  lessons: [lesson("l-a", "Matematik", "7A", true), lesson("l-b", "Tyska", "7B"), lesson("l-d", "Svenska", "7D")],
  removedCalendarLessons: 0,
};

const suggestion = (over: Partial<SwapSuggestion> = {}): SwapSuggestion => ({
  lessonId: "l-a",
  academicYearId: "y-1",
  unit: { lessonIds: ["l-a"], links: [] },
  selectedLocked: false,
  proposals: [SWAP, CHAIN],
  stats: { partners: 9, candidates: 4, judged: 4, refused: 0, truncated: false, chainsCut: false, elapsedMs: 120, phasesMs: { read: 20, index: 10, warm: 10, search: 80 } },
  ...over,
});

const onApplied = vi.fn();
const onOpenChange = vi.fn();

function dialog(open = true, lessonId: string | null = "l-a") {
  return (
    <SwapDialog
      open={open}
      onOpenChange={onOpenChange}
      lessonId={lessonId}
      lessonName="Matematik · 7A"
      teacherName={(id) => (id === "t-l-a" ? "Anna Ek" : null)}
      roomName={(id) => (id === "r-l-a" ? "Sal 12" : null)}
      onApplied={onApplied}
    />
  );
}

async function opened(answer: SwapSuggestion = suggestion()) {
  swaps.suggest.mutateAsync.mockResolvedValue(answer);
  const view = render(dialog());
  await screen.findByText(/found/);
  return view;
}

beforeEach(() => {
  vi.clearAllMocks();
  swaps.apply.mutateAsync.mockResolvedValue({
    propagatedLessons: 4,
    removedCalendarLessons: 0,
    versionId: "v-1",
    undo: [{ lessonId: "l-a", from: slot(2, 600), to: slot(1, 480) }],
  });
});

describe("SwapDialog: what it shows of a proposal", () => {
  it("asks for the picked lesson on open and lists the swap and the chain", async () => {
    await opened();
    expect(swaps.suggest.mutateAsync).toHaveBeenCalledWith({ lessonId: "l-a" });
    expect(screen.getByText("found(2)")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "swap: Matematik 7A, Tyska 7B, Franska 7C",
      "chain: Matematik 7A, Tyska 7B, Svenska 7D",
    ]);
  });

  it("names every moved lesson with where it goes, marks the picked one and the locked", async () => {
    await opened();
    const [swap] = screen.getAllByRole("listitem").filter((li) => within(li).queryByRole("heading", { name: /^swap/ }));
    expect(within(swap!).getByText("Matematik 7A")).toBeInTheDocument();
    expect(within(swap!).getByText("Tyska 7B")).toBeInTheDocument();
    expect(within(swap!).getByText("Franska 7C")).toBeInTheDocument();
    expect(within(swap!).getByText(/moveLine\(1 08:00–09:00\|2 10:00–11:00\)/)).toBeInTheDocument();
    expect(within(swap!).getByText("(picked)")).toBeInTheDocument();
    expect(within(swap!).getByText("locked")).toBeInTheDocument();
  });

  it("says which lessons go along and why, never silently", async () => {
    await opened();
    expect(screen.getByText(/followsBecause\(Franska 7C\|parallel\.BLOCK\)/)).toBeInTheDocument();
  });

  it("names what another school holds at the new times", async () => {
    await opened();
    expect(screen.getByText(/external\.SHARED_TEACHER\(Anna Ek\|\?\|Norra skolan\|2 09:00–10:00\)/)).toBeInTheDocument();
  });

  it("says before Tillämpa how many published lessons a proposal removes from the calendar, and nothing for one that removes none", async () => {
    await opened();
    const [swap] = screen.getAllByRole("listitem").filter((li) => within(li).queryByRole("heading", { name: /^swap/ }));
    const [chain] = screen.getAllByRole("listitem").filter((li) => within(li).queryByRole("heading", { name: /^chain/ }));
    const warning = within(swap!).getByText("removesCalendar(2)");
    expect(warning.closest("[id]")).toHaveAttribute("id", "swap-p-swap-removes");
    // The button is described by the proposal and by what it would remove, so a screen reader hears both on Tillämpa.
    expect(within(swap!).getByRole("button", { name: "apply" })).toHaveAccessibleDescription(/swap: Matematik 7A.*removesCalendar\(2\)/);
    expect(within(chain!).queryByText(/removesCalendar/)).not.toBeInTheDocument();
    expect(within(chain!).getByRole("button", { name: "apply" })).toHaveAttribute("aria-describedby", "swap-p-chain");
  });

  it("says what the checks leave out, once under the list", async () => {
    await opened();
    expect(screen.getAllByText("notChecked")).toHaveLength(1);
  });

  it("lists the hard rules held and the soft costs, before and after, in the pupils' order", async () => {
    await opened();
    const [swap] = screen.getAllByRole("listitem").filter((li) => within(li).queryByRole("heading", { name: /^swap/ }));
    expect(within(swap!).getByText(/hardTitle/)).toBeInTheDocument();
    expect(within(swap!).getByText(/hard\.CLASH; hard\.FRAME; hard\.OTHER_SCHOOL/)).toBeInTheDocument();
    const terms = within(swap!).getAllByRole("term").map((term) => term.textContent);
    expect(terms).toEqual(["soft.PUPIL_GAPS", "soft.TEACHER_GAPS", "soft.DISTRIBUTION", "soft.TEACHER_DAY", "soft.MOVED_LESSONS"]);
    // A shorter idle time is the quiet weight, a longer count of breaches the destructive colour.
    expect(within(swap!).getByText(/minutes\(120\) → minutes\(60\)/)).toHaveClass("font-semibold");
    expect(within(swap!).getByText(/breaches\(0\) → breaches\(1\)/)).toHaveClass("text-destructive");
    expect(within(swap!).getByText("lessons(3)")).toBeInTheDocument();
  });

  it("says when the lesson goes with others, and when it is locked", async () => {
    await opened(
      suggestion({
        selectedLocked: true,
        unit: { lessonIds: ["l-a", "l-z"], links: [{ kind: "HALF", lessonId: "l-z", viaLessonId: "l-a" }] },
      }),
    );
    expect(screen.getByText("lockedPicked")).toBeInTheDocument();
    expect(screen.getByText("withParallel(1)")).toBeInTheDocument();
  });

  it("says so when there is nothing to offer, and when the search ran out of time", async () => {
    swaps.suggest.mutateAsync.mockResolvedValue(suggestion({ proposals: [], stats: { ...suggestion().stats, truncated: true } }));
    render(dialog());
    expect(await screen.findByText("none")).toBeInTheDocument();
    expect(screen.getByText("truncated")).toBeInTheDocument();
  });

  it("explains a lesson that cannot be swapped instead of listing", async () => {
    swaps.suggest.mutateAsync.mockResolvedValue(suggestion({ proposals: [], immovable: "PARKED" }));
    render(dialog());
    expect(await screen.findByText("parked")).toBeInTheDocument();
    expect(screen.queryByText(/found/)).not.toBeInTheDocument();
  });

  it("offers a retry when the ask fails", async () => {
    swaps.suggest.mutateAsync.mockRejectedValueOnce(new Error("down")).mockResolvedValue(suggestion());
    render(dialog());
    await userEvent.click(await screen.findByRole("button", { name: "retry" }));
    expect(await screen.findByText("found(2)")).toBeInTheDocument();
    expect(swaps.suggest.mutateAsync).toHaveBeenCalledTimes(2);
  });

  it("ignores an answer that lands after the dialog was closed", async () => {
    let resolve!: (value: SwapSuggestion) => void;
    swaps.suggest.mutateAsync.mockReturnValue(new Promise<SwapSuggestion>((r) => (resolve = r)));
    const view = render(dialog());
    view.rerender(dialog(false));
    await act(async () => resolve(suggestion()));
    view.rerender(dialog(true));
    // The late answer is not on screen; the reopened dialog asks again.
    expect(screen.queryByText("found(2)")).not.toBeInTheDocument();
  });
});

describe("SwapDialog: apply", () => {
  it("sends exactly the proposal's moves, whole, as clocks, and offers Ångra", async () => {
    await opened();
    const [swap] = screen.getAllByRole("listitem").filter((li) => within(li).queryByRole("heading", { name: /^swap/ }));
    await userEvent.click(within(swap!).getByRole("button", { name: "apply" }));
    await waitFor(() => expect(swaps.apply.mutateAsync).toHaveBeenCalledTimes(1));
    expect(swaps.apply.mutateAsync).toHaveBeenCalledWith({
      lessonId: "l-a",
      moves: SWAP.moves.map((move) => ({
        lessonId: move.lessonId,
        from: { dayOfWeek: move.from.dayOfWeek, startTime: expect.stringMatching(/^\d\d:\d\d$/), endTime: expect.stringMatching(/^\d\d:\d\d$/) },
        to: { dayOfWeek: move.to.dayOfWeek, startTime: expect.stringMatching(/^\d\d:\d\d$/), endTime: expect.stringMatching(/^\d\d:\d\d$/) },
      })),
    });
    expect(swaps.apply.mutateAsync.mock.calls[0]![0].moves[0].from).toEqual({ dayOfWeek: 1, startTime: "08:00", endTime: "09:00" });
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(toast.success).toHaveBeenCalledWith(
      "applied(3)",
      expect.objectContaining({ description: "calendarUpdated(4)", action: expect.objectContaining({ label: "undo" }) }),
    );
  });

  it("says after Tillämpa how many calendar lessons were removed, next to how many followed", async () => {
    swaps.apply.mutateAsync.mockResolvedValue({
      propagatedLessons: 4,
      removedCalendarLessons: 2,
      versionId: "v-1",
      undo: [{ lessonId: "l-a", from: slot(2, 600), to: slot(1, 480) }],
    });
    await opened();
    const [swap] = screen.getAllByRole("listitem").filter((li) => within(li).queryByRole("heading", { name: /^swap/ }));
    await userEvent.click(within(swap!).getByRole("button", { name: "apply" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith("applied(3)", expect.objectContaining({ description: "calendarUpdated(4) calendarRemoved(2)" }));
  });

  it("says it even when nothing followed: only removals", async () => {
    swaps.apply.mutateAsync.mockResolvedValue({ propagatedLessons: 0, removedCalendarLessons: 1, versionId: "v-1", undo: [] });
    await opened();
    const [swap] = screen.getAllByRole("listitem").filter((li) => within(li).queryByRole("heading", { name: /^swap/ }));
    await userEvent.click(within(swap!).getByRole("button", { name: "apply" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith("applied(3)", expect.objectContaining({ description: "calendarRemoved(1)" }));
  });

  it("takes it back from the toast by sending the answer's undo, and says if the timetable moved since", async () => {
    await opened();
    const [swap] = screen.getAllByRole("listitem").filter((li) => within(li).queryByRole("heading", { name: /^swap/ }));
    await userEvent.click(within(swap!).getByRole("button", { name: "apply" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const action = (toast.success as ReturnType<typeof vi.fn>).mock.calls[0]![1].action;

    await act(async () => action.onClick());
    // A second safety version of its own, not another "Före byte".
    expect(swaps.apply.mutateAsync).toHaveBeenLastCalledWith({
      lessonId: "l-a",
      moves: [{ lessonId: "l-a", from: { dayOfWeek: 2, startTime: "10:00", endTime: "11:00" }, to: { dayOfWeek: 1, startTime: "08:00", endTime: "09:00" } }],
      versionName: "Före ångra",
    });
    // Nothing was removed: it says the lessons are back and that the calendar followed, and nothing about what is lost.
    expect(toast.success).toHaveBeenLastCalledWith("undone", expect.objectContaining({ description: "undoneCalendar(4)" }));

    swaps.apply.mutateAsync.mockRejectedValueOnce(new ApiError(409, "clash", "X"));
    await act(async () => action.onClick());
    expect(toast.error).toHaveBeenLastCalledWith("undoStale");
  });

  /*
   * What Ångra says is what it does. The timetable's lessons go back and the
   * published ones that followed are moved back; the calendar lessons the swap
   * removed, with their vikarie and homework, are not recreated, and a lesson
   * the undo removes in its turn is not either.
   */
  it("after a swap that removed calendar lessons, Ångra says they do not come back, adding any the undo removed itself", async () => {
    swaps.apply.mutateAsync.mockResolvedValueOnce({
      propagatedLessons: 4,
      removedCalendarLessons: 2,
      versionId: "v-1",
      undo: [{ lessonId: "l-a", from: slot(2, 600), to: slot(1, 480) }],
    });
    await opened();
    const [swap] = screen.getAllByRole("listitem").filter((li) => within(li).queryByRole("heading", { name: /^swap/ }));
    await userEvent.click(within(swap!).getByRole("button", { name: "apply" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const action = (toast.success as ReturnType<typeof vi.fn>).mock.calls[0]![1].action;

    // The undo moved 3 published lessons back and removed 1 more of its own: 2 + 1 are gone for good.
    swaps.apply.mutateAsync.mockResolvedValueOnce({ propagatedLessons: 3, removedCalendarLessons: 1, versionId: "v-2", undo: [] });
    await act(async () => action.onClick());
    expect(toast.success).toHaveBeenLastCalledWith("undone", expect.objectContaining({ description: "undoneCalendar(3) undoneNotRestored(3)" }));
  });

  it("says only that the timetable is back when no published lesson followed or went", async () => {
    swaps.apply.mutateAsync.mockResolvedValueOnce({ propagatedLessons: 0, removedCalendarLessons: 0, versionId: "v-1", undo: [] });
    await opened();
    const [swap] = screen.getAllByRole("listitem").filter((li) => within(li).queryByRole("heading", { name: /^swap/ }));
    await userEvent.click(within(swap!).getByRole("button", { name: "apply" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const action = (toast.success as ReturnType<typeof vi.fn>).mock.calls[0]![1].action;
    swaps.apply.mutateAsync.mockResolvedValueOnce({ propagatedLessons: 0, removedCalendarLessons: 0, versionId: "v-2", undo: [] });
    await act(async () => action.onClick());
    expect(toast.success).toHaveBeenLastCalledWith("undone");
  });

  it.each([
    ["SWAP_STALE", "stale"],
    ["SWAP_SPLITS_PARALLEL", "splitsParallel"],
    ["SWAP_LOCKED", "lockedPartner"],
  ])("on a 409 %s says so and asks for new proposals", async (code, text) => {
    await opened();
    swaps.apply.mutateAsync.mockRejectedValueOnce(new ApiError(409, "english", code));
    const [swap] = screen.getAllByRole("listitem").filter((li) => within(li).queryByRole("heading", { name: /^swap/ }));
    await userEvent.click(within(swap!).getByRole("button", { name: "apply" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(text));
    await waitFor(() => expect(swaps.suggest.mutateAsync).toHaveBeenCalledTimes(2));
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("shows the clash rule's own sentence for a double booking, and asks again", async () => {
    await opened();
    swaps.apply.mutateAsync.mockRejectedValueOnce(new ApiError(409, "Teacher already teaches X in this slot."));
    const [swap] = screen.getAllByRole("listitem").filter((li) => within(li).queryByRole("heading", { name: /^swap/ }));
    await userEvent.click(within(swap!).getByRole("button", { name: "apply" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Teacher already teaches X in this slot."));
  });

  it("reports any other failure and leaves the proposals where they are", async () => {
    await opened();
    swaps.apply.mutateAsync.mockRejectedValueOnce(new Error("boom"));
    const [swap] = screen.getAllByRole("listitem").filter((li) => within(li).queryByRole("heading", { name: /^swap/ }));
    await userEvent.click(within(swap!).getByRole("button", { name: "apply" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("boom"));
    expect(swaps.suggest.mutateAsync).toHaveBeenCalledTimes(1);
    expect(screen.getByText("found(2)")).toBeInTheDocument();
  });
});

/*
 * The mock above prints keys; these are the real sentences. Ångra's own text
 * promises the timetable's lessons and nothing about the calendar — the
 * calendar is said by the two sentences next to it, which say what moved back
 * and what did not.
 */
describe("the sentences Ångra uses", () => {
  const catalogues = { sv: swedish.swaps, en: english.swaps } as const;

  it.each(["sv", "en"] as const)("%s: undone does not mention the calendar, and the removed lessons are said not to come back", (locale) => {
    const text = catalogues[locale];
    expect(text.undone).not.toMatch(/kalender|calendar|published|publicerad/i);
    expect(text.undoneNotRestored).toMatch(locale === "sv" ? /kommer inte tillbaka/ : /do(es)? not come back/);
    expect(text.undoneNotRestored).toMatch(locale === "sv" ? /vikarie/ : /substitute/);
    expect(text.removesCalendar).toMatch(locale === "sv" ? /Ångra lägger inte tillbaka/ : /Undo does not put them back/);
  });
});
