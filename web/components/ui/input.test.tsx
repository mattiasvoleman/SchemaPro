import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Input } from "./input";

describe("Input", () => {
  it("accepts typed text and fires onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Input aria-label="Room name" onChange={onChange} />);

    const input = screen.getByRole("textbox", { name: "Room name" });
    await user.type(input, "B204");

    expect(input).toHaveValue("B204");
    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it("passes the type attribute through", () => {
    render(<Input type="email" aria-label="Email" />);
    expect(screen.getByRole("textbox", { name: "Email" })).toHaveAttribute("type", "email");
  });

  it("rejects input while disabled", async () => {
    const user = userEvent.setup();
    render(<Input aria-label="Room name" disabled />);

    const input = screen.getByRole("textbox", { name: "Room name" });
    expect(input).toBeDisabled();
    await user.type(input, "B204");

    expect(input).toHaveValue("");
  });

  it("merges custom classes with the defaults", () => {
    render(<Input aria-label="Room name" className="w-24" />);
    const input = screen.getByRole("textbox", { name: "Room name" });
    expect(input).toHaveClass("w-24", "rounded-md");
    expect(input).not.toHaveClass("w-full");
  });

  // SC 1.4.11: an empty field is found by its edge. The hairline border-input
  // measures 1.27:1 on white; input-strong 3.49:1 (app/globals-css.test.ts).
  it("draws its edge in the 3:1 field token, not the hairline", () => {
    render(<Input aria-label="Room name" />);
    const input = screen.getByRole("textbox", { name: "Room name" });
    expect(input).toHaveClass("border-input-strong", "focus-visible:ring-2");
    expect(input).not.toHaveClass("border-input");
  });
});
