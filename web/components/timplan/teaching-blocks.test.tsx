import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  useCrudMutations: () => ({
    create: { mutateAsync: state.create, isPending: false },
    update: { mutateAsync: state.update, isPending: false },
    remove: { mutateAsync: state.remove, isPending: false },
  }),
}));
vi.mock("sonner", () => ({ toast: { success: state.success, error: state.error } }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
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
  for (const mock of [state.create, state.update, state.remove, state.error, state.success]) {
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

  it("removes a block after asking, by its name", async () => {
    show([row("r-ty", "g-ty", "s-ty", { blockId: "b-sv" })]);

    await userEvent.click(await screen.findByRole("button", { name: "removeNamed(Språkval åk 7)" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("removeTitle(Språkval åk 7)");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "remove" }));

    expect(state.remove).toHaveBeenCalledWith("b-sv");
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
