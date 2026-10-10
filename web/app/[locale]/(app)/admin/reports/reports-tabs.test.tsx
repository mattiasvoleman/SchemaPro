import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReportsTabs, reportTabOf } from "./reports-tabs";

Element.prototype.hasPointerCapture ??= () => false;

vi.mock("./attendance-report", () => ({ AttendanceReport: () => <p>attendance-report</p> }));
vi.mock("./staffing-report", () => ({ StaffingReport: () => <p>staffing-report</p> }));
vi.mock("./cover-hours-report", () => ({ CoverHoursReport: () => <p>cover-hours-report</p> }));
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

describe("the reports tabs", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/sv/admin/reports");
  });

  it("opens on Närvaro, the page as it was, and loads nothing of the staffing tab", () => {
    render(<ReportsTabs initialTab="attendance" />);
    expect(screen.getByRole("tab", { name: "attendance" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("attendance-report")).toBeInTheDocument();
    expect(screen.queryByText("staffing-report")).not.toBeInTheDocument();
  });

  it("remembers Tjänstefördelning in the URL without navigating, and forgets it on Närvaro", async () => {
    const user = userEvent.setup();
    render(<ReportsTabs initialTab="attendance" />);
    await user.click(screen.getByRole("tab", { name: "staffing" }));
    expect(await screen.findByText("staffing-report")).toBeInTheDocument();
    expect(window.location.search).toBe("?tab=staffing");
    await user.click(screen.getByRole("tab", { name: "attendance" }));
    expect(window.location.search).toBe("");
  });

  it("opens on the tab the URL named", async () => {
    render(<ReportsTabs initialTab="staffing" />);
    expect(await screen.findByText("staffing-report")).toBeInTheDocument();
  });

  it("keeps Vikarietimmar in the URL, and loads it only when chosen", async () => {
    const user = userEvent.setup();
    render(<ReportsTabs initialTab="attendance" />);
    expect(screen.queryByText("cover-hours-report")).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "cover" }));
    expect(await screen.findByText("cover-hours-report")).toBeInTheDocument();
    expect(window.location.search).toBe("?tab=cover");
  });

  it("reads ?tab= as one of the three tabs, anything else as Närvaro", () => {
    expect(reportTabOf("cover")).toBe("cover");
    expect(reportTabOf("staffing")).toBe("staffing");
    expect(reportTabOf("vikarie")).toBe("attendance");
    expect(reportTabOf(undefined)).toBe("attendance");
  });
});
