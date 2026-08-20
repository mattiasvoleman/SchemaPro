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

vi.mock("@/lib/queries", () => ({
  usePeople: () => ({ data: people, isLoading: false }),
  useGroups: () => ({ data: groups }),
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
});
