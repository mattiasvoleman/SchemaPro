import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Skeleton } from "./skeleton";

describe("Skeleton", () => {
  it("carries the pulse animation and merges custom classes", () => {
    // A loading placeholder has no accessible role by design; a testid is the
    // only stable handle.
    render(<Skeleton data-testid="skeleton" className="h-4 w-32" />);
    const skeleton = screen.getByTestId("skeleton");
    expect(skeleton).toHaveClass("animate-pulse", "h-4", "w-32", "bg-muted");
  });

  it("spreads extra props onto the element", () => {
    render(<Skeleton data-testid="skeleton" aria-hidden="true" />);
    expect(screen.getByTestId("skeleton")).toHaveAttribute("aria-hidden", "true");
  });
});
