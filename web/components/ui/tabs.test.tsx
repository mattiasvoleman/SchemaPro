import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./tabs";

function ScheduleTabs(props: { onValueChange?: (value: string) => void }) {
  return (
    <Tabs defaultValue="week" onValueChange={props.onValueChange}>
      <TabsList>
        <TabsTrigger value="week">Week</TabsTrigger>
        <TabsTrigger value="day">Day</TabsTrigger>
        <TabsTrigger value="settings" disabled>
          Settings
        </TabsTrigger>
      </TabsList>
      <TabsContent value="week">Week view</TabsContent>
      <TabsContent value="day">Day view</TabsContent>
      <TabsContent value="settings">Settings view</TabsContent>
    </Tabs>
  );
}

describe("Tabs", () => {
  it("shows only the default tab's panel initially", () => {
    render(<ScheduleTabs />);

    expect(screen.getByRole("tablist")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Week" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Day" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    expect(screen.getByText("Week view")).toBeInTheDocument();
    // Inactive panels are unmounted, not just hidden.
    expect(screen.queryByText("Day view")).not.toBeInTheDocument();
  });

  it("clicking a tab switches the panel and fires onValueChange with the tab value", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<ScheduleTabs onValueChange={onValueChange} />);

    await user.click(screen.getByRole("tab", { name: "Day" }));

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith("day");
    expect(screen.getByRole("tab", { name: "Day" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Day view")).toBeInTheDocument();
    expect(screen.queryByText("Week view")).not.toBeInTheDocument();
  });

  it("re-clicking the active tab does not fire onValueChange again", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<ScheduleTabs onValueChange={onValueChange} />);

    await user.click(screen.getByRole("tab", { name: "Week" }));

    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.getByText("Week view")).toBeInTheDocument();
  });

  it("arrow keys move selection with automatic activation", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<ScheduleTabs onValueChange={onValueChange} />);

    await user.click(screen.getByRole("tab", { name: "Week" }));
    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("tab", { name: "Day" })).toHaveFocus();
    expect(onValueChange).toHaveBeenCalledWith("day");
    expect(screen.getByText("Day view")).toBeInTheDocument();
  });

  it("arrow navigation skips the disabled tab and wraps around", async () => {
    const user = userEvent.setup();
    render(<ScheduleTabs />);

    await user.click(screen.getByRole("tab", { name: "Day" }));
    // Settings is disabled, so ArrowRight wraps back to Week.
    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("tab", { name: "Week" })).toHaveFocus();
    expect(screen.getByText("Week view")).toBeInTheDocument();
  });

  it("a disabled tab cannot be activated by click", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<ScheduleTabs onValueChange={onValueChange} />);

    const settings = screen.getByRole("tab", { name: "Settings" });
    expect(settings).toBeDisabled();
    await user.click(settings);

    expect(onValueChange).not.toHaveBeenCalled();
    expect(screen.queryByText("Settings view")).not.toBeInTheDocument();
    expect(screen.getByText("Week view")).toBeInTheDocument();
  });
});
