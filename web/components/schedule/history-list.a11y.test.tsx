import { act, render, renderHook, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { useScheduleHistory, type HistoryEntry } from "@/lib/use-schedule-history";
import { HistoryList } from "./history-list";

const toasts = vi.hoisted(() => ({ info: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

/*
 * The list of the session's steps for a reader who does not see it (E9, granskaren g521): a button is named by what it says on it (WCAG 2.5.3, so that
 * "Gå tillbaka hit" said to a voice control finds it), a walk that got there is said as the toolbar's Ångra says it, and the focus does not fall to the page when the
 * button that held it turns into "Nu".
 */
const at = new Date(2026, 10, 28, 10, 5).getTime();
const step = (label: string, count: number): HistoryEntry => ({ label, meta: { what: "bulk-delete", count }, at, undo: vi.fn(async () => {}), redo: vi.fn(async () => {}) });

function draw(locale: "sv" | "en", entries: HistoryEntry[]) {
  const hook = renderHook(() => useScheduleHistory());
  act(() => entries.forEach((entry) => hook.result.current.push(entry)));
  const view = () => (
    <NextIntlClientProvider locale={locale} messages={locale === "sv" ? sv : en}>
      <HistoryList history={hook.result.current} subjectById={new Map() as never} teacherById={new Map() as never} roomById={new Map() as never} groupLabel={() => ""} showError={vi.fn()} />
    </NextIntlClientProvider>
  );
  const rendered = render(view());
  return { hook, rerender: () => rendered.rerender(view()) };
}
const open = () => userEvent.click(screen.getByText(/Det du har gjort i den här sessionen|What you have done in this session/));

describe.each(["sv", "en"] as const)("the buttons of the list, in %s", (locale) => {
  it("have the words that are on them at the start of their name, so that a voice control that says what it sees finds them", async () => {
    const { hook, rerender } = draw(locale, [step("a", 1), step("b", 2), step("c", 3)]);
    await open();
    await act(async () => void (await hook.result.current.undo()));
    rerender();
    const buttons = within(document.querySelector("ol")!).getAllByRole("button");
    // Two steps done, one undone ("redo to here"), and the start.
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    for (const button of buttons) {
      const name = button.getAttribute("aria-label")!;
      expect(name.toLowerCase().startsWith(button.textContent!.trim().toLowerCase())).toBe(true);
      // And still says which step it is about.
      expect(name.length).toBeGreaterThan(button.textContent!.trim().length + 2);
    }
  });
});

describe("a walk that gets there", () => {
  it("is said when it went back to a step, when it went forward to one, and when it went back to the start", async () => {
    const { hook, rerender } = draw("sv", [step("a", 1), step("b", 2), step("c", 3)]);
    await open();
    await userEvent.click(screen.getByRole("button", { name: /Gå tillbaka hit: Tog bort 1 lektion/ }));
    await vi.waitFor(() => expect(toasts.info).toHaveBeenCalledWith("Tillbaka vid: Tog bort 1 lektion"));
    rerender();
    await userEvent.click(screen.getByRole("button", { name: /Gör om hit: Tog bort 3 lektioner/ }));
    await vi.waitFor(() => expect(toasts.info).toHaveBeenCalledWith("Gjorde om till och med: Tog bort 3 lektioner"));
    rerender();
    await userEvent.click(screen.getByRole("button", { name: /Gå tillbaka hit: Så här såg schemat ut när du började/ }));
    await vi.waitFor(() => expect(toasts.info).toHaveBeenCalledWith("Alla steg i listan är ångrade"));
    expect(hook.result.current.steps().done).toHaveLength(0);
  });

  it("says nothing when a step could not be taken (the toast of the error says it)", async () => {
    toasts.info.mockClear();
    const refusing = { ...step("b", 2), undo: vi.fn(async () => Promise.reject(new Error("no"))) };
    draw("sv", [step("a", 1), refusing]);
    await open();
    await userEvent.click(screen.getByRole("button", { name: /Gå tillbaka hit: Så här såg schemat ut när du började/ }));
    await vi.waitFor(() => expect(refusing.undo).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(toasts.info).not.toHaveBeenCalled();
  });

  it("leaves the focus on the heading of the list, and not on the page behind the dialog", async () => {
    const { rerender } = draw("sv", [step("a", 1), step("b", 2)]);
    await open();
    const button = screen.getByRole("button", { name: /Gå tillbaka hit: Så här såg schemat ut när du började/ });
    button.focus();
    await userEvent.click(button);
    await vi.waitFor(() => expect(toasts.info).toHaveBeenCalled());
    rerender();
    expect(document.activeElement).toBe(screen.getByText(/Det du har gjort i den här sessionen/).closest("summary"));
  });
});
