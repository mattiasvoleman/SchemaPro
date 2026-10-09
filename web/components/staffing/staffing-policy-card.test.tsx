import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StaffingPolicyCard } from "./staffing-policy-card";

const save = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({ data: null as unknown, isSuccess: true }));

vi.mock("@/lib/staffing-queries", () => ({
  useStaffingPolicy: () => state,
  useSaveStaffingPolicy: () => ({ mutateAsync: save, isPending: false }),
}));
vi.mock("./subject-factors-table", () => ({
  SubjectFactorsTable: () => <div data-testid="subject-factors" />,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}(${Object.values(values).join("|")})` : key,
}));

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;

describe("StaffingPolicyCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.data = null;
    state.isSuccess = true;
    save.mockResolvedValue(undefined);
  });

  it("starts from the table's defaults with an empty riktmärke", async () => {
    render(<StaffingPolicyCard />);
    await waitFor(() => expect(field("regulatedHours").value).toBe("1360"));
    expect(field("riktmarke").value).toBe("");
    expect(field("riktmarke").placeholder).toBe("riktmarkeEmpty");
    expect(field("annualHours").value).toBe("1767");
    expect(field("workDays").value).toBe("194");
    expect(field("semesterHours").value).toBe("40");
    expect(field("tolerance").value).toBe("10");
    expect(screen.getByText("riktmarkeSource")).toBeInTheDocument();
  });

  it("fills the form from the school's saved row", async () => {
    state.data = {
      id: "p1",
      fullTimeTeachingMinutesPerWeek: 1080,
      fullTimeRegulatedHoursPerYear: 1300,
      fullTimeAnnualHours: 1767,
      workDaysPerYear: 190,
      semesterHoursPerWeek: 37.5,
      qualificationMode: "REFUSE",
      overAllocationMode: "WARN",
      overAllocationTolerancePercent: 5,
      loadModel: "MINUTES",
    };
    render(<StaffingPolicyCard />);
    await waitFor(() => expect(field("riktmarke").value).toBe("1080"));
    expect(field("regulatedHours").value).toBe("1300");
    expect(field("semesterHours").value).toBe("37.5");
    expect(screen.getByText("refuseHint")).toBeInTheDocument();
  });

  it("fills 1 080 on the suggestion button, never by default", async () => {
    const user = userEvent.setup();
    render(<StaffingPolicyCard />);
    await waitFor(() => expect(field("riktmarke").value).toBe(""));
    await user.click(screen.getByRole("button", { name: "riktmarkeSuggest" }));
    expect(field("riktmarke").value).toBe("1080");
  });

  it("refuses reglerad arbetstid above the annual hours, naming both", async () => {
    render(<StaffingPolicyCard />);
    await waitFor(() => expect(field("regulatedHours").value).toBe("1360"));
    fireEvent.change(field("regulatedHours"), { target: { value: "1800" } });
    expect(screen.getByRole("alert")).toHaveTextContent("problem_regulatedAboveAnnual(1800|1767)");
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
  });

  it("sends numbers, and an empty riktmärke as null", async () => {
    const user = userEvent.setup();
    render(<StaffingPolicyCard />);
    await waitFor(() => expect(field("regulatedHours").value).toBe("1360"));
    fireEvent.change(field("tolerance"), { target: { value: "15" } });
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(save).toHaveBeenCalledWith({
      fullTimeTeachingMinutesPerWeek: null,
      fullTimeRegulatedHoursPerYear: 1360,
      fullTimeAnnualHours: 1767,
      workDaysPerYear: 194,
      semesterHoursPerWeek: 40,
      qualificationMode: "WARN",
      overAllocationMode: "WARN",
      overAllocationTolerancePercent: 15,
      loadModel: "MINUTES",
      unstaffedGeneration: "ALLOW",
      shareEmploymentWithIntegrations: false,
    });
  });

  it("keeps the integration switch on a save and sends a flip", async () => {
    const user = userEvent.setup();
    state.data = {
      id: "p1",
      fullTimeTeachingMinutesPerWeek: null,
      fullTimeRegulatedHoursPerYear: 1360,
      fullTimeAnnualHours: 1767,
      workDaysPerYear: 194,
      semesterHoursPerWeek: 40,
      qualificationMode: "WARN",
      overAllocationMode: "WARN",
      overAllocationTolerancePercent: 10,
      loadModel: "MINUTES",
      unstaffedGeneration: "ALLOW",
      shareEmploymentWithIntegrations: true,
    };
    render(<StaffingPolicyCard />);
    const share = await screen.findByRole("switch", { name: "shareWithIntegrations" });
    await waitFor(() => expect(share).toHaveAttribute("aria-checked", "true"));
    expect(screen.getByText("shareWithIntegrationsHint")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({ shareEmploymentWithIntegrations: true }),
    );
    await user.click(share);
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({ shareEmploymentWithIntegrations: false }),
    );
  });

  it("explains the Faktor model and offers the factor table only under FACTOR", async () => {
    const user = userEvent.setup();
    render(<StaffingPolicyCard />);
    await waitFor(() => expect(field("regulatedHours").value).toBe("1360"));
    expect(screen.getByText("modelHint")).toBeInTheDocument();
    expect(screen.queryByTestId("subject-factors")).not.toBeInTheDocument();
    await user.click(screen.getByRole("combobox", { name: "loadModel" }));
    await user.click(screen.getByRole("option", { name: "modelFACTOR" }));
    expect(await screen.findByTestId("subject-factors")).toBeInTheDocument();
  });

  it("reads the school's generation refusal and sends the choice back on every save", async () => {
    const user = userEvent.setup();
    state.data = {
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
      unstaffedGeneration: "REFUSE",
    };
    render(<StaffingPolicyCard />);
    await waitFor(() => expect(field("riktmarke").value).toBe("1080"));
    const generation = screen.getByRole("combobox", { name: "unstaffedGeneration" });
    expect(generation).toHaveTextContent("generationREFUSE");
    expect(screen.getByText("unstaffedGenerationHint")).toBeInTheDocument();

    // Saving something else keeps the refusal: PUT replaces the row whole.
    fireEvent.change(field("tolerance"), { target: { value: "12" } });
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(save).toHaveBeenLastCalledWith(
      expect.objectContaining({ overAllocationTolerancePercent: 12, unstaffedGeneration: "REFUSE" }),
    );

    await user.click(generation);
    await user.click(screen.getByRole("option", { name: "generationALLOW" }));
    await user.click(screen.getByRole("button", { name: "save" }));
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ unstaffedGeneration: "ALLOW" }));
  });
});
