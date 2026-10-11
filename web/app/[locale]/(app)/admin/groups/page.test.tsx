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
/** The school's läsår; a test empties it for a school that has none yet. */
const yearState = vi.hoisted(() => ({ years: [] as unknown[] }));
/** The school's groups; a test empties it for a school that has none yet. */
const groupState = vi.hoisted(() => ({ groups: [] as unknown[] }));
/** The members dialog's read of a group's stored members. */
const membersState = vi.hoisted(() => ({
  data: [] as unknown[] | undefined,
  isLoading: false,
  isError: false,
}));

vi.mock("@/lib/queries", () => ({
  useAcademicYears: () => ({ data: yearState.years }),
  useGroups: () => ({ data: groupState.groups, isLoading: false }),
  usePeople: () => ({ data: people }),
  useGroupMemberships: () => ({ data: memberships }),
  useGroupMembers: () => membersState,
  useSetGroupMembers: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCrudMutations: (path: string, keys: string[][]) => {
    crudKeys.set(path, keys);
    return {
      create: { mutateAsync: vi.fn(), isPending: false },
      update: { mutateAsync: vi.fn(), isPending: false },
      remove: { mutateAsync: vi.fn(), isPending: false },
    };
  },
}));

vi.mock("@/components/import/csv-import-dialog", () => ({
  CsvImportDialog: () => null,
}));

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
    yearState.years = [YEAR, NEXT_YEAR];
    groupState.groups = groups;
    membersState.data = [];
    membersState.isLoading = false;
    membersState.isError = false;
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
