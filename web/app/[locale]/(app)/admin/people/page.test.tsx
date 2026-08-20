import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PeoplePage from "./page";

/**
 * Mounts the real page, for the same reason as the groups page test: the
 * filtering rules are covered in lib, but only rendering catches a render-time
 * crash — a `const` referenced from a useMemo above its own declaration throws
 * and TypeScript does not see it across the callback.
 */

const groups = [
  { id: "g-7a", academicYearId: "year-1", name: "7A", kind: "CLASS", gradeLevel: 7 },
  { id: "g-7b", academicYearId: "year-1", name: "7B", kind: "CLASS", gradeLevel: 7 },
  {
    id: "g-ma71",
    academicYearId: "year-1",
    name: "Ma71",
    kind: "TEACHING_GROUP",
    gradeLevel: null,
  },
];

const person = (
  id: string,
  firstName: string,
  lastName: string,
  role: string,
  studentGroupId: string | null,
  invitedAt: string | null = null,
) => ({
  id,
  role,
  firstName,
  lastName,
  email: `${firstName.toLowerCase()}@skolan.se`,
  phone: null,
  isActive: true,
  invitedAt,
  studentGroupId,
});

const people = [
  person("st-1", "Alma", "Berg", "STUDENT", "g-7a"),
  person("st-2", "Nils", "Ek", "STUDENT", "g-7b"),
  person("t-1", "Karin", "Ek", "TEACHER", null, "2026-08-01T10:00:00.000Z"),
];

/** Alma takes Ma71 on top of her home class; Nils takes nothing extra. */
const memberships = [{ studentId: "st-1", studentGroupId: "g-ma71" }];

const requirements = [
  {
    id: "req-1",
    academicYearId: "year-1",
    subjectId: "sub-ma",
    studentGroupId: "g-ma71",
    teacherId: "t-1",
    coTeacherId: null,
    lessonsPerWeek: 3,
    minutesPerLesson: 60,
  },
];

vi.mock("@/lib/queries", () => ({
  usePeople: () => ({ data: people, isLoading: false }),
  useGroups: () => ({ data: groups }),
  useGroupMemberships: () => ({ data: memberships }),
  useAcademicYears: () => ({ data: [{ id: "year-1", name: "2026/2027", isActive: true }] }),
  useRequirements: () => ({ data: requirements }),
  useSubjects: () => ({ data: [{ id: "sub-ma", name: "Matematik", code: "MA", color: "#123456", requiredRoomTypeId: null }] }),
  useStudentGuardians: () => ({ data: [] }),
  useGuardianLinkActions: () => ({
    create: { mutateAsync: vi.fn(), isPending: false },
    remove: { mutateAsync: vi.fn(), isPending: false },
  }),
  useInvitations: () => ({
    inviteOne: { mutateAsync: vi.fn(), isPending: false },
    inviteMany: { mutateAsync: vi.fn(), isPending: false },
  }),
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

vi.mock("next-intl", () => ({
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

const searchBox = () => screen.getByRole("textbox", { name: "searchPlaceholder" });

describe("People page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders without crashing and lists everybody", () => {
    render(<PeoplePage />);

    expect(rowNames()).toHaveLength(3);
  });

  it("searches by name", async () => {
    const user = userEvent.setup();
    render(<PeoplePage />);

    await user.type(searchBox(), "alma");

    expect(rowNames()).toEqual(["Alma Berg"]);
  });

  it("searches by email", async () => {
    const user = userEvent.setup();
    render(<PeoplePage />);

    await user.type(searchBox(), "nils@skolan");

    expect(rowNames()).toEqual(["Nils Ek"]);
  });

  it("searches by class, so a whole class can be pulled up at once", async () => {
    const user = userEvent.setup();
    render(<PeoplePage />);

    await user.type(searchBox(), "7b");

    expect(rowNames()).toEqual(["Nils Ek"]);
  });

  it("combines terms across fields in any order", async () => {
    const user = userEvent.setup();
    render(<PeoplePage />);

    await user.type(searchBox(), "7a alma");

    expect(rowNames()).toEqual(["Alma Berg"]);
  });

  it("scopes the bulk invitation to what the search leaves on screen", async () => {
    // Deliberate: search a class, invite that class. The count in the label
    // has to follow the same list, or the button would lie about its reach.
    const user = userEvent.setup();
    render(<PeoplePage />);

    // Two of the three have never been invited; Karin has.
    expect(screen.getByText("inviteAll(2)")).toBeInTheDocument();

    await user.type(searchBox(), "alma");
    expect(screen.getByText("inviteAll(1)")).toBeInTheDocument();
  });
  describe("clicking a person's name", () => {
    const nameButton = (name: string) =>
      screen.getByRole("button", { name: new RegExp(name) });

    it("reveals nothing until the name is clicked", () => {
      render(<PeoplePage />);

      expect(screen.queryByText("teachingGroupsLabel")).not.toBeInTheDocument();
    });

    it("shows a student's home class and teaching groups", async () => {
      const user = userEvent.setup();
      render(<PeoplePage />);

      await user.click(nameButton("Alma Berg"));

      // Scoped to the panel the button says it controls: "7A" also appears in
      // her class column, so an unscoped query would pass without the panel.
      const detail = document.getElementById("person-detail-st-1");
      expect(detail).not.toBeNull();
      expect(within(detail!).getByText("homeClassLabel")).toBeInTheDocument();
      expect(within(detail!).getByText("7A")).toBeInTheDocument();
      expect(within(detail!).getByText("Ma71")).toBeInTheDocument();
    });

    it("says plainly when a student is in no teaching group", async () => {
      const user = userEvent.setup();
      render(<PeoplePage />);

      await user.click(nameButton("Nils Ek"));

      expect(screen.getByText("noTeachingGroups")).toBeInTheDocument();
    });

    it("shows what a teacher teaches instead — the same question, staff side", async () => {
      const user = userEvent.setup();
      render(<PeoplePage />);

      await user.click(nameButton("Karin Ek"));

      expect(screen.getByText("teachesLabel")).toBeInTheDocument();
      expect(screen.getByText(/Ma71 · Matematik/)).toBeInTheDocument();
    });

    it("closes again on a second click", async () => {
      const user = userEvent.setup();
      render(<PeoplePage />);

      await user.click(nameButton("Alma Berg"));
      expect(screen.getByText("teachingGroupsLabel")).toBeInTheDocument();

      await user.click(nameButton("Alma Berg"));
      expect(screen.queryByText("teachingGroupsLabel")).not.toBeInTheDocument();
    });

    it("keeps only one row open at a time", async () => {
      const user = userEvent.setup();
      render(<PeoplePage />);

      await user.click(nameButton("Alma Berg"));
      await user.click(nameButton("Nils Ek"));

      // Alma's groups are gone; Nils's empty-state line is what shows now.
      expect(screen.queryByText("Ma71")).not.toBeInTheDocument();
      expect(screen.getByText("noTeachingGroups")).toBeInTheDocument();
    });

    it("marks the control as expanded for screen readers", async () => {
      const user = userEvent.setup();
      render(<PeoplePage />);

      const button = nameButton("Alma Berg");
      expect(button).toHaveAttribute("aria-expanded", "false");

      await user.click(button);
      expect(nameButton("Alma Berg")).toHaveAttribute("aria-expanded", "true");
    });
  });
});
