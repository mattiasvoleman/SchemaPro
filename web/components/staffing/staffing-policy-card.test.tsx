import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StaffingPolicyCard } from "./staffing-policy-card";

const save = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({ data: null as unknown, isSuccess: true }));

vi.mock("@/lib/queries", () => ({
  useStaffingPolicy: () => state,
  useSaveStaffingPolicy: () => ({ mutateAsync: save, isPending: false }),
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
    });
  });
});
