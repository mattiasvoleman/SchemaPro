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
    expect(screen.getByText("Feasible")).toHaveClass("bg-success/15", "text-success");
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
