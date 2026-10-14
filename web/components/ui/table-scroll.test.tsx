import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TableScroll } from "./table-scroll";

/**
 * jsdom lays nothing out, so the widths are set by hand: the box is a tab
 * stop exactly when its content is wider than it.
 */

let observed: (() => void) | null = null;
vi.stubGlobal(
  "ResizeObserver",
  class {
    constructor(callback: () => void) {
      observed = callback;
    }
    observe() {}
    disconnect() {}
  },
);

function widths(scrollWidth: number, clientWidth: number) {
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(scrollWidth);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(clientWidth);
}

afterEach(() => vi.restoreAllMocks());

describe("TableScroll", () => {
  it("is no tab stop while the table fits", () => {
    widths(300, 300);
    render(<TableScroll><table><tbody><tr><td>Ella</td></tr></tbody></table></TableScroll>);
    expect(screen.getByRole("table").parentElement).not.toHaveAttribute("tabindex");
  });

  it("takes focus while the table is wider than the screen, so the keyboard can scroll it", () => {
    widths(900, 360);
    render(<TableScroll><table><tbody><tr><td>Ella</td></tr></tbody></table></TableScroll>);
    expect(screen.getByRole("table").parentElement).toHaveAttribute("tabindex", "0");
  });

  it("follows a resize either way", async () => {
    widths(300, 300);
    const { findByRole } = render(<TableScroll><table><tbody><tr><td>Ella</td></tr></tbody></table></TableScroll>);
    widths(900, 360);
    const { act } = await import("react");
    act(() => observed?.());
    expect((await findByRole("table")).parentElement).toHaveAttribute("tabindex", "0");
  });
});
