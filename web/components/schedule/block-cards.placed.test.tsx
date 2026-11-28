import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import { LESSON_IS_PLACED } from "@/lib/lesson-is-placed";
import type { MasterLesson, TeachingRequirement } from "@/lib/types";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { BlockHost, type BlockActions, type BlockKit } from "./block-cards";

/**
 * A block's card that the gateway refuses because its lessons are written from a förläggning (LESSON_IS_PLACED, 409).
 *
 * The card does not word the refusal: it hands the error, untouched, to the page's own `showError` (block-cards.tsx, the catch of
 * moveCard and of lock), which is what a single lesson's refusal goes through, and which says "the lesson is placed on the
 * timplan, and is changed there" for this code (admin/timetable/page.test.tsx: "shows the refusal of a placed lesson as its own
 * sentence"). So the sentence needs no byte on the timetable page, and what is held here is that the block's card does not stand
 * in its way: it says nothing of its own, keeps no undo for a move that was refused, and sends the same error.
 */

const state = vi.hoisted(() => ({
  patch: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  api: { patch: state.patch },
}));
vi.mock("@/utils/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          order: async () => ({ data: [{ id: "b", academicYearId: "y", name: "Språkval åk 7", sameTimesAsBlockId: null }], error: null }),
        }),
      }),
    }),
  }),
}));
vi.mock("sonner", () => ({ toast: { success: state.success, error: state.error, warning: state.warning } }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

const lesson = (id: string, studentGroupId: string, subjectId: string) =>
  ({
    id,
    academicYearId: "y",
    subjectId,
    studentGroupId,
    teacherId: null,
    coTeacherId: null,
    roomId: null,
    dayOfWeek: 1,
    startTime: "10:00:00",
    endTime: "11:00:00",
    isLocked: false,
    isParked: false,
    recurrence: "ALL_WEEKS",
    startDate: null,
    endDate: null,
    extraGroupIds: [],
    studentIds: [],
  }) as MasterLesson;

const lessons = [lesson("a-ty", "ty7", "de"), lesson("b-fr", "fr7", "fr")];
const posts = [
  { studentGroupId: "ty7", subjectId: "de", blockId: "b" },
  { studentGroupId: "fr7", subjectId: "fr", blockId: "b" },
] as TeachingRequirement[];

const placed = () => new ApiError(409, "Lektionen är förlagd på timplanen och skrivs om därifrån vid varje Generera.", LESSON_IS_PLACED);

function mount() {
  const actions = {
    update: vi.fn(),
    // The page's drop asks first when the lessons reach more than one class, and then moves them: here it moves them.
    drop: vi.fn((_moved: MasterLesson[], _change: unknown, go?: () => void) => go?.()),
    validate: vi.fn(() => true),
    history: { push: vi.fn() },
    showError: vi.fn(),
    // The question before a change in Direkt that reaches families: not asked here, the write is run.
    guard: <T,>(run: () => Promise<T>) => run(),
    announce: vi.fn(),
    title: vi.fn(() => "saved"),
    name: vi.fn((row: MasterLesson) => row.id),
    openEditor: vi.fn(),
  } satisfies BlockActions;
  let kit: BlockKit | null = null;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <BlockHost
        academicYearId="y"
        lessons={lessons}
        requirements={posts}
        actions={actions}
        onKit={(next) => {
          kit = next;
        }}
      />
    </QueryClientProvider>,
  );
  return { actions, kit: () => kit! };
}

beforeEach(() => {
  for (const mock of [state.patch, state.success, state.error, state.warning]) mock.mockReset();
});

describe("a block's card whose lessons are placed", () => {
  it("is moved through the card's own write, and a refusal of it reaches the page's showError as it came, with its code", async () => {
    const error = placed();
    state.patch.mockRejectedValue(error);
    const { actions, kit } = mount();
    await waitFor(() => expect(kit()).not.toBeNull());

    act(() => {
      kit().move("block:a-ty", { dayOfWeek: 3, startMinutes: 9 * 60, endMinutes: 10 * 60 });
    });

    await waitFor(() => expect(actions.showError).toHaveBeenCalledTimes(1));
    expect(state.patch).toHaveBeenCalledWith("/api/v1/master-lessons/block-card", {
      lessonIds: ["a-ty", "b-fr"],
      dayOfWeek: 3,
      startTime: "09:00",
      endTime: "10:00",
    });
    expect(actions.showError.mock.calls[0]![0]).toBe(error);
    expect((actions.showError.mock.calls[0]![0] as ApiError).code).toBe(LESSON_IS_PLACED);
    // The card says nothing of its own, announces no save, and keeps no way back for a move that did not happen.
    expect(actions.history.push).not.toHaveBeenCalled();
    expect(actions.announce).not.toHaveBeenCalled();
    expect(state.error).not.toHaveBeenCalled();
    expect(state.success).not.toHaveBeenCalled();
  });

  it("is locked through the card's dialog, and a refusal of that reaches the page's showError as it came too", async () => {
    const error = placed();
    state.patch.mockRejectedValue(error);
    const { actions, kit } = mount();
    await waitFor(() => expect(kit()).not.toBeNull());
    act(() => {
      kit().open("block:a-ty");
    });

    await userEvent.click(await screen.findByRole("button", { name: "lock" }));

    await waitFor(() => expect(actions.showError).toHaveBeenCalledTimes(1));
    expect(state.patch).toHaveBeenCalledWith("/api/v1/master-lessons/block-lock", { blockId: "b", isLocked: true });
    expect(actions.showError.mock.calls[0]![0]).toBe(error);
    expect(actions.history.push).not.toHaveBeenCalled();
    expect(state.success).not.toHaveBeenCalled();
  });

  it("is moved once the gateway lets it: the save is announced and can be undone, which a refused move cannot", async () => {
    state.patch.mockResolvedValue({ propagatedLessons: 0 });
    const { actions, kit } = mount();
    await waitFor(() => expect(kit()).not.toBeNull());

    act(() => {
      kit().move("block:a-ty", { dayOfWeek: 3, startMinutes: 9 * 60, endMinutes: 10 * 60 });
    });

    await waitFor(() => expect(actions.announce).toHaveBeenCalledTimes(1));
    expect(actions.history.push).toHaveBeenCalledTimes(1);
    expect(actions.showError).not.toHaveBeenCalled();
    // The step says what it was about for the list of the session's steps (E9): the block, and where it went.
    expect(actions.history.push.mock.calls[0]![0]).toMatchObject({ label: "block-move", meta: { what: "block-move", name: expect.any(String), dayOfWeek: 3, startTime: "09:00", endTime: "10:00" } });
  });

  it("is locked once the gateway lets it: the step says which block, and whether it was locked or unlocked", async () => {
    state.patch.mockResolvedValue({ blockId: "b", isLocked: true, lessonIds: ["a-ty", "b-fr"], parked: 0 });
    const { actions, kit } = mount();
    await waitFor(() => expect(kit()).not.toBeNull());
    act(() => {
      kit().open("block:a-ty");
    });
    await userEvent.click(await screen.findByRole("button", { name: "lock" }));
    await waitFor(() => expect(actions.history.push).toHaveBeenCalledTimes(1));
    expect(actions.history.push.mock.calls[0]![0]).toMatchObject({ label: "block-lock", meta: { what: "block-lock", name: expect.any(String), locked: true } });
  });
});

describe("the sentence the page says for LESSON_IS_PLACED", () => {
  // The page's showError chooses timetable.lessonIsPlaced for the code, whether the lesson is one lesson or a block's card.
  it("points at Förlägg i veckan for a post (or its timplanspost), and at the block's own Förlägg for a parallel block, in both languages", () => {
    // A3: the sentence is true before and after the block's card in the week (C2), so it names the week for a post and the dialog for a block.
    expect(sv.timetable.lessonIsPlaced).toMatch(/Ändra den i Förlägg i veckan \(eller på timplansposten\), eller för ett parallellt block med Förlägg … under Block på sidan Timplansposter\.$/);
    expect(en.timetable.lessonIsPlaced).toMatch(/Change it in Place in the week \(or on its curriculum entry\), or for a parallel block with Place lessons … under Blocks on the Curriculum entries page\.$/);
    expect(sv.timetable.lessonIsPlaced).toMatch(/^Lektionen är förlagd, och Generera skriver om den från förläggningen\./);
    // The swap dialog says the same of the same code.
    expect(sv.swaps.placed).toContain("Förlägg i veckan");
    expect(en.swaps.placed).toContain("Place in the week");
  });
});
