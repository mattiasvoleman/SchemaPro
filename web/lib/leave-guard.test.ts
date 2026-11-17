import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guardLeaving } from "./leave-guard";

/**
 * Leaving a page that holds a half of a pair asks first. A link inside the app is asked here (with the page's own words);
 * closing, reloading and typing another address are the browser's question (beforeunload).
 */

let confirm: ReturnType<typeof vi.spyOn>;
let stop: (() => void) | undefined;

beforeEach(() => {
  confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  window.history.replaceState(null, "", "/sv/admin/placements?year=y1");
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const guard = (message = "Lämna sidan?") => {
  stop = guardLeaving(message);
  return stop;
};

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
    guard();
    const click = press("/sv/admin/timetable");
    expect(confirm).toHaveBeenCalledWith("Lämna sidan?");
    expect(click.defaultPrevented).toBe(false);
  });

  it("stops the click on a no, in the capture phase, so that the app's own listener never sees it", () => {
    confirm.mockReturnValue(false);
    guard();
    const reached = vi.fn();
    document.body.addEventListener("click", reached);
    const click = press("/sv/admin/timetable");
    expect(click.defaultPrevented).toBe(true);
    expect(reached).not.toHaveBeenCalled();
  });

  it("asks for the same page with another query, which is another place", () => {
    guard();
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
    guard();
    const click = press(href, init, attrs);
    expect(confirm).not.toHaveBeenCalled();
    expect(click.defaultPrevented).toBe(false);
  });

  it("stops asking when it is stopped (the half is gone), and asks again when a new guard starts", () => {
    const first = guard();
    press("/sv/admin/a");
    expect(confirm).toHaveBeenCalledTimes(1);
    first();
    press("/sv/admin/b");
    expect(confirm).toHaveBeenCalledTimes(1);
    guard();
    press("/sv/admin/c");
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("does not ask before it is started", () => {
    press("/sv/admin/timetable");
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe("closing, reloading, typing another address", () => {
  it("is the browser's own question: beforeunload is cancelled while the guard stands", () => {
    guard();
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("asks nothing once the guard is stopped", () => {
    guard()();
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
