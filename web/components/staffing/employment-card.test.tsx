import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffingPolicy, TeacherEmployment } from "@/lib/types";
import { EmploymentCard } from "./employment-card";

const save = vi.hoisted(() => vi.fn());
const remove = vi.hoisted(() => vi.fn());

vi.mock("@/lib/staffing-queries", () => ({
  useTeacherEmploymentActions: () => ({
    save: { mutateAsync: save, isPending: false },
    remove: { mutateAsync: remove, isPending: false },
  }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next-intl", () => ({
  useLocale: () => "sv",
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

const teacher = { id: "t-anna", firstName: "Anna", lastName: "Ek" };
const policy: StaffingPolicy = {
  id: "p1",
  fullTimeTeachingMinutesPerWeek: 1080,
  fullTimeRegulatedHoursPerYear: 1360,
  fullTimeAnnualHours: 1767,
  workDaysPerYear: 194,
  semesterHoursPerWeek: 40,
  qualificationMode: "WARN",
  overAllocationMode: "WARN",
  overAllocationTolerancePercent: 10,
  loadModel: "MINUTES",
};
const employment: TeacherEmployment = {
  id: "e1",
  userId: "t-anna",
  academicYearId: "y1",
  employmentPercent: 80,
  reductionPercent: 20,
  contractKind: "FERIE",
  teachingTargetMinutesPerWeek: null,
  signature: "ANN",
  note: "Mentor 7B",
};

const renderCard = (props: Partial<React.ComponentProps<typeof EmploymentCard>> = {}) =>
  render(
    <EmploymentCard
      teacher={teacher}
      academicYearId="y1"
      academicYearName="2026/2027"
      employment={null}
      policy={policy}
      {...props}
    />,
  );

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const type = (label: string, value: string) =>
  fireEvent.change(field(label), { target: { value } });

describe("EmploymentCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    save.mockResolvedValue(undefined);
    remove.mockResolvedValue(undefined);
  });

  it("reads a stored post back: the derived target, the reglerad hours and the A-dagar", () => {
    renderCard({ employment });
    // 1080 × (80 − 20) / 100 = 648 → 650 on the five-minute grid.
    expect(screen.getByText("derivedTarget(650)")).toBeInTheDocument();
    // 1360 × 60 / 100 = 816 h on 194 days.
    expect(screen.getByText("derivedRegulated(816|194)")).toBeInTheDocument();
    expect(screen.getByText("employmentSummaryReduction(80|20|contractFERIE)")).toBeInTheDocument();
    expect(screen.getByText("employmentSummarySignature(ANN)")).toBeInTheDocument();
    expect(screen.getByText("Mentor 7B")).toBeInTheDocument();
  });

  it("says there is no post, and no target without a riktmärke", () => {
    renderCard({ employment: { ...employment, teachingTargetMinutesPerWeek: null }, policy: { ...policy, fullTimeTeachingMinutesPerWeek: null } });
    expect(screen.getByText("derivedNoTarget")).toBeInTheDocument();
  });

  it("spells out a missing post rather than drawing zeroes", () => {
    renderCard();
    expect(screen.getByText("noEmployment")).toBeInTheDocument();
    expect(screen.queryByLabelText("employmentPercent")).not.toBeInTheDocument();
  });

  it("refuses a nedsättning above the post, naming both numbers, and keeps the save disabled", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "add" }));
    type("employmentPercent", "80");
    type("reductionPercent", "90");
    expect(screen.getByRole("alert")).toHaveTextContent("problem_reductionAbovePercent(90|80)");
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
  });

  it("refuses a percentage outside (0, 100]", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "add" }));
    type("employmentPercent", "100.5");
    expect(screen.getByRole("alert")).toHaveTextContent("problem_percentOutOfRange(3)");
    type("employmentPercent", "0");
    expect(screen.getByRole("alert")).toHaveTextContent("problem_percentOutOfRange(3)");
  });

  it("previews the target the draft would derive to, live, and the override when given", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "add" }));
    type("employmentPercent", "60");
    type("reductionPercent", "10");
    // 1080 × 50 / 100 = 540; reglerad 1360 × 50 / 100 = 680.
    expect(screen.getByRole("status")).toHaveTextContent("derivedTarget(540) · derivedRegulated(680|194)");
    type("targetOverride", "900");
    expect(screen.getByRole("status")).toHaveTextContent("derivedTargetOverride(900)");
  });

  it("sends the whole row as numbers, blanks as null", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "add" }));
    type("employmentPercent", "66,667");
    type("signature", " ANN ");
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(save).toHaveBeenCalledWith({
      userId: "t-anna",
      academicYearId: "y1",
      employmentPercent: 66.667,
      reductionPercent: 0,
      contractKind: "FERIE",
      teachingTargetMinutesPerWeek: null,
      signature: "ANN",
      note: null,
    });
  });

  it("keeps the stored note when the admin edits only the percentage", async () => {
    // PUT replaces the row, so a body built from the touched fields alone
    // would clear the note on every save.
    const user = userEvent.setup();
    renderCard({ employment });
    await user.click(screen.getByRole("button", { name: "editEmployment" }));
    type("employmentPercent", "100");
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(save.mock.calls[0]?.[0]).toMatchObject({ note: "Mentor 7B", signature: "ANN", reductionPercent: 20 });
  });

  it("removes the post by teacher and year", async () => {
    const user = userEvent.setup();
    renderCard({ employment });
    await user.click(screen.getByRole("button", { name: "editEmployment" }));
    await user.click(screen.getByRole("button", { name: "removeEmployment" }));
    expect(remove).toHaveBeenCalledWith({ userId: "t-anna", academicYearId: "y1" });
  });
});
