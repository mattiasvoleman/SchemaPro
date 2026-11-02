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
      maxConsecutiveTeachingMinutes: null,
      consecutiveBreakMinutes: null,
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

  it("reads the limit on teaching in a row back, and says nothing for a post without one or with half of one", () => {
    // Sammanhängande undervisning sits on the post beside the days (HR).
    const { unmount } = renderCard({
      employment: { ...employment, maxConsecutiveTeachingMinutes: 240, consecutiveBreakMinutes: 30 },
    });
    expect(screen.getByText("employmentSummaryConsecutive(240|30)")).toBeInTheDocument();
    unmount();

    const { unmount: unmountNone } = renderCard({
      employment: { ...employment, maxConsecutiveTeachingMinutes: null, consecutiveBreakMinutes: null },
    });
    expect(screen.queryByText(/employmentSummaryConsecutive/)).not.toBeInTheDocument();
    unmountNone();

    // A half pair is a row the gateway refuses; a line with one number in it
    // would say a limit that does not exist.
    renderCard({ employment: { ...employment, maxConsecutiveTeachingMinutes: 240, consecutiveBreakMinutes: null } });
    expect(screen.queryByText(/employmentSummaryConsecutive/)).not.toBeInTheDocument();
  });

  it("offers the pair empty, as no limit, beside the days, and with its hint tied to both fields", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "add" }));
    for (const label of ["consecutiveMax", "consecutiveBreak"]) {
      expect(field(label).value).toBe("");
      expect(field(label).placeholder).toBe("teachingDaysNone");
      expect(field(label).step).toBe("5");
      expect(field(label).getAttribute("aria-describedby")).toBe("emp-stretch-hint-t-anna");
    }
    expect(field("consecutiveMax").min).toBe("30");
    expect(field("consecutiveMax").max).toBe("480");
    expect(field("consecutiveBreak").min).toBe("5");
    expect(field("consecutiveBreak").max).toBe("120");
    expect(document.getElementById("emp-stretch-hint-t-anna")).toHaveTextContent("consecutiveHint");
    expect(document.getElementById("emp-stretch-hint-t-anna")).toHaveTextContent("consecutiveRule");
  });

  it("sends the pair typed, as two numbers", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "add" }));
    type("employmentPercent", "80");
    type("consecutiveMax", "180");
    type("consecutiveBreak", "20");
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(save.mock.calls[0]?.[0]).toMatchObject({
      maxConsecutiveTeachingMinutes: 180,
      consecutiveBreakMinutes: 20,
    });
  });

  it("reads each figure back as hours and minutes beside its field, as soon as that figure is sayable", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "add" }));
    type("employmentPercent", "80");
    // The break is not typed yet; the maximum is already said.
    type("consecutiveMax", "150");
    expect(screen.getByText("consecutiveSaid(2|30)")).toBeInTheDocument();
    type("consecutiveBreak", "20");
    expect(screen.getByText("consecutiveSaid(0|20)")).toBeInTheDocument();
    type("consecutiveMax", "180");
    expect(screen.getByText("consecutiveSaid(3|0)")).toBeInTheDocument();
    // Nothing for a figure the form would refuse: a wrong readout is worse than none.
    type("consecutiveMax", "17");
    expect(screen.queryByText(/consecutiveSaid\(0\|17\)/)).not.toBeInTheDocument();
    expect(screen.queryByText(/consecutiveSaid\(3/)).not.toBeInTheDocument();
  });

  it("refuses one half of the pair beside the fields, in the form's own sentence, and keeps the save disabled", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "add" }));
    type("employmentPercent", "80");
    type("consecutiveMax", "180");
    expect(screen.getByRole("alert")).toHaveTextContent("problem_consecutivePairIncomplete");
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
    type("consecutiveBreak", "20");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "save" })).toBeEnabled();
  });

  it("refuses figures outside the ranges or off the five-minute grid, naming them", async () => {
    const user = userEvent.setup();
    renderCard();
    await user.click(screen.getByRole("button", { name: "add" }));
    type("employmentPercent", "80");
    type("consecutiveBreak", "20");
    type("consecutiveMax", "3000");
    expect(screen.getByRole("alert")).toHaveTextContent("problem_consecutiveMaxOutOfRange(30|480)");
    type("consecutiveMax", "182");
    expect(screen.getByRole("alert")).toHaveTextContent("problem_consecutiveMaxOffGrid(5)");
    type("consecutiveMax", "180");
    type("consecutiveBreak", "130");
    expect(screen.getByRole("alert")).toHaveTextContent("problem_consecutiveBreakOutOfRange(5|120)");
    type("consecutiveBreak", "17");
    expect(screen.getByRole("alert")).toHaveTextContent("problem_consecutiveBreakOffGrid(5)");
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
  });

  it("keeps the stored pair when the admin edits only the percentage, and takes it away with two nulls", async () => {
    // PUT keeps a key a body leaves out: the pair is named in every save.
    const user = userEvent.setup();
    renderCard({ employment: { ...employment, maxConsecutiveTeachingMinutes: 240, consecutiveBreakMinutes: 30 } });
    await user.click(screen.getByRole("button", { name: "editEmployment" }));
    expect(field("consecutiveMax").value).toBe("240");
    expect(field("consecutiveBreak").value).toBe("30");
    type("employmentPercent", "100");
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(save.mock.calls[0]?.[0]).toMatchObject({ maxConsecutiveTeachingMinutes: 240, consecutiveBreakMinutes: 30 });

    // The card closes on a save; the stored post is the prop, so Ändra opens it as it was.
    await user.click(screen.getByRole("button", { name: "editEmployment" }));
    type("consecutiveMax", "");
    type("consecutiveBreak", "");
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(save.mock.calls[1]?.[0]).toMatchObject({ maxConsecutiveTeachingMinutes: null, consecutiveBreakMinutes: null });
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

  it("says nothing of the limit on teaching in a row to a reader the percentages are hidden from", () => {
    // HR like the days: the gateway nulls both figures with the percentages
    // and sets hrHidden. Even a row that carried them (it never should) draws
    // nothing in the hidden branch — not a figure, not "dolt", and no field.
    me.adminProfile = "SCHEMALAGGARE";
    renderCard({
      employment: {
        ...employment,
        employmentPercent: null,
        reductionPercent: null,
        note: null,
        hrHidden: true,
        maxConsecutiveTeachingMinutes: 240,
        consecutiveBreakMinutes: 30,
      },
    });
    expect(screen.getByText("hrHiddenNotice")).toBeInTheDocument();
    expect(screen.queryByText(/employmentSummaryConsecutive/)).not.toBeInTheDocument();
    expect(screen.queryByText(/240|30\b/)).not.toBeInTheDocument();
    // And no way into a form that has the fields: a planner decides nothing.
    expect(screen.queryByRole("button", { name: "editEmployment" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("consecutiveMax")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("consecutiveBreak")).not.toBeInTheDocument();
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
