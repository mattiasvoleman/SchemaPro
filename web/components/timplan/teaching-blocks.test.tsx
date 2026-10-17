import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/lib/api";
import type { TeachingBlock, TeachingRequirement } from "@/lib/types";
import { BlocksHost, blockWarnings, type WarningText } from "./teaching-blocks";

/**
 * Parallella block on the Timplansposter page. The gateway decides what a
 * block may hold (teaching-blocks.service.spec.ts); here PostgREST is a stub
 * answering the year's blocks, and the mutations are recorded.
 */

const state = vi.hoisted(() => ({
  blocks: [] as TeachingBlock[],
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  invalidates: [] as unknown[][],
}));

vi.mock("@/utils/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ order: async () => ({ data: state.blocks, error: null }) }),
      }),
    }),
  }),
}));
vi.mock("@/lib/queries", () => ({
  useCrudMutations: (_path: string, keys: unknown[][]) => (state.invalidates = keys, {
    create: { mutateAsync: state.create, isPending: false },
    update: { mutateAsync: state.update, isPending: false },
    remove: { mutateAsync: state.remove, isPending: false },
  }),
}));
vi.mock("sonner", () => ({ toast: { success: state.success, error: state.error, warning: state.warning } }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () =>
    Object.assign(
      (key: string, values?: Record<string, unknown>) =>
        values ? `${key}(${Object.values(values).join("|")})` : key,
      { has: () => true },
    ),
}));

const YEAR = "y-1";
const groups = [
  { id: "g-7a", name: "7A", kind: "CLASS" },
  { id: "g-ty", name: "Ty7", kind: "TEACHING_GROUP" },
  { id: "g-fr", name: "Fr7", kind: "TEACHING_GROUP" },
  { id: "g-sp", name: "Sp7", kind: "TEACHING_GROUP" },
];
const subjects = [
  { id: "s-ty", name: "Tyska" },
  { id: "s-fr", name: "Franska" },
  { id: "s-sp", name: "Spanska" },
  { id: "s-ma", name: "Matematik" },
];
const row = (id: string, groupId: string, subjectId: string, extra: Partial<TeachingRequirement> = {}) =>
  ({
    id,
    academicYearId: YEAR,
    subjectId,
    studentGroupId: groupId,
    teacherId: `t-${id}`,
    coTeacherId: null,
    lessonsPerWeek: 2,
    minutesPerLesson: 60,
    minutesBefore: 0,
    minutesAfter: 0,
    teacherLoadPercent: 100,
    coTeacherLoadPercent: 100,
    recurrence: "ALL_WEEKS",
    startDate: null,
    endDate: null,
    blockId: null,
    ...extra,
  }) as TeachingRequirement;

function show(requirements: TeachingRequirement[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <BlocksHost academicYearId={YEAR} requirements={requirements} groups={groups} subjects={subjects} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.blocks = [{ id: "b-sv", academicYearId: YEAR, name: "Språkval åk 7" }];
  for (const mock of [state.create, state.update, state.remove, state.error, state.success, state.warning]) {
    mock.mockReset().mockResolvedValue(undefined);
  }
});

describe("BlocksHost", () => {
  it("lists each block with its posts and their lessons", async () => {
    show([
      row("r-ty", "g-ty", "s-ty", { blockId: "b-sv" }),
      row("r-fr", "g-fr", "s-fr", { blockId: "b-sv" }),
      row("r-ma", "g-7a", "s-ma"),
    ]);

    const item = (await screen.findByRole("heading", { name: "Språkval åk 7" })).closest("li")!;
    expect(within(item).getByText(/^members\(/)).toHaveTextContent(
      "members(lengthPart(2|60)|cellLabel(Franska|Fr7) och cellLabel(Tyska|Ty7))",
    );
    expect(within(item).queryByRole("status")).not.toBeInTheDocument();
  });

  it("says before generation what the generator would refuse", async () => {
    show([
      row("r-ty", "g-ty", "s-ty", { blockId: "b-sv", teacherId: "t-anna" }),
      row("r-fr", "g-fr", "s-fr", { blockId: "b-sv", coTeacherId: "t-anna" }),
    ]);

    expect(await screen.findByText("warnTeacher(cellLabel(Franska|Fr7)|cellLabel(Tyska|Ty7))")).toBeInTheDocument();
  });

  it("creates a block with the posts ticked, through the gateway", async () => {
    state.blocks = [];
    show([row("r-ty", "g-ty", "s-ty"), row("r-fr", "g-fr", "s-fr"), row("r-ma", "g-7a", "s-ma")]);

    await userEvent.click(await screen.findByRole("button", { name: "new" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "save" })).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("name"), "  Språkval åk 7 ");
    await userEvent.click(within(dialog).getByLabelText(/cellLabel\(Tyska\|Ty7\)/));
    await userEvent.click(within(dialog).getByLabelText(/cellLabel\(Franska\|Fr7\)/));
    await userEvent.click(within(dialog).getByRole("button", { name: "save" }));

    expect(state.create).toHaveBeenCalledWith({
      academicYearId: YEAR,
      name: "Språkval åk 7",
      requirementIds: ["r-ty", "r-fr"],
    });
    expect(state.success).toHaveBeenCalledWith("saved(Språkval åk 7)");
  });

  it("lists teaching groups first, and offers no post another block holds", async () => {
    state.blocks = [
      { id: "b-sv", academicYearId: YEAR, name: "Språkval åk 7" },
      { id: "b-ev", academicYearId: YEAR, name: "Elevens val åk 7" },
    ];
    show([
      row("r-ma", "g-7a", "s-ma"),
      row("r-ty", "g-ty", "s-ty", { blockId: "b-sv" }),
      row("r-sp", "g-sp", "s-sp", { blockId: "b-ev" }),
    ]);

    await userEvent.click(await screen.findByRole("button", { name: "editNamed(Språkval åk 7)" }));
    const boxes = within(screen.getByRole("dialog")).getAllByRole("checkbox");
    expect(boxes.map((box) => box.closest("label")!.textContent)).toEqual([
      "cellLabel(Spanska|Sp7)· lengthPart(2|60)inOther(Elevens val åk 7)",
      "cellLabel(Tyska|Ty7)· lengthPart(2|60)",
      "cellLabel(Matematik|7A)· lengthPart(2|60)",
    ]);
    expect(boxes[0]).toBeDisabled();
    expect(boxes[1]).toBeChecked();
    await userEvent.click(boxes[1]!);
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "save" }));
    expect(state.update).toHaveBeenCalledWith({ id: "b-sv", name: "Språkval åk 7", requirementIds: [] });
  });

  it("says the gateway's refusal in a toast and keeps the dialog", async () => {
    state.blocks = [];
    state.create.mockRejectedValue(new Error("Timplansposterna i blocket \"Språkval åk 7\" läggs på samma tider …"));
    show([row("r-ty", "g-ty", "s-ty")]);

    await userEvent.click(await screen.findByRole("button", { name: "new" }));
    await userEvent.type(screen.getByLabelText("name"), "Språkval åk 7");
    await userEvent.click(screen.getByRole("button", { name: "save" }));

    expect(state.error).toHaveBeenCalledWith("Timplansposterna i blocket \"Språkval åk 7\" läggs på samma tider …");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  describe("Ändra lektioner", () => {
    const members = [
      row("r-ty", "g-ty", "s-ty", { blockId: "b-sv", lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] }),
      row("r-fr", "g-fr", "s-fr", { blockId: "b-sv", lessonsPerWeek: 2, minutesPerLesson: 80, lessonLengths: [80, 40] }),
    ];

    it("opens on the block's lengths and sends the whole shape, once, for the block", async () => {
      state.update.mockResolvedValue({ id: "b-sv", warnings: [] });
      show(members);

      await userEvent.click(await screen.findByRole("button", { name: "lessonsNamed(Språkval åk 7)" }));
      const dialog = screen.getByRole("dialog");
      expect(dialog).toHaveTextContent("lessonsDescription(2)");
      expect(within(dialog).getByLabelText("lengthLessons(1)")).toHaveValue(1);
      expect(within(dialog).getByLabelText("lengthMinutes(1)")).toHaveValue(80);
      // Back to one length: three lessons of 60 for every member.
      await userEvent.click(within(dialog).getByRole("button", { name: /removeLength/ }));
      await userEvent.clear(within(dialog).getByLabelText("lessonsPerWeek"));
      await userEvent.type(within(dialog).getByLabelText("lessonsPerWeek"), "3");
      await userEvent.clear(within(dialog).getByLabelText("minutesPerLesson"));
      await userEvent.type(within(dialog).getByLabelText("minutesPerLesson"), "60");
      await userEvent.click(within(dialog).getByRole("button", { name: "lessonsSave" }));

      expect(state.update.mock.calls).toEqual([
        [{ id: "b-sv", lessonsPerWeek: 3, minutesPerLesson: 60, lessonLengths: [] }],
      ]);
      expect(state.success).toHaveBeenCalledWith("lessonsSaved(Språkval åk 7)");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("waits on lengths that cannot be stored", async () => {
      show(members);

      await userEvent.click(await screen.findByRole("button", { name: "lessonsNamed(Språkval åk 7)" }));
      const dialog = screen.getByRole("dialog");
      await userEvent.clear(within(dialog).getByLabelText("lengthLessons(1)"));

      expect(within(dialog).getByRole("button", { name: "lessonsSave" })).toBeDisabled();
    });

    it("says the staffing policy's warnings and refusal after the post each is about", async () => {
      state.update.mockResolvedValueOnce({
        id: "b-sv",
        warnings: [{ code: "STAFF_TEACHER_OVER_TARGET", params: { minutes: 1200 }, requirementId: "r-fr" }],
      });
      show(members);

      await userEvent.click(await screen.findByRole("button", { name: "lessonsNamed(Språkval åk 7)" }));
      await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "lessonsSave" }));
      expect(state.warning).toHaveBeenCalledWith("lessonsSaved(Språkval åk 7)", {
        description: "cellLabel(Franska|Fr7): STAFF_TEACHER_OVER_TARGET(1200)",
        duration: 12_000,
      });

      state.update.mockRejectedValueOnce(
        new ApiError(409, "Över mål", "STAFF_TEACHER_OVER_TARGET", { minutes: 1300, requirementId: "r-ty" }),
      );
      await userEvent.click(await screen.findByRole("button", { name: "lessonsNamed(Språkval åk 7)" }));
      await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "lessonsSave" }));
      expect(screen.getByRole("dialog")).toHaveTextContent(
        "refusedTitle cellLabel(Tyska|Ty7): STAFF_TEACHER_OVER_TARGET(1300|r-ty)",
      );
      expect(state.error).not.toHaveBeenCalled();
    });

    it("refreshes the teachers' load and the candidates with the block, as a post's save does", async () => {
      show(members);
      await screen.findByRole("heading", { name: "Språkval åk 7" });

      expect(state.invalidates).toEqual([
        ["teachingBlocks", YEAR],
        ["requirements", YEAR],
        ["staffingLoad"],
        ["staffingUnstaffed"],
        ["staffingSuggestions"],
      ]);
    });

    it("is not offered for a block without posts", async () => {
      show([row("r-ma", "g-7a", "s-ma")]);

      await screen.findByRole("heading", { name: "Språkval åk 7" });
      expect(screen.queryByRole("button", { name: "lessonsNamed(Språkval åk 7)" })).not.toBeInTheDocument();
    });
  });

  it("removes a block after asking, by its name", async () => {
    show([row("r-ty", "g-ty", "s-ty", { blockId: "b-sv" })]);

    await userEvent.click(await screen.findByRole("button", { name: "removeNamed(Språkval åk 7)" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("removeTitle(Språkval åk 7)");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "remove" }));

    expect(state.remove).toHaveBeenCalledWith("b-sv");
  });
});

describe("BlocksHost under Läsbehörighet", () => {
  // The (app) layout's readOnlyStyle hides [data-writes~="PLANERING"] from a
  // profile that does not write planering (teaching-blocks.controller.ts
  // @Area); the blocks and their warnings stay to read.
  it("marks Nytt block and each block's Lektioner, Redigera and Ta bort", async () => {
    show([row("r-ty", "g-ty", "s-ty", { blockId: "b-sv" })]);
    await screen.findByRole("heading", { name: "Språkval åk 7" });
    expect(screen.getByRole("button", { name: "new" })).toHaveAttribute("data-writes", "PLANERING");
    for (const name of ["lessonsNamed(Språkval åk 7)", "editNamed(Språkval åk 7)", "removeNamed(Språkval åk 7)"]) {
      expect(screen.getByRole("button", { name }).closest("[data-writes]")).toHaveAttribute("data-writes", "PLANERING");
    }
  });
});

describe("blockWarnings", () => {
  const t: WarningText = (key, values) => (values ? `${key}(${Object.values(values).join("|")})` : key);
  const label = (requirement: TeachingRequirement) => requirement.id;

  it("asks for two posts, and names a shared teacher and a shared group", () => {
    expect(blockWarnings([row("a", "g-ty", "s-ty")], label, t)).toEqual(["warnOne"]);
    expect(
      blockWarnings(
        [row("a", "g-ty", "s-ty", { teacherId: "t-1" }), row("b", "g-ty", "s-fr", { teacherId: "t-2" })],
        label,
        t,
      ),
    ).toEqual(["warnGroup(a|b)"]);
    expect(
      blockWarnings(
        [row("a", "g-ty", "s-ty", { coTeacherId: "t-1" }), row("b", "g-fr", "s-fr", { teacherId: "t-1" })],
        label,
        t,
      ),
    ).toEqual(["warnTeacher(a|b)"]);
    expect(blockWarnings([row("a", "g-ty", "s-ty"), row("b", "g-fr", "s-fr")], label, t)).toEqual([]);
  });
});
