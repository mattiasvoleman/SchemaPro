import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScopeAssessmentCard } from "./scope-assessment-card";

const save = vi.hoisted(() => vi.fn());
vi.mock("@/lib/scope-assessment-queries", () => ({
  useScopeAssessmentActions: () => ({
    save: { mutateAsync: save, isPending: false },
    remove: { mutateAsync: vi.fn(), isPending: false },
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/profile-context", () => ({ useProfile: () => ({ profile: {}, school: null }) }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key}(${Object.values(values).join("|")})` : key),
}));

const teacher = { id: "t-anna", firstName: "Anna", lastName: "Ek" };
const stored = { levelHours: 600, exceptionKind: "OWN_INITIATIVE" as const, ownInitiativeOn: "2027-05-02", note: null, decidedAt: null };

const pick = async (user: ReturnType<typeof userEvent.setup>, option: string) => {
  await user.click(screen.getByRole("combobox", { name: "exceptionLabel" }));
  await user.click(screen.getByRole("option", { name: option }));
};

/*
 * The day is the exception on the teacher's own initiative's and its field is drawn for no other kind. A day that stayed in the draft when
 * the kind changed was refused by the form (dayNeedsInitiative) with no field to clear it in, and Save stayed disabled.
 */
describe("ScopeAssessmentCard: changing the kind of exception", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    save.mockResolvedValue(undefined);
  });

  it("can change a stored exception on the teacher's own initiative to a small group, and the day goes with the old kind", async () => {
    const user = userEvent.setup();
    render(<ScopeAssessmentCard teacher={teacher} academicYearId="y1" assessment={stored} fullTimeHighestHours={650} />);
    await user.click(screen.getByRole("button", { name: "edit" }));
    await pick(user, "exceptionOptionSMALL_GROUP");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "save" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(save).toHaveBeenCalledWith({ userId: "t-anna", academicYearId: "y1", teachingLevelHours: 600, exceptionKind: "SMALL_GROUP", ownInitiativeOn: null, note: null });
  });

  it("can take the exception away after a day was typed for it, keeping the level", async () => {
    const user = userEvent.setup();
    render(<ScopeAssessmentCard teacher={teacher} academicYearId="y1" assessment={undefined} fullTimeHighestHours={650} />);
    await user.click(screen.getByRole("button", { name: "add" }));
    fireEvent.change(screen.getByLabelText("level"), { target: { value: "580" } });
    await pick(user, "exceptionOptionOWN_INITIATIVE");
    fireEvent.change(screen.getByLabelText("day"), { target: { value: "2027-05-02" } });
    await pick(user, "exceptionNone");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(save).toHaveBeenCalledWith({ userId: "t-anna", academicYearId: "y1", teachingLevelHours: 580, exceptionKind: null, ownInitiativeOn: null, note: null });
  });

  it("still asks for the day when the kind is changed back to the teacher's own initiative", async () => {
    const user = userEvent.setup();
    render(<ScopeAssessmentCard teacher={teacher} academicYearId="y1" assessment={stored} fullTimeHighestHours={650} />);
    await user.click(screen.getByRole("button", { name: "edit" }));
    await pick(user, "exceptionOptionSMALL_GROUP");
    await pick(user, "exceptionOptionOWN_INITIATIVE");
    expect(screen.getByRole("alert")).toHaveTextContent("problems.initiativeNeedsDay");
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
  });
});
