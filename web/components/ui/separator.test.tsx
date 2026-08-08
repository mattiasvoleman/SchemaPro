import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Separator } from "./separator";

describe("Separator", () => {
  it("is decorative by default and hidden from the accessibility tree", () => {
    // A decorative separator intentionally exposes no separator role, so there
    // is no accessible handle — a testid is the honest query here.
    render(<Separator data-testid="sep" />);
    const sep = screen.getByTestId("sep");
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
    expect(sep).toHaveAttribute("data-orientation", "horizontal");
    expect(sep).toHaveClass("h-[1px]", "w-full");
  });

  it("exposes the separator role when not decorative", () => {
    render(<Separator decorative={false} />);
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });

  it("renders vertical orientation with vertical sizing and aria-orientation", () => {
    render(<Separator decorative={false} orientation="vertical" />);
    const sep = screen.getByRole("separator");
    expect(sep).toHaveAttribute("aria-orientation", "vertical");
    expect(sep).toHaveAttribute("data-orientation", "vertical");
    expect(sep).toHaveClass("h-full", "w-[1px]");
  });

  it("merges custom classes", () => {
    render(<Separator data-testid="sep" className="my-4" />);
    expect(screen.getByTestId("sep")).toHaveClass("my-4", "bg-border");
  });
});
