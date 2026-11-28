import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import sv from "@/messages/sv.json";
import { useScheduleHistory, type HistoryEntry, type HistoryLesson, type ScheduleHistory } from "@/lib/use-schedule-history";
import { HistoryList } from "./history-list";

/*
 * The session's steps as a list (E9): newest first with the clock, what each did in words, the start at the bottom, and a way back to every step (and
 * forward to one that has been undone) through the same undo and redo as the toolbar's. The walk stops at the first step that cannot be taken.
 */
const MATTE: HistoryLesson = { subjectId: "ma", studentGroupId: "g-7a", extraGroupIds: [], dayOfWeek: 1, startTime: "08:00:00", endTime: "09:00:00" };
const subjectById = new Map([["ma", { id: "ma", name: "Matematik" }], ["no", { id: "no", name: "Naturkunskap" }]]) as never;
const teacherById = new Map([["t-bo", { id: "t-bo", firstName: "Bo", lastName: "Berg" }]]) as never;
const roomById = new Map([["r-a12", { id: "r-a12", name: "A12" }]]) as never;
const groupLabel = (lesson: { studentGroupId: string }) => (lesson.studentGroupId === "g-7a" ? "7A" : "8B");

const step = (label: string, meta: HistoryEntry["meta"], over: Partial<HistoryEntry> = {}): HistoryEntry => ({ label, meta, at: new Date(2026, 10, 28, 10, 5).getTime(), undo: vi.fn(async () => {}), redo: vi.fn(async () => {}), ...over });

function setup(entries: HistoryEntry[]) {
  const hook = renderHook(() => useScheduleHistory());
  act(() => entries.forEach((entry) => hook.result.current.push(entry)));
  const showError = vi.fn();
  const view = (history: ScheduleHistory) => (
    <NextIntlClientProvider locale="sv" messages={sv}>
      <HistoryList history={history} subjectById={subjectById} teacherById={teacherById} roomById={roomById} groupLabel={groupLabel} showError={showError} />
    </NextIntlClientProvider>
  );
  const rendered = render(view(hook.result.current));
  const rerender = () => rendered.rerender(view(hook.result.current));
  return { ...rendered, hook, showError, rerender };
}
const open = async () => userEvent.click(screen.getByText(/Det du har gjort i den här sessionen/));
const lines = () => [...document.querySelectorAll("ol > li")].map((li) => li.textContent);

describe("the list of the session's steps", () => {
  it("is closed until it is wanted, says how many steps there are, and says when there are none", async () => {
    setup([]);
    expect(screen.getByText("Det du har gjort i den här sessionen (0)")).toBeTruthy();
    await open();
    expect(screen.getByText(/Inget än/)).toBeTruthy();
  });

  it("says each step in words, newest first, with the clock and the start of the session at the bottom", async () => {
    setup([
      step("update", { what: "update", lesson: MATTE, patch: { dayOfWeek: 2, startTime: "10:00", endTime: "11:00" } }),
      step("update", { what: "update", lesson: MATTE, patch: { roomId: "r-a12", teacherId: "t-bo", isLocked: true } }),
      step("create", { what: "create", lesson: { subjectId: "no", studentGroupId: "g-8b" } }),
      step("delete", { what: "delete", lesson: MATTE }),
      step("bulk-lock", { what: "bulk-lock", locked: true, count: 3 }),
      step("bulk-delete", { what: "bulk-delete", count: 1 }),
      step("lunch", undefined),
    ]);
    await open();
    expect(lines()).toEqual([
      "10:05 Ändrade lunchenNu",
      "10:05 Tog bort 1 lektionGå tillbaka hit",
      "10:05 Låste 3 lektionerGå tillbaka hit",
      "10:05 Borttagen: Matematik 7AGå tillbaka hit",
      "10:05 Ny lektion: Naturkunskap 8BGå tillbaka hit",
      "10:05 Matematik 7A: sal A12, lärare B. Berg, låstGå tillbaka hit",
      "10:05 Matematik 7A: flyttad till tisdag 10:00–11:00Gå tillbaka hit",
      "Så här såg schemat ut när du börjadeGå tillbaka hit",
    ]);
  });

  it("names a clock-only change by the day the lesson stood on, and a step it has no words for by its label", async () => {
    setup([step("update", { what: "update", lesson: MATTE, patch: { startTime: "09:00", endTime: "10:00" } }), step("other", undefined)]);
    await open();
    expect(lines()[1]).toBe("10:05 Matematik 7A: flyttad till måndag 09:00–10:00Gå tillbaka hit");
    expect(lines()[0]).toBe("10:05 Ändring i schemat" + "Nu");
  });

  it("goes back to a step: every step after it is undone, newest first, and the ones before it stand", async () => {
    const order: string[] = [];
    const entries = ["a", "b", "c"].map((label) => step(label, { what: "bulk-delete", count: 1 }, { undo: vi.fn(async () => void order.push(`undo ${label}`)), redo: vi.fn(async () => void order.push(`redo ${label}`)) }));
    const { hook, rerender } = setup(entries);
    await open();
    // Back to the first step: c and then b are undone, and a stands.
    await userEvent.click(screen.getAllByRole("button", { name: /Gå tillbaka hit: Tog bort 1 lektion/ })[1]!);
    await waitFor(() => expect(order).toEqual(["undo c", "undo b"]));
    rerender();
    expect(hook.result.current.steps().done.map((entry) => entry.label)).toEqual(["a"]);
    // The two that were undone are in the list, said so, and go forward to themselves.
    expect(lines().filter((line) => line?.includes("ångrad"))).toHaveLength(2);
  });

  it("goes forward to a step that was undone: it and the ones before it are done again, in order", async () => {
    const order: string[] = [];
    const entries = ["a", "b", "c"].map((label) => step(label, { what: "bulk-delete", count: 1 }, { undo: vi.fn(async () => void order.push(`undo ${label}`)), redo: vi.fn(async () => void order.push(`redo ${label}`)) }));
    const { hook, rerender } = setup(entries);
    await act(async () => {
      await hook.result.current.undo();
      await hook.result.current.undo();
      await hook.result.current.undo();
    });
    rerender();
    order.length = 0;
    await open();
    // Everything is undone: the list shows the three as undone, and "redo to here" on the second brings back a and b.
    const forward = screen.getAllByRole("button", { name: /Gör om hit/ });
    expect(forward).toHaveLength(3);
    await userEvent.click(forward[1]!);
    await waitFor(() => expect(order).toEqual(["redo a", "redo b"]));
  });

  it("goes back to the start: every step is undone", async () => {
    const order: string[] = [];
    const entries = ["a", "b"].map((label) => step(label, { what: "bulk-delete", count: 1 }, { undo: vi.fn(async () => void order.push(`undo ${label}`)) }));
    setup(entries);
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Gå tillbaka hit: Så här såg schemat ut när du började" }));
    await waitFor(() => expect(order).toEqual(["undo b", "undo a"]));
  });

  it("stops at the first step that cannot be taken, says why, and leaves the steps already taken as they are", async () => {
    const refusal = new Error("A colleague moved the lesson");
    const entries = [
      step("a", { what: "bulk-delete", count: 1 }),
      step("b", { what: "bulk-delete", count: 1 }, { undo: vi.fn(async () => Promise.reject(refusal)) }),
      step("c", { what: "bulk-delete", count: 1 }),
    ];
    const { hook, showError, rerender } = setup(entries);
    await open();
    await userEvent.click(screen.getByRole("button", { name: "Gå tillbaka hit: Så här såg schemat ut när du började" }));
    await waitFor(() => expect(showError).toHaveBeenCalledWith(refusal));
    rerender();
    // c was undone; b could not be, and a was never reached.
    expect(hook.result.current.steps().done.map((entry) => entry.label)).toEqual(["a", "b"]);
    expect(hook.result.current.steps().undone.map((entry) => entry.label)).toEqual(["c"]);
  });

  it("marks the buttons as schemaläggning's writes, and names each after its step", async () => {
    setup([step("a", { what: "bulk-delete", count: 2 }), step("b", { what: "bulk-delete", count: 1 })]);
    await open();
    const buttons = within(document.querySelector("ol")!).getAllByRole("button");
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(button).toHaveAttribute("data-writes", "SCHEMALAGGNING");
    expect(screen.getByRole("button", { name: "Gå tillbaka hit: Tog bort 2 lektioner" })).toBeTruthy();
  });
});
