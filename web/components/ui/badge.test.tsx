import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Badge } from "./badge";

describe("Badge", () => {
  it("renders its text with the default variant", () => {
    render(<Badge>Published</Badge>);
    const badge = screen.getByText("Published");
    expect(badge).toHaveClass("bg-primary");
  });

  it("applies the requested variant", () => {
    render(<Badge variant="success">Feasible</Badge>);
    // Ink in the strong shade: plain --success on its own tint is 3.3:1, under AA.
    expect(screen.getByText("Feasible")).toHaveClass("bg-success/15", "text-success-strong");
  });

  it("merges a custom className", () => {
    render(
      <Badge variant="outline" className="uppercase">
        Draft
      </Badge>,
    );
    const badge = screen.getByText("Draft");
    expect(badge).toHaveClass("uppercase", "text-foreground");
  });
});
