import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import sv from "@/messages/sv.json";
import { useScheduleHistory, type HistoryEntry } from "@/lib/use-schedule-history";
import { HistoryList } from "./history-list";

/*
 * The first row of the list says how the timetable looked when the reader began, and it is not so once a step has left the list without being undone
 * (E9, granskaren g521): the history keeps 100 steps, and a step that cannot be undone for good (a colleague changed the lesson, the judge's no) is dropped
 * and what it did stands. "Gå tillbaka hit" on that row then stops at the oldest step the list has, and the row says so.
 */
const step = (label: string, over: Partial<HistoryEntry> = {}): HistoryEntry => ({ label, meta: { what: "bulk-delete", count: 1 }, at: new Date(2026, 10, 28, 10, 5).getTime(), undo: vi.fn(async () => {}), redo: vi.fn(async () => {}), ...over });

function draw(entries: HistoryEntry[]) {
  const hook = renderHook(() => useScheduleHistory());
  act(() => entries.forEach((entry) => hook.result.current.push(entry)));
  const showError = vi.fn();
  const view = () => (
    <NextIntlClientProvider locale="sv" messages={sv}>
      <HistoryList history={hook.result.current} subjectById={new Map() as never} teacherById={new Map() as never} roomById={new Map() as never} groupLabel={() => ""} showError={showError} />
    </NextIntlClientProvider>
  );
  const rendered = render(view());
  return { hook, showError, rerender: () => rendered.rerender(view()) };
}
const open = () => userEvent.click(screen.getByText(/Det du har gjort i den här sessionen/));
const START = "Så här såg schemat ut när du började";
const CUT = /Så långt tillbaka listan når/;

describe("the first row of the list of the session's steps", () => {
  it("says the timetable looked so when the reader began while every step is in the list", async () => {
    draw([step("a"), step("b")]);
    await open();
    expect(screen.getByText(START)).toBeTruthy();
    expect(screen.queryByText(CUT)).toBeNull();
  });

  it("says it is as far back as the list goes when the history has dropped its oldest steps", async () => {
    draw(Array.from({ length: 101 }, (_, index) => step(`s${index}`)));
    await open();
    expect(screen.queryByText(START)).toBeNull();
    expect(screen.getByText(CUT)).toBeTruthy();
    // The button is named by what the row says, and still walks to the oldest step the list has.
    expect(screen.getByRole("button", { name: /Så långt tillbaka listan når/ })).toBeTruthy();
  });

  it("says it after a step that could not be undone for good was dropped in the middle of a walk, and the walk stopped there", async () => {
    const refusal = new Error("A colleague changed the lesson");
    const { hook, showError, rerender } = draw([step("a"), step("b", { undo: async () => Promise.reject(refusal), refusedUndo: () => true }), step("c")]);
    await open();
    await userEvent.click(screen.getByRole("button", { name: new RegExp(`${START}`) }));
    await vi.waitFor(() => expect(showError).toHaveBeenCalledWith(refusal));
    rerender();
    // c is undone, b is dropped (what it did stands), a is done: the row at the bottom must not claim that this is the start.
    expect(hook.result.current.steps().done.map((entry) => entry.label)).toEqual(["a"]);
    expect(screen.queryByText(START)).toBeNull();
    expect(screen.getByText(CUT)).toBeTruthy();
  });

  it("says Nu on the first row when every step is undone, and counts the steps undone in the heading", async () => {
    const { hook, rerender } = draw([step("a"), step("b"), step("c")]);
    await act(async () => void (await hook.result.current.undo()));
    rerender();
    await open();
    // One of three is undone: the heading counts all three, and the first row has a way back (not Nu).
    expect(screen.getByText("Det du har gjort i den här sessionen (3)")).toBeTruthy();
    expect(screen.getByText(START).parentElement!.textContent).not.toMatch(/Nu$/);
    await act(async () => {
      await hook.result.current.undo();
      await hook.result.current.undo();
    });
    rerender();
    expect(screen.getByText(START).parentElement!.textContent).toMatch(/Nu$/);
    expect(screen.getByText("Det du har gjort i den här sessionen (3)")).toBeTruthy();
  });
});
