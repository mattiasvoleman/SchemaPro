import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LatestSwitch, type LatestState } from "./latest-switch";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: Record<string, unknown>) => (values ? `${key}(${Object.values(values).join("|")})` : key),
}));

const draw = (over: Partial<{ on: boolean; picked: boolean; state: LatestState; count: number; onChange: (on: boolean) => void }> = {}) =>
  render(<LatestSwitch on picked state="ready" count={3} onChange={() => undefined} {...over} />);

describe("the switch for the latest schedule", () => {
  it("is a checkbox with its label and says in words what it does", () => {
    draw({ on: false });
    const box = screen.getByRole("checkbox", { name: "label" });
    expect(box).not.toBeChecked();
    expect(box).toHaveAccessibleDescription("hint");
  });

  it("reports what the school chose", async () => {
    const onChange = vi.fn();
    draw({ on: false, onChange });
    await userEvent.click(screen.getByRole("checkbox"));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("says nothing while it is off", () => {
    draw({ on: false });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("says what is shown, with how many", () => {
    draw({ count: 12 });
    expect(screen.getByRole("status")).toHaveTextContent("shown(12)");
  });

  it("says that nothing is picked, before anything else: the schedule is drawn for what is picked and for nothing else", () => {
    for (const state of ["loading", "failed", "ready"] as const) {
      const { unmount } = draw({ picked: false, state });
      expect(screen.getByRole("status")).toHaveTextContent("needsFilter");
      unmount();
    }
  });

  it("says that it is on its way, that it did not come, and that it holds nothing for what is picked", () => {
    const { unmount } = draw({ state: "loading", count: 0 });
    expect(screen.getByRole("status")).toHaveTextContent("loading");
    unmount();
    const failed = draw({ state: "failed", count: 0 });
    expect(screen.getByRole("status")).toHaveTextContent("failed");
    failed.unmount();
    draw({ state: "ready", count: 0 });
    expect(screen.getByRole("status")).toHaveTextContent("none");
  });
});
