import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Switch } from "./switch";

describe("Switch", () => {
  it("renders as an unchecked switch by default", () => {
    render(<Switch aria-label="Notifications" />);
    const toggle = screen.getByRole("switch", { name: "Notifications" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(toggle).toHaveAttribute("data-state", "unchecked");
  });

  it("click toggles on and fires onCheckedChange(true) once", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Notifications" onCheckedChange={onCheckedChange} />);

    await user.click(screen.getByRole("switch", { name: "Notifications" }));

    expect(onCheckedChange).toHaveBeenCalledTimes(1);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch")).toHaveAttribute("data-state", "checked");
  });

  it("click on a defaultChecked switch fires onCheckedChange(false)", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(
      <Switch aria-label="Notifications" defaultChecked onCheckedChange={onCheckedChange} />,
    );

    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");

    await user.click(screen.getByRole("switch"));

    expect(onCheckedChange).toHaveBeenCalledWith(false);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  it("toggles with the Space key when focused", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Notifications" onCheckedChange={onCheckedChange} />);

    await user.tab();
    expect(screen.getByRole("switch")).toHaveFocus();
    await user.keyboard(" ");

    expect(onCheckedChange).toHaveBeenCalledTimes(1);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("a controlled switch does not flip its own state", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(
      <Switch aria-label="Notifications" checked={false} onCheckedChange={onCheckedChange} />,
    );

    await user.click(screen.getByRole("switch"));

    // Parent owns the state: the callback fires but aria-checked stays false
    // until the parent re-renders with checked=true.
    expect(onCheckedChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  });

  // SC 1.4.11: an unchecked switch is found by its track. The hairline
  // bg-input measured 1.27:1 on white, under a white thumb; input-strong
  // measures 3.49:1, and the thumb the same on it (app/globals-css.test.ts).
  it("paints the unchecked track in the 3:1 field token, under a page-coloured thumb", () => {
    render(<Switch aria-label="Notifications" />);
    const toggle = screen.getByRole("switch", { name: "Notifications" });
    expect(toggle).toHaveClass("data-[state=unchecked]:bg-input-strong", "data-[state=checked]:bg-primary");
    expect(toggle).not.toHaveClass("data-[state=unchecked]:bg-input");
    expect(toggle.firstElementChild).toHaveClass("bg-background");
  });

  it("does not fire when disabled", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(<Switch aria-label="Notifications" disabled onCheckedChange={onCheckedChange} />);

    const toggle = screen.getByRole("switch");
    expect(toggle).toBeDisabled();
    await user.click(toggle);

    expect(onCheckedChange).not.toHaveBeenCalled();
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });
});
