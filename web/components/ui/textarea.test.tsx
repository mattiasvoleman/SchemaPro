import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Textarea } from "./textarea";

describe("Textarea", () => {
  it("accepts multi-line typed text", async () => {
    const user = userEvent.setup();
    render(<Textarea aria-label="Notes" />);

    const textarea = screen.getByRole("textbox", { name: "Notes" });
    await user.type(textarea, "Line one{Enter}Line two");

    expect(textarea).toHaveValue("Line one\nLine two");
  });

  it("shows its placeholder and rejects input while disabled", async () => {
    const user = userEvent.setup();
    render(<Textarea aria-label="Notes" placeholder="Add solver notes" disabled />);

    const textarea = screen.getByPlaceholderText("Add solver notes");
    expect(textarea).toBeDisabled();
    await user.type(textarea, "nope");

    expect(textarea).toHaveValue("");
  });

  it("merges custom classes with the defaults", () => {
    render(<Textarea aria-label="Notes" className="min-h-[120px]" />);
    const textarea = screen.getByRole("textbox", { name: "Notes" });
    expect(textarea).toHaveClass("min-h-[120px]", "rounded-md");
    expect(textarea).not.toHaveClass("min-h-[60px]");
  });
});
