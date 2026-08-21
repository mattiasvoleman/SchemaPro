import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ConstraintsPage from "./page";

/**
 * Locking a time to a year group.
 *
 * A year range is the one constraint target that is not a row in any table, so
 * the form has to swap the resource picker for two year selects and send bounds
 * instead of an id. Getting that wrong produces a rule the API rejects, or
 * worse, one it accepts that points at nothing.
 */

const create = vi.hoisted(() => vi.fn());
const constraints = vi.hoisted(() => ({ data: [] as unknown[], isLoading: false }));

vi.mock("@/lib/queries", () => ({
  useConstraints: () => constraints,
  usePeople: () => ({
    data: [
      {
        id: "u-1",
        role: "TEACHER",
        firstName: "Karin",
        lastName: "Ek",
        isActive: true,
      },
    ],
  }),
  useRooms: () => ({ data: [{ id: "r-1", name: "A12" }] }),
  useGroups: () => ({ data: [{ id: "g-7a", name: "7A" }] }),
  useCrudMutations: () => ({
    create: { mutateAsync: create, isPending: false },
    update: { mutateAsync: vi.fn(), isPending: false },
    remove: { mutateAsync: vi.fn(), isPending: false },
  }),
}));

// The two cards below the table have their own tests; they would otherwise drag
// their whole query surface into this one.
vi.mock("@/components/schedule/lunch-settings-card", () => ({
  LunchSettingsCard: () => null,
}));
vi.mock("@/components/schedule/room-preferences-card", () => ({
  RoomPreferencesCard: () => null,
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock("next-intl", () => ({
  useTranslations: () => {
    const t = (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${Object.values(values).join("|")})` : key;
    return t;
  },
}));

const pick = async (
  user: ReturnType<typeof userEvent.setup>,
  trigger: string,
  option: string,
) => {
  await user.click(screen.getByRole("combobox", { name: trigger }));
  await user.click(await screen.findByRole("option", { name: option }));
};

const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole("button", { name: "addConstraint" }));
  await pick(user, "resource", "resourceGrade");
};

describe("Constraints page — year-range locks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    constraints.data = [];
  });

  it("swaps the resource picker for two year selects", async () => {
    const user = userEvent.setup();
    render(<ConstraintsPage />);

    await openDialog(user);

    expect(screen.getByRole("combobox", { name: "gradeFromLabel" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "gradeToLabel" })).toBeTruthy();
    // There is nothing to pick from: no row anywhere is "årskurs 5".
    expect(screen.queryByRole("combobox", { name: "name" })).toBeNull();
  });

  it("sends the bounds and no resource id", async () => {
    const user = userEvent.setup();
    render(<ConstraintsPage />);

    await openDialog(user);
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        resourceType: "GRADE_LEVEL",
        minGradeLevel: 4,
        maxGradeLevel: 6,
        userId: null,
        roomId: null,
        studentGroupId: null,
      }),
    );
  });

  it("drags the upper bound along when the lower one passes it", async () => {
    // A range that reads backwards was never what anybody meant, and the API
    // would reject it after the fact. Keeping the pair ordered as it is typed
    // is the difference between a form that helps and one that scolds.
    const user = userEvent.setup();
    render(<ConstraintsPage />);

    await openDialog(user);
    await pick(user, "gradeFromLabel", "grade(9)");
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      minGradeLevel: 9,
      maxGradeLevel: 9,
    });
  });

  it("drags the lower bound along when the upper one falls below it", async () => {
    const user = userEvent.setup();
    render(<ConstraintsPage />);

    await openDialog(user);
    await pick(user, "gradeToLabel", "grade(1)");
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      minGradeLevel: 1,
      maxGradeLevel: 1,
    });
  });

  it("sends no year bounds on a rule aimed at a teacher", async () => {
    // The API refuses a year bound on any other kind, and rightly: a rule
    // carrying both a teacher and a year range says two different things.
    const user = userEvent.setup();
    render(<ConstraintsPage />);

    await user.click(screen.getByRole("button", { name: "addConstraint" }));
    await pick(user, "name", "Karin Ek");
    await user.click(screen.getByRole("button", { name: "save" }));

    expect(create.mock.calls[0]?.[0]).toMatchObject({
      resourceType: "TEACHER",
      minGradeLevel: null,
      maxGradeLevel: null,
    });
  });

  it("names the year span in the list instead of a dash", async () => {
    constraints.data = [
      {
        id: "c-1",
        resourceType: "GRADE_LEVEL",
        userId: null,
        roomId: null,
        studentGroupId: null,
        minGradeLevel: 4,
        maxGradeLevel: 6,
        dayOfWeek: 3,
        date: null,
        startTime: "11:30:00",
        endTime: "12:00:00",
        type: "UNAVAILABLE",
        reason: "Lunch",
      },
    ];
    render(<ConstraintsPage />);

    expect(within(screen.getByRole("table")).getByText("gradeRange(4|6)")).toBeTruthy();
  });
});
