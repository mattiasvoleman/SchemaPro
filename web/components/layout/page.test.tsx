import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Page } from "./page";

describe("Page", () => {
  it("is a full-width stack by default", () => {
    render(<Page data-testid="page">body</Page>);
    const root = screen.getByTestId("page");
    expect(root).toHaveClass("space-y-4");
    expect(root).not.toHaveClass("mx-auto");
    expect(root.className).not.toMatch(/max-w-/);
  });

  // Left-aligned, not centred: the h1 of a capped page starts at the same x as
  // on a full-width one, so it does not jump sideways between pages.
  it("caps a wide page at max-w-5xl against the left edge", () => {
    render(<Page width="wide" data-testid="page" />);
    const root = screen.getByTestId("page");
    expect(root).toHaveClass("space-y-4", "max-w-5xl");
    expect(root).not.toHaveClass("mx-auto");
  });

  it("caps a narrow page at max-w-3xl against the left edge", () => {
    render(<Page width="narrow" data-testid="page" />);
    const root = screen.getByTestId("page");
    expect(root).toHaveClass("space-y-4", "max-w-3xl");
    expect(root).not.toHaveClass("mx-auto");
  });

  it("merges a className and passes other attributes through", () => {
    render(<Page className="print:space-y-2" aria-busy="true" data-testid="page" />);
    const root = screen.getByTestId("page");
    expect(root).toHaveClass("space-y-4", "print:space-y-2");
    expect(root).toHaveAttribute("aria-busy", "true");
  });
});
