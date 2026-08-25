import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

vi.mock("@/lib/queries", () => ({
  useAcademicYears: () => ({ data: [YEAR] }),
  useGroups: () => ({ data: groups, isLoading: false }),
  usePeople: () => ({ data: people }),
  useGroupMemberships: () => ({ data: memberships }),
  useGroupMembers: () => ({ data: [] }),
  useSetGroupMembers: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCrudMutations: () => ({
    create: { mutateAsync: vi.fn(), isPending: false },
    update: { mutateAsync: vi.fn(), isPending: false },
    remove: { mutateAsync: vi.fn(), isPending: false },
  }),
}));

vi.mock("@/components/import/csv-import-dialog", () => ({
  CsvImportDialog: () => null,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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

const rowNames = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => within(row).getAllByRole("cell")[0]?.textContent ?? "");

describe("Groups page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    await user.type(screen.getByRole("textbox", { name: "searchPlaceholder" }), "ma71");

    expect(rowNames().join(" ")).toContain("Ma71");
    expect(rowNames().join(" ")).not.toContain("En74");
  });

  it("finds the teaching group a student belongs to, by the student's name", async () => {
    // The question an admin actually has: "which group is Alma in?" Her home
    // class and her teaching group must both come back, and Nils's group
    // must not.
    const user = userEvent.setup();
    render(<GroupsPage />);

    await user.type(screen.getByRole("textbox", { name: "searchPlaceholder" }), "alma");

    const names = rowNames().join(" ");
    expect(names).toContain("7A");
    expect(names).toContain("Ma71");
    expect(names).not.toContain("En74");
  });

  it("names the matching student under the group, not just the group", async () => {
    const user = userEvent.setup();
    render(<GroupsPage />);

    await user.type(screen.getByRole("textbox", { name: "searchPlaceholder" }), "alma");

    expect(rowNames().join(" ")).toContain("Alma Berg");
  });

  it("says so when nothing matches", async () => {
    const user = userEvent.setup();
    render(<GroupsPage />);

    await user.type(
      screen.getByRole("textbox", { name: "searchPlaceholder" }),
      "finns inte",
    );

    expect(screen.getByText("noResults")).toBeInTheDocument();
  });

  it("keeps the kind filter and the search working together", async () => {
    const user = userEvent.setup();
    render(<GroupsPage />);

    await user.click(screen.getByRole("tab", { name: "kindTeachingGroup" }));
    await user.type(screen.getByRole("textbox", { name: "searchPlaceholder" }), "alma");

    // Alma's home class matches her name but is filtered out by the tab.
    const names = rowNames().join(" ");
    expect(names).toContain("Ma71");
    expect(names).not.toContain("7A");
  });
});
