import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MasterLesson, TeachingRequirement } from "@/lib/types";
import { BlockHost, type BlockActions, type BlockKit } from "./block-cards";

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


/*
 * Undantag med flit on a block's card: the card is one card for the block's lessons, and an exemption is a lesson's. The mark is the card's for EVERY member
 * that has one, in its own words (the one whose lessons stand apart from the rest says it too), as the card says what each clashing member clashes with
 * (g470 M-2) and not the first member's alone.
 */
const TIMED = { startMinutes: 600, endMinutes: 660, dayOfWeek: 1 };
const gridOf = (member: MasterLesson, mark?: { mark: string; markLabel: string }) => ({
  id: member.id,
  title: member.subjectId === "de" ? "Tyska" : "Franska",
  subtitle: "",
  color: "#000",
  locked: false,
  ...TIMED,
  ...(mark ?? {}),
});

describe("a block's card and the mark of an exemption", () => {
  it("says the mark of each member that has one, with that member's own words, and none of the first member's alone", async () => {
    const { kit } = mount();
    await waitFor(() => expect(kit()).not.toBeNull());
    const marks: Record<string, { mark: string; markLabel: string }> = {
      "b-fr": { mark: "Undantag", markLabel: "Undantag: ramtiden." },
    };
    const cards = kit().grid(lessons, (member) => gridOf(member, marks[member.id]));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ mark: "Undantag" });
    // The first member (a-ty) has none, the second does: the card names the member the words are about.
    expect(cards[0]!.markLabel).toBe("Franska: Undantag: ramtiden.");
  });

  it("says each member's, in the block's order, and the one word once", async () => {
    const { kit } = mount();
    await waitFor(() => expect(kit()).not.toBeNull());
    const marks: Record<string, { mark: string; markLabel: string }> = {
      "a-ty": { mark: "Undantag", markLabel: "Undantag: klassens lunch." },
      "b-fr": { mark: "Undantag", markLabel: "Undantag: ramtiden." },
    };
    const [card] = kit().grid(lessons, (member) => gridOf(member, marks[member.id]));
    expect(card!.mark).toBe("Undantag");
    expect(card!.markLabel).toBe("Tyska: Undantag: klassens lunch. Franska: Undantag: ramtiden.");
  });

  it("keeps a member's own mark when the member is shown alone (a filter), in the card that names its block", async () => {
    const { kit } = mount();
    await waitFor(() => expect(kit()).not.toBeNull());
    const marks: Record<string, { mark: string; markLabel: string }> = {
      "a-ty": { mark: "Undantag", markLabel: "Undantag: klassens lunch." },
      "b-fr": { mark: "Undantag", markLabel: "Undantag: ramtiden." },
    };
    // The block's name arrives with the block's rows: the member is drawn as a lesson of its own, with the block's name under it.
    const alone = await waitFor(() => {
      const [card] = kit().grid([lessons[1]!], (member) => gridOf(member, marks[member.id]));
      expect(card!.recurrenceNote).toContain("Språkval åk 7");
      return card!;
    });
    expect(alone).toMatchObject({ id: "b-fr", mark: "Undantag", markLabel: "Undantag: ramtiden." });
    expect(alone.blockCard).toBeUndefined();
  });

  it("says nothing when no member has one: the card is what it was", async () => {
    const { kit } = mount();
    await waitFor(() => expect(kit()).not.toBeNull());
    const [card] = kit().grid(lessons, (member) => gridOf(member));
    expect(card).not.toHaveProperty('mark', expect.anything());
    expect(card!.markLabel).toBeUndefined();
  });
});

beforeEach(() => {
  for (const mock of [state.patch, state.success, state.error, state.warning]) mock.mockReset();
});
