import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import GroupsPage from "./page";

/**
 * Renders the real page.
 *
 * The lib specs cover the filtering and counting rules, but they cannot see
 * the page crash on render — which is exactly what happened twice here: a
 * `const` used inside a useMemo declared above it throws "Cannot access
 * before initialization", and TypeScript cannot prove use-before-declaration
 * across a callback boundary. Only mounting the component catches it.
 */

const YEAR = { id: "year-1", name: "2026/2027", isActive: true };
/** Rolled over to, not yet activated. */
const NEXT_YEAR = { id: "year-2", name: "2027/2028", isActive: false };

const groups = [
  { id: "g-7a", academicYearId: "year-1", name: "7A", kind: "CLASS", gradeLevel: 7 },
  {
    id: "g-ma71",
    academicYearId: "year-1",
    name: "Ma71",
    kind: "TEACHING_GROUP",
    gradeLevel: null,
  },
  {
    id: "g-en74",
    academicYearId: "year-1",
    name: "En74",
    kind: "TEACHING_GROUP",
    gradeLevel: null,
  },
  // Next year's 8A, rolled from this year's 7A and not yet activated: listed
  // beside this year's groups, told apart by its Läsår.
  { id: "g-next-8a", academicYearId: "year-2", name: "8A", kind: "CLASS", gradeLevel: 8 },
];

const people = [
  {
    id: "st-1",
    role: "STUDENT",
    firstName: "Alma",
    lastName: "Berg",
    email: "alma@skolan.se",
    phone: null,
    isActive: true,
    invitedAt: null,
    studentGroupId: "g-7a",
  },
  {
    id: "st-2",
    role: "STUDENT",
    firstName: "Nils",
    lastName: "Ek",
    email: "nils@skolan.se",
    phone: null,
    isActive: true,
    invitedAt: null,
    studentGroupId: "g-7a",
  },
];

/** Alma takes Ma71; Nils takes En74. */
const memberships = [
  { studentId: "st-1", studentGroupId: "g-ma71" },
  { studentId: "st-2", studentGroupId: "g-en74" },
];

/** What each useCrudMutations was told to invalidate, by path. */
const crudKeys = vi.hoisted(() => new Map<string, string[][]>());
/** The group writes, for the save's body (Ersättande grupper). */
const groupWrites = vi.hoisted(() => ({ create: [] as unknown[], update: [] as unknown[] }));
/** The school's läsår; a test empties it for a school that has none yet. */
const yearState = vi.hoisted(() => ({ years: [] as unknown[] }));
/** The school's groups; a test empties it for a school that has none yet. */
const groupState = vi.hoisted(() => ({ groups: [] as unknown[] }));
/**
 * The memberships read's state beyond its data, for the placement's guard;
 * dataUpdatedAt far ahead unless a test makes the answer older than the
 * opening that asks for it.
 */
const membershipsState = vi.hoisted(() => ({ isFetching: false, isError: false, dataUpdatedAt: Number.MAX_SAFE_INTEGER }));
/** The members dialog's read of a group's stored members. */
const membersState = vi.hoisted(() => ({
  data: [] as unknown[] | undefined,
  isLoading: false,
  isError: false,
}));

vi.mock("@/lib/queries", () => ({
  useAcademicYears: () => ({ data: yearState.years }),
  useGroups: () => ({ data: groupState.groups, isLoading: false }),
  usePeople: () => ({ data: people, dataUpdatedAt: Number.MAX_SAFE_INTEGER }),
  useGroupMemberships: () => ({ data: memberships, ...membershipsState }),
  useGroupMembers: () => membersState,
  useSetGroupMembers: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSubjects: () => ({
    data: [
      { id: "s-sv", name: "Svenska" },
      { id: "s-sva", name: "Svenska som andraspråk" },
    ],
  }),
  useCrudMutations: (path: string, keys: string[][]) => {
    crudKeys.set(path, keys);
    return {
      create: { mutateAsync: vi.fn(async (body: unknown) => groupWrites.create.push(body)), isPending: false },
      update: { mutateAsync: vi.fn(async (body: unknown) => groupWrites.update.push(body)), isPending: false },
      remove: { mutateAsync: vi.fn(), isPending: false },
    };
  },
}));

/** The classes the page hands the skolenheter card (tested on its own, school-units-card.test.tsx). */
const unitCard = vi.hoisted(() => ({ classes: [] as Array<{ name: string }> }));
vi.mock("./school-units-card", () => ({
  SchoolUnitsCard: ({ classes }: { classes: Array<{ name: string }> }) => {
    unitCard.classes = classes;
    return null;
  },
}));

vi.mock("@/components/import/csv-import-dialog", () => ({
  CsvImportDialog: () => null,
}));

/** The Halvklasser dialogs write through the gateway client directly. */
const api = vi.hoisted(() => ({ post: vi.fn(), put: vi.fn() }));
vi.mock("@/lib/api", () => ({ api }));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a>,
}));

// Echo the key so assertions read against stable text rather than copy.
vi.mock("next-intl", () => ({
  // DateField reads the active locale for its month and weekday names.
  useLocale: () => "sv",
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${Object.values(values).join("|")})` : key;
    return t;
  },
}));

/**
 * The search is a labelled type=search field (a searchbox) since the 2026-10-11
 * overhaul, named by its visible label rather than a placeholder.
 */
const searchBox = () => screen.getByRole("searchbox", { name: "searchLabel" });

const rowNames = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0]?.textContent ?? "");

describe("Groups page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    groupWrites.create = [];
    groupWrites.update = [];
    yearState.years = [YEAR, NEXT_YEAR];
    groupState.groups = groups;
    membersState.data = [];
    membersState.isLoading = false;
    membersState.isError = false;
  });

  it("hands the skolenheter card this year's classes, not next year's or a teaching group", () => {
    render(<GroupsPage />);
    expect(unitCard.classes.map((group) => group.name)).toEqual(["7A"]);
  });

  it("makes next year's projected class lists stale with every group write", () => {
    // Deleting B's 8A, or making it a teaching group, changes where the
    // activation sends 7A's pupils (it follows the links and the kinds), so
    // the overlay the timetable draws must be asked again, not served from
    // the cache for its staleTime.
    render(<GroupsPage />);
    expect(crudKeys.get("/api/v1/student-groups")).toEqual(
      expect.arrayContaining([["groups"], ["people", "yearRosters"]]),
    );
  });

  it("renders without crashing and lists every group", () => {
    render(<GroupsPage />);

    expect(rowNames().join(" ")).toContain("7A");
    expect(rowNames().join(" ")).toContain("Ma71");
    expect(rowNames().join(" ")).toContain("En74");
  });

  it("filters by group name", async () => {
    const user = userEvent.setup();
    render(<GroupsPage />);

    await user.type(searchBox(), "ma71");

    expect(rowNames().join(" ")).toContain("Ma71");
    expect(rowNames().join(" ")).not.toContain("En74");
  });

  it("finds the teaching group a student belongs to, by the student's name", async () => {
    // The question an admin actually has: "which group is Alma in?" Her home
    // class and her teaching group must both come back, and Nils's group
    // must not.
    const user = userEvent.setup();
    render(<GroupsPage />);

    await user.type(searchBox(), "alma");

    const names = rowNames().join(" ");
    expect(names).toContain("7A");
    expect(names).toContain("Ma71");
    expect(names).not.toContain("En74");
  });

  it("names the matching student under the group, not just the group", async () => {
    const user = userEvent.setup();
    render(<GroupsPage />);

    await user.type(searchBox(), "alma");

    expect(rowNames().join(" ")).toContain("Alma Berg");
  });

  it("says so when nothing matches", async () => {
    const user = userEvent.setup();
    render(<GroupsPage />);

    await user.type(searchBox(), "finns inte");

    // A miss says it is a miss, not that the year has no groups.
    expect(screen.getByText("noMatch")).toBeInTheDocument();
  });

  it("lists every läsår's groups, each with its Läsår, and no year picker", () => {
    // Restored after the 2026-10-11 overhaul scoped the list to one year:
    // between a rollover and its activation both years' classes are wanted
    // in one list, told apart by the column (manual 3.4).
    render(<GroupsPage />);

    expect(screen.getByRole("columnheader", { name: "year" })).toBeInTheDocument();
    const rows = screen.getAllByRole("row").slice(1);
    const rowOf = (name: string) =>
      rows.find((row) => within(row).getAllByRole("cell")[0]?.textContent?.startsWith(name));
    expect(within(rowOf("7A")!).getAllByRole("cell")[1]).toHaveTextContent("2026/2027");
    expect(within(rowOf("8A")!).getAllByRole("cell")[1]).toHaveTextContent("2027/2028");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("finds a group by its läsår, so a name that recurs across years narrows to one", async () => {
    const user = userEvent.setup();
    render(<GroupsPage />);

    await user.type(searchBox(), "8a 2028");
    expect(rowNames()).toHaveLength(1);
    expect(rowNames()[0]).toContain("8A");

    await user.clear(searchBox());
    await user.type(searchBox(), "2026");
    const names = rowNames().join(" ");
    expect(names).toContain("7A");
    expect(names).toContain("Ma71");
    expect(names).not.toContain("8A");
  });

  it("adds a new group to the active läsår unless another is chosen", async () => {
    const user = userEvent.setup();
    render(<GroupsPage />);

    await user.click(screen.getByRole("button", { name: "addGroup" }));
    expect(screen.getByRole("combobox", { name: "year" })).toHaveTextContent("2026/2027");
  });

  describe("Ersättande grupper: a teaching group replaces a subject", () => {
    it("offers the subject for a teaching group, and saves it", async () => {
      const user = userEvent.setup();
      render(<GroupsPage />);

      await user.click(screen.getByRole("button", { name: "editNamed(Ma71)" }));
      await user.click(screen.getByRole("combobox", { name: /replacesLabel/ }));
      await user.click(screen.getByRole("option", { name: "Svenska" }));
      await user.click(screen.getByRole("button", { name: "save" }));
      expect(groupWrites.update).toEqual([expect.objectContaining({ id: "g-ma71", replacesSubjectId: "s-sv" })]);
    });

    it("does not offer it for a class, nor for a half", async () => {
      groupState.groups = [...groups, { id: "h-1", academicYearId: "year-1", name: "7A:1", kind: "TEACHING_GROUP", gradeLevel: 7, halfOfId: "g-7a" }];
      const user = userEvent.setup();
      render(<GroupsPage />);

      await user.click(screen.getByRole("button", { name: "editNamed(7A)" }));
      expect(screen.queryByRole("combobox", { name: /replacesLabel/ })).toBeNull();
      await user.click(screen.getByRole("button", { name: "cancel" }));
      await user.click(screen.getByRole("button", { name: "editNamed(7A:1)" }));
      expect(screen.queryByRole("combobox", { name: /replacesLabel/ })).toBeNull();
    });

    it("saves a group that replaces nothing with the body it always had", async () => {
      const user = userEvent.setup();
      render(<GroupsPage />);

      await user.click(screen.getByRole("button", { name: "editNamed(En74)" }));
      await user.click(screen.getByRole("button", { name: "save" }));
      expect(groupWrites.update).toHaveLength(1);
      expect(groupWrites.update[0]).not.toHaveProperty("replacesSubjectId");
    });

    it("names what a group replaces in its row, and lets go of it when the group is made a class", async () => {
      groupState.groups = groups.map((group) => (group.id === "g-ma71" ? { ...group, name: "SvA7", replacesSubjectId: "s-sv" } : group));
      const user = userEvent.setup();
      render(<GroupsPage />);

      const row = screen.getAllByRole("row").find((candidate) => candidate.textContent?.includes("SvA7"))!;
      expect(row).toHaveTextContent("replacesBadge(Svenska)");
      await user.click(screen.getByRole("button", { name: "editNamed(SvA7)" }));
      await user.click(screen.getByRole("combobox", { name: "kindLabel" }));
      await user.click(screen.getByRole("option", { name: "kindClass" }));
      await user.click(screen.getByRole("button", { name: "save" }));
      expect(groupWrites.update).toEqual([expect.objectContaining({ kind: "CLASS", replacesSubjectId: null })]);
    });
  });

  it("says the school has no classes yet, with the way to add one, when there are none", () => {
    groupState.groups = [];
    render(<GroupsPage />);

    expect(screen.getByRole("heading", { name: "emptyTitle" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "addGroup" }).at(-1)).toBeEnabled();
  });

  it("says a class needs a läsår first, with the way there, when the school has none", () => {
    yearState.years = [];
    render(<GroupsPage />);

    expect(screen.getByRole("heading", { name: "noYearTitle" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "noYearAction" })).toHaveAttribute("href", "/admin/years");
    expect(screen.getByRole("button", { name: "addGroup" })).toBeDisabled();
  });

  it("does not offer to save a group's members before the stored ones are read", async () => {
    // Saving replaces the members with the ticked boxes, and before the
    // stored members arrive none is ticked: a save then would empty the group.
    membersState.data = undefined;
    membersState.isLoading = true;
    const user = userEvent.setup();
    render(<GroupsPage />);

    await user.click(screen.getByRole("button", { name: "membersTitle(Ma71)" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "membersSave(0)" })).toBeDisabled();
    expect(within(dialog).queryAllByRole("checkbox")).toHaveLength(0);
  });

  it("says the members could not be read, and keeps the save shut, when the read fails", async () => {
    membersState.data = undefined;
    membersState.isError = true;
    const user = userEvent.setup();
    render(<GroupsPage />);

    await user.click(screen.getByRole("button", { name: "membersTitle(Ma71)" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("membersLoadFailed");
    expect(within(dialog).getByRole("button", { name: "membersSave(0)" })).toBeDisabled();
  });

  it("keeps the kind filter and the search working together", async () => {
    const user = userEvent.setup();
    render(<GroupsPage />);

    await user.click(screen.getByRole("tab", { name: "kindTeachingGroup" }));
    await user.type(searchBox(), "alma");

    // Alma's home class matches her name but is filtered out by the tab.
    const names = rowNames().join(" ");
    expect(names).toContain("Ma71");
    expect(names).not.toContain("7A");
  });
});

describe("Halvklasser on Klasser", () => {
  const halves = [
    { id: "h-1", academicYearId: "year-1", name: "7A:1", kind: "TEACHING_GROUP", gradeLevel: 7, halfOfId: "g-7a" },
    { id: "h-2", academicYearId: "year-1", name: "7A:2", kind: "TEACHING_GROUP", gradeLevel: 7, halfOfId: "g-7a" },
  ];
  /** The dialogs invalidate through react-query, which the page's own mocks never reach. */
  const showPage = () =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <GroupsPage />
      </QueryClientProvider>,
    );

  beforeEach(() => {
    yearState.years = [YEAR];
    api.post.mockReset().mockResolvedValue([]);
    api.put.mockReset().mockResolvedValue({ placed: 2, unplaced: 0 });
    membershipsState.isFetching = false;
    membershipsState.isError = false;
  });

  it("splits a class from its row, with the names the school gives", async () => {
    groupState.groups = groups;
    const user = userEvent.setup();
    showPage();

    await user.click(screen.getByRole("button", { name: "halves.splitTitle(7A)" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("halfName(1)")).toHaveValue("7A:1");
    const second = within(dialog).getByLabelText("halfName(2)");
    await user.clear(second);
    await user.type(second, "Grupp B");
    await user.click(within(dialog).getByRole("button", { name: "split" }));

    expect(api.post).toHaveBeenCalledWith("/api/v1/student-groups/g-7a/halves", { names: ["7A:1", "Grupp B"] });
    // A teaching group is not split.
    expect(screen.queryByRole("button", { name: "halves.splitTitle(Ma71)" })).toBeNull();
  });

  it("names a half's class, and places the class's pupils from the half's row, sharing out the unplaced", async () => {
    groupState.groups = [...groups, ...halves];
    // Alma is in 7A:1 already; Nils is placed in no half.
    memberships.push({ studentId: "st-1", studentGroupId: "h-1" });
    const user = userEvent.setup();
    try {
      showPage();

      const halfRow = screen.getAllByRole("row").find((row) => row.textContent?.includes("7A:1"))!;
      expect(halfRow).toHaveTextContent("halves.badge(7A)");
      // A half takes its class's pupils in the class's dialog, not a member list of its own.
      expect(within(halfRow).queryByRole("button", { name: "membersTitle(7A:1)" })).toBeNull();
      // A class with halves is placed, not split again.
      expect(screen.queryByRole("button", { name: "halves.splitTitle(7A)" })).toBeNull();

      await user.click(within(halfRow).getByRole("button", { name: "halves.placeTitle(7A)" }));
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getByRole("combobox", { name: "halfFor(Alma Berg)" })).toHaveValue("h-1");
      expect(within(dialog).getByRole("combobox", { name: "halfFor(Nils Ek)" })).toHaveValue("");
      expect(dialog).toHaveTextContent("summary(1|1)");

      await user.click(within(dialog).getByRole("button", { name: "evenly" }));
      expect(within(dialog).getByRole("combobox", { name: "halfFor(Nils Ek)" })).toHaveValue("h-2");
      await user.click(within(dialog).getByRole("button", { name: "save" }));

      expect(api.put).toHaveBeenCalledWith("/api/v1/student-groups/g-7a/halves/members", {
        halves: [
          { groupId: "h-1", studentIds: ["st-1"] },
          { groupId: "h-2", studentIds: ["st-2"] },
        ],
      });
    } finally {
      memberships.pop();
    }
  });

  it("moves a pupil to the other half and leaves one in none", async () => {
    groupState.groups = [...groups, ...halves];
    memberships.push({ studentId: "st-1", studentGroupId: "h-1" }, { studentId: "st-2", studentGroupId: "h-2" });
    const user = userEvent.setup();
    try {
      showPage();

      await user.click(screen.getAllByRole("button", { name: "halves.placeTitle(7A)" })[0]!);
      const dialog = await screen.findByRole("dialog");
      await user.selectOptions(within(dialog).getByRole("combobox", { name: "halfFor(Alma Berg)" }), "h-2");
      await user.selectOptions(within(dialog).getByRole("combobox", { name: "halfFor(Nils Ek)" }), "");
      await user.click(within(dialog).getByRole("button", { name: "save" }));

      expect(api.put).toHaveBeenCalledWith("/api/v1/student-groups/g-7a/halves/members", {
        halves: [
          { groupId: "h-1", studentIds: [] },
          { groupId: "h-2", studentIds: ["st-1"] },
        ],
      });
    } finally {
      memberships.splice(-2, 2);
    }
  });
});

describe("Halvklasser: what the placement will not do", () => {
  const halves = [
    { id: "h-1", academicYearId: "year-1", name: "7A:1", kind: "TEACHING_GROUP", gradeLevel: 7, halfOfId: "g-7a" },
    { id: "h-2", academicYearId: "year-1", name: "7A:2", kind: "TEACHING_GROUP", gradeLevel: 7, halfOfId: "g-7a" },
  ];
  let client: QueryClient;
  const showPage = () =>
    render(
      <QueryClientProvider client={client}>
        <GroupsPage />
      </QueryClientProvider>,
    );

  beforeEach(() => {
    client = new QueryClient();
    yearState.years = [YEAR];
    groupState.groups = [...groups, ...halves];
    api.put.mockReset();
    membershipsState.isFetching = false;
    membershipsState.isError = false;
    membershipsState.dataUpdatedAt = Number.MAX_SAFE_INTEGER;
  });

  it("asks the pupils and the memberships again at every opening, and draws nothing from an answer older than it", async () => {
    // The page's memberships answered before this opening: another admin, a
    // file or the sync may have placed pupils since.
    membershipsState.dataUpdatedAt = 0;
    const refetch = vi.spyOn(client, "refetchQueries");
    const user = userEvent.setup();
    showPage();

    await user.click(screen.getAllByRole("button", { name: "halves.placeTitle(7A)" })[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(refetch).toHaveBeenCalledWith({ queryKey: ["people"], exact: true });
    expect(refetch).toHaveBeenCalledWith({ queryKey: ["groupMemberships"], exact: true });
    expect(within(dialog).getByRole("status")).toHaveTextContent("placeLoading");
    expect(within(dialog).queryByRole("combobox")).toBeNull();
  });

  it("offers to ask again after a failed read, rather than to close and reopen", async () => {
    membershipsState.isError = true;
    const refetch = vi.spyOn(client, "refetchQueries");
    const user = userEvent.setup();
    showPage();

    await user.click(screen.getAllByRole("button", { name: "halves.placeTitle(7A)" })[0]!);
    const dialog = await screen.findByRole("dialog");
    refetch.mockClear();
    await user.click(within(dialog).getByRole("button", { name: "retry" }));
    expect(refetch).toHaveBeenCalledWith({ queryKey: ["people"], exact: true });
    expect(refetch).toHaveBeenCalledWith({ queryKey: ["groupMemberships"], exact: true });
  });

  it("draws no placement, and offers no save, while the memberships are being asked again", async () => {
    // As right after a save: the placement it would draw is the one before it.
    membershipsState.isFetching = true;
    const user = userEvent.setup();
    showPage();

    await user.click(screen.getAllByRole("button", { name: "halves.placeTitle(7A)" })[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("status")).toHaveTextContent("placeLoading");
    expect(within(dialog).queryByRole("combobox")).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "save" })).toBeNull();
  });

  it("says a failed read instead of drawing every pupil in no half", async () => {
    membershipsState.isError = true;
    const user = userEvent.setup();
    showPage();

    await user.click(screen.getAllByRole("button", { name: "halves.placeTitle(7A)" })[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("alert")).toHaveTextContent("placeLoadFailed");
    expect(within(dialog).queryByRole("combobox")).toBeNull();
  });

  it("offers neither split nor placement on a läsår that ended before the active one began", () => {
    yearState.years = [
      { ...YEAR, startDate: "2026-08-17", endDate: "2027-06-11" },
      { id: "year-0", name: "2025/2026", isActive: false, startDate: "2025-08-18", endDate: "2026-06-12" },
    ];
    groupState.groups = [
      ...groups,
      ...halves,
      { id: "g-old-6a", academicYearId: "year-0", name: "6A", kind: "CLASS", gradeLevel: 6 },
    ];
    showPage();

    expect(screen.queryByRole("button", { name: "halves.splitTitle(6A)" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "halves.placeTitle(7A)" }).length).toBeGreaterThan(0);
  });

  it("says what goes with a split class, and what a half leaves behind, before deleting", async () => {
    const user = userEvent.setup();
    showPage();

    await user.click(screen.getByRole("button", { name: "deleteNamed(7A)" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("halves.deleteClass(7A:1, 7A:2)");
    await user.keyboard("{Escape}");

    await user.click(screen.getByRole("button", { name: "deleteNamed(7A:2)" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("halves.deleteHalf(7A)");
  });
});

describe("Läsbehörighet: the controls that write are marked with planering", () => {
  // The (app) layout's readOnlyStyle hides [data-writes~="PLANERING"] from a
  // profile that does not write it; student-groups.controller.ts @Area.
  const writes = (element: HTMLElement) => element.closest("[data-writes]")?.getAttribute("data-writes");

  beforeEach(() => {
    vi.clearAllMocks();
    yearState.years = [YEAR, NEXT_YEAR];
    groupState.groups = groups;
  });

  it("marks Lägg till, Importera and every row action, and leaves the search and the tabs to read", () => {
    render(<GroupsPage />);
    expect(screen.getByRole("button", { name: "addGroup" })).toHaveAttribute("data-writes", "PLANERING");
    expect(screen.getByRole("button", { name: "button" })).toHaveAttribute("data-writes", "PLANERING");
    for (const name of ["editNamed(7A)", "deleteNamed(7A)", "halves.splitTitle(7A)", "membersTitle(Ma71)"]) {
      expect(writes(screen.getByRole("button", { name }))).toBe("PLANERING");
    }
    expect(writes(searchBox())).toBeUndefined();
    expect(writes(screen.getByRole("tab", { name: "filterAll" }))).toBeUndefined();
  });

  it("marks the empty state's Lägg till, and leaves the way to Läsår open", () => {
    groupState.groups = [];
    const { unmount } = render(<GroupsPage />);
    for (const add of screen.getAllByRole("button", { name: "addGroup" })) {
      expect(add).toHaveAttribute("data-writes", "PLANERING");
    }
    unmount();
    yearState.years = [];
    render(<GroupsPage />);
    expect(writes(screen.getByRole("link", { name: "noYearAction" }))).toBeUndefined();
  });
});
