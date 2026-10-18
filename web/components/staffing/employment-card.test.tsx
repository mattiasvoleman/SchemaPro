import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StaffingPolicy, TeacherEmployment } from "@/lib/types";
import { EmploymentCard } from "./employment-card";

const save = vi.hoisted(() => vi.fn());
const remove = vi.hoisted(() => vi.fn());

vi.mock("@/lib/staffing-queries", () => ({
  useTeacherEmploymentActions: () => ({
    save: { mutateAsync: save, isPending: false },
    remove: { mutateAsync: remove, isPending: false },
    createPeriod: { mutateAsync: vi.fn(), isPending: false },
    updatePeriod: { mutateAsync: vi.fn(), isPending: false },
    removePeriod: { mutateAsync: vi.fn(), isPending: false },
  }),
}));
// The year's bounds, for the periods' dates (employment-periods.test.tsx tests the timeline).
vi.mock("@/lib/queries", () => ({
  useAcademicYears: () => ({ data: [{ id: "y1", startDate: "2026-08-17", endDate: "2027-06-11" }] }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The reader's own profile (Roller i skolan): undefined renders as a full administrator.
const me = vi.hoisted(() => ({ adminProfile: undefined as string | undefined }));
vi.mock("@/components/profile-context", () => ({
  useProfile: () => ({ profile: me.adminProfile === undefined ? {} : { adminProfile: me.adminProfile }, school: null }),
}));
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
  unstaffedGeneration: "ALLOW",
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
    // A post without periods says so under the summary (20261022120000).
    expect(screen.getByText("noPeriods")).toBeInTheDocument();
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
      employmentForm: null,
      firstTeacherPercent: null,
      lecturerPercent: null,
      maxTeachingDaysPerWeek: null,
    });
  });

  it("reads the undervisningsdagar back, and says nothing for a post without a limit", () => {
    const { unmount } = renderCard({ employment: { ...employment, maxTeachingDaysPerWeek: 4 } });
    expect(screen.getByText("employmentSummaryTeachingDays(4)")).toBeInTheDocument();
    unmount();

    renderCard({ employment: { ...employment, maxTeachingDaysPerWeek: null } });
    expect(screen.queryByText(/employmentSummaryTeachingDays/)).not.toBeInTheDocument();
  });

  it("sends the undervisningsdagar typed, with no limit as the empty field's meaning", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "add" }));
    expect(field("teachingDaysPerWeek").placeholder).toBe("teachingDaysNone");
    type("employmentPercent", "80");
    type("teachingDaysPerWeek", "4");
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(save.mock.calls[0]?.[0]).toMatchObject({ maxTeachingDaysPerWeek: 4 });
  });

  it("refuses a count of days outside 1–6 beside the field, and keeps the save disabled", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "add" }));
    type("employmentPercent", "80");
    type("teachingDaysPerWeek", "7");
    expect(screen.getByRole("alert")).toHaveTextContent("problem_teachingDaysOutOfRange(1|6)");
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
  });

  it("keeps the stored undervisningsdagar when the admin edits only the percentage", async () => {
    // PUT replaces the row: a body without the days would take the limit away.
    const user = userEvent.setup();
    renderCard({ employment: { ...employment, maxTeachingDaysPerWeek: 4 } });
    await user.click(screen.getByRole("button", { name: "editEmployment" }));
    expect(field("teachingDaysPerWeek").value).toBe("4");
    type("employmentPercent", "100");
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(save.mock.calls[0]?.[0]).toMatchObject({ maxTeachingDaysPerWeek: 4 });
  });

  it("sends the karriärtjänst shares typed, and says a share above the post beside the fields", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "add" }));
    type("employmentPercent", "100");
    type("firstTeacherPercent", "60");
    type("lecturerPercent", "50");
    expect(screen.getByRole("alert")).toHaveTextContent("problem_careerAbovePost(60|50)");
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
    type("lecturerPercent", "10");
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(save.mock.calls[0]?.[0]).toMatchObject({ firstTeacherPercent: 60, lecturerPercent: 10, employmentForm: null });
  });

  it("keeps a stored anställningsform and share when the admin edits only the percentage", async () => {
    const user = userEvent.setup();
    renderCard({ employment: { ...employment, employmentForm: "VISSTID", firstTeacherPercent: 20 } });
    expect(screen.getByText("employmentSummaryFormVISSTID")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "editEmployment" }));
    type("employmentPercent", "100");
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(save.mock.calls[0]?.[0]).toMatchObject({ employmentForm: "VISSTID", firstTeacherPercent: 20, lecturerPercent: null });
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

  it("removes the post by teacher and year, only once the named confirmation says so", async () => {
    // Ta bort tjänsten used to delete at once; the post's figures are gone
    // with it, so it asks first, as every other delete in the app does.
    const user = userEvent.setup();
    renderCard({ employment });
    await user.click(screen.getByRole("button", { name: "editEmployment" }));
    await user.click(screen.getByRole("button", { name: "removeEmployment" }));
    expect(remove).not.toHaveBeenCalled();

    const confirm = screen.getByRole("dialog", { name: /^removeEmploymentTitle\(Anna Ek\|/ });
    expect(within(confirm).getByText("removeEmploymentBody")).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "cancel" }));
    expect(remove).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "removeEmployment" }));
    await user.click(
      within(screen.getByRole("dialog", { name: /^removeEmploymentTitle/ })).getByRole("button", {
        name: "removeEmployment",
      }),
    );
    expect(remove).toHaveBeenCalledWith({ userId: "t-anna", academicYearId: "y1" });
  });
});

describe("EmploymentCard, Roller i skolan", () => {
  afterEach(() => {
    me.adminProfile = undefined;
  });

  it("shows a planner without HR-läs the signature and the avtal, not the percentages, and no edit", () => {
    me.adminProfile = "SCHEMALAGGARE";
    renderCard({
      employment: { ...employment, employmentPercent: null, reductionPercent: null, note: null, hrHidden: true },
    });
    expect(screen.getByText("contractFERIE")).toBeInTheDocument();
    expect(screen.getByText("employmentSummarySignature(ANN)")).toBeInTheDocument();
    expect(screen.getByText("hrHiddenNotice")).toBeInTheDocument();
    expect(screen.queryByText(/employmentSummary\(/)).not.toBeInTheDocument();
    expect(screen.queryByText(/derivedTarget/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "editEmployment" })).not.toBeInTheDocument();
  });

  it("says nothing of the undervisningsdagar to a reader the percentages are hidden from", () => {
    // The gateway nulls the days with the percentages; even a row that carried
    // them draws nothing in the hidden branch — not a figure, not "dolt", whose
    // presence on only the posts with a limit would say which they are.
    me.adminProfile = "SCHEMALAGGARE";
    renderCard({
      employment: {
        ...employment,
        employmentPercent: null,
        reductionPercent: null,
        note: null,
        hrHidden: true,
        maxTeachingDaysPerWeek: 4,
      },
    });
    expect(screen.getByText("hrHiddenNotice")).toBeInTheDocument();
    expect(screen.queryByText(/employmentSummaryTeachingDays/)).not.toBeInTheDocument();
    expect(screen.queryByText(/hrHidden$/)).not.toBeInTheDocument();
  });

  it("offers no post to add to somebody who does not decide, and says who does", () => {
    me.adminProfile = "EXPEDITION";
    renderCard();
    expect(screen.queryByRole("button", { name: "add" })).not.toBeInTheDocument();
    expect(screen.getByText(/postIsDecision/)).toBeInTheDocument();
  });

  it("lets rektor edit the post", () => {
    me.adminProfile = "REKTOR";
    renderCard({ employment });
    expect(screen.getByRole("button", { name: "editEmployment" })).toBeInTheDocument();
  });
});
