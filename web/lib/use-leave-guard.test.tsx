import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLeaveGuard } from "./use-leave-guard";

/**
 * Leaving a page that holds a half of a pair asks first. A link inside the app is asked here (with the page's own words);
 * closing, reloading and typing another address are the browser's question (beforeunload).
 */

let confirm: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  window.history.replaceState(null, "", "/sv/admin/placements?year=y1");
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

/** A link in the document, pressed by a plain left click; the click is returned so that it can be asked whether it was stopped. */
function press(href: string, init: MouseEventInit = {}, attrs: Record<string, string> = {}): MouseEvent {
  const link = document.createElement("a");
  link.setAttribute("href", href);
  for (const [name, value] of Object.entries(attrs)) link.setAttribute(name, value);
  const inner = document.createElement("span");
  link.append(inner);
  document.body.append(link);
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  // jsdom does not navigate; the click is only dispatched.
  inner.dispatchEvent(event);
  return event;
}

describe("a link inside the app", () => {
  it("asks, with the page's words, and lets the click through on a yes", () => {
    renderHook(() => useLeaveGuard(true, "Lämna sidan?"));
    const click = press("/sv/admin/timetable");
    expect(confirm).toHaveBeenCalledWith("Lämna sidan?");
    expect(click.defaultPrevented).toBe(false);
  });

  it("stops the click on a no, in the capture phase, so that the app's own listener never sees it", () => {
    confirm.mockReturnValue(false);
    renderHook(() => useLeaveGuard(true, "Lämna sidan?"));
    const reached = vi.fn();
    document.body.addEventListener("click", reached);
    const click = press("/sv/admin/timetable");
    expect(click.defaultPrevented).toBe(true);
    expect(reached).not.toHaveBeenCalled();
  });

  it("asks for the same page with another query, which is another place", () => {
    renderHook(() => useLeaveGuard(true, "Lämna sidan?"));
    press("/sv/admin/placements?year=y2");
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the page itself", "/sv/admin/placements?year=y1", {}, {}],
    ["a link that opens another tab", "/sv/admin/timetable", {}, { target: "_blank" }],
    ["a download", "/sv/file.csv", {}, { download: "" }],
    ["another origin, which is a real unload and the browser asks", "https://example.com/", {}, {}],
    ["a click with Ctrl, which opens another tab", "/sv/admin/timetable", { ctrlKey: true }, {}],
    ["a click with the middle button", "/sv/admin/timetable", { button: 1 }, {}],
  ])("does not ask for %s", (_name, href, init, attrs) => {
    renderHook(() => useLeaveGuard(true, "Lämna sidan?"));
    const click = press(href, init, attrs);
    expect(confirm).not.toHaveBeenCalled();
    expect(click.defaultPrevented).toBe(false);
  });

  it("is not asked about when nothing is held", () => {
    renderHook(() => useLeaveGuard(false, "Lämna sidan?"));
    press("/sv/admin/timetable");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("stops asking when the half is gone, and starts when one is held", () => {
    const { rerender } = renderHook(({ active }) => useLeaveGuard(active, "Lämna sidan?"), { initialProps: { active: true } });
    press("/sv/admin/a");
    expect(confirm).toHaveBeenCalledTimes(1);
    rerender({ active: false });
    press("/sv/admin/b");
    expect(confirm).toHaveBeenCalledTimes(1);
    rerender({ active: true });
    press("/sv/admin/c");
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("lets go of its listeners when the page goes", () => {
    const { unmount } = renderHook(() => useLeaveGuard(true, "Lämna sidan?"));
    unmount();
    press("/sv/admin/timetable");
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("closing, reloading, typing another address", () => {
  it("is the browser's own question: beforeunload is cancelled while a half is held", () => {
    renderHook(() => useLeaveGuard(true, "Lämna sidan?"));
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("asks nothing when no half is held", () => {
    renderHook(() => useLeaveGuard(false, "Lämna sidan?"));
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
