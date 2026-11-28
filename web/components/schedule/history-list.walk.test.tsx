import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NextIntlClientProvider } from "next-intl";
import { createElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { createTranslator } from "use-intl";
import sv from "@/messages/sv.json";
import { ApiError } from "@/lib/api";
import { useScheduleHistory } from "@/lib/use-schedule-history";
import type { MasterLesson } from "@/lib/types";
import { useUndoableEdits } from "@/app/[locale]/(app)/admin/timetable/use-undoable-edits";
import { HistoryList } from "./history-list";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

/*
 * The list against the page's own writes (E9, granskaren g521): the real history, the real useUndoableEdits, and a gateway that holds the lessons and refuses
 * a write whose `expected` is not what it holds (409 LESSON_CHANGED), as src/calendar/lesson-expectation.ts does. A walk back over steps of two lessons and
 * forward again must leave the gateway where the list says it is.
 */
type Row = Record<string, unknown> & { id: string };
const base = (id: string): MasterLesson =>
  ({ id, academicYearId: "y", subjectId: "ma", studentGroupId: "g", teacherId: "t-1", coTeacherId: null, roomId: "r-1", dayOfWeek: 1, startTime: "08:00:00", endTime: "09:00:00", isLocked: false, isParked: false, recurrence: "ALL_WEEKS", startDate: null, endDate: null, extraGroupIds: [], studentIds: [] }) as MasterLesson;

function world() {
  const rows: Record<string, Row> = { x: { ...base("x") }, y: { ...base("y") } };
  const writes: string[] = [];
  const update = {
    mutateAsync: vi.fn(async (body: { id: string; expected?: Record<string, unknown> } & Record<string, unknown>) => {
      const row = rows[body.id]!;
      for (const [field, seen] of Object.entries(body.expected ?? {})) {
        const held = /Time$/.test(field) ? String(row[field]).slice(0, 5) : row[field];
        if (JSON.stringify(held) !== JSON.stringify(seen)) throw new ApiError(409, "changed", "LESSON_CHANGED", { fields: field });
      }
      const { id, expected: _expected, propagate: _propagate, ...fields } = body;
      Object.assign(row, fields);
      writes.push(`${id}:${Object.keys(fields).join(",")}`);
      return { propagatedLessons: 1 };
    }),
  };
  const view = renderHook(
    () => {
      const history = useScheduleHistory();
      const edits = useUndoableEdits({
        t: ((key: string) => key) as never,
        tCommon: ((key: string) => key) as never,
        tEngine: Object.assign((key: string) => key, { has: () => true }) as never,
        updateLesson: update as never,
        createLesson: { mutateAsync: vi.fn() } as never,
        deleteLesson: { mutateAsync: vi.fn() } as never,
        history,
      });
      return { history, edits };
    },
    { wrapper: ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: new QueryClient() }, children) },
  );
  return { rows, writes, view };
}

const names = new Map([["ma", { id: "ma", name: "Matematik" }]]) as never;
const teachers = new Map([["t-1", { id: "t-1", firstName: "Anna", lastName: "Ek" }]]) as never;
const rooms = new Map([["r-1", { id: "r-1", name: "A1" }], ["r-2", { id: "r-2", name: "B2" }]]) as never;

function draw(view: ReturnType<typeof world>["view"], showError = vi.fn()) {
  const ui = () => (
    <NextIntlClientProvider locale="sv" messages={sv}>
      <HistoryList history={view.result.current.history} subjectById={names} teacherById={teachers} roomById={rooms} groupLabel={() => "7A"} showError={showError} />
    </NextIntlClientProvider>
  );
  const rendered = render(ui());
  return { rerender: () => rendered.rerender(ui()), showError };
}
const lines = () => [...document.querySelectorAll("ol > li")].map((li) => li.textContent?.replace(/^\d\d:\d\d /, ""));
const open = () => userEvent.click(screen.getByText(/Det du har gjort i den här sessionen/));

describe("a walk over the page's own steps", () => {
  it("goes back to the middle of the list and forward again, and the gateway holds what the list says at each stop", async () => {
    const { rows, view } = world();
    const x = base("x");
    const y = base("y");
    await act(async () => {
      await view.result.current.edits.undoableUpdate(x, { dayOfWeek: 3, startTime: "10:00", endTime: "11:00" });
      await view.result.current.edits.undoableUpdate(y, { roomId: "r-2" });
      await view.result.current.edits.undoableUpdate({ ...x, dayOfWeek: 3, startTime: "10:00:00", endTime: "11:00:00" } as MasterLesson, { isLocked: true });
    });
    const { rerender } = draw(view);
    await open();
    expect(lines().slice(0, 3)).toEqual(["Matematik 7A: låstNu", expect.stringMatching(/^Matematik 7A: sal B2Gå tillbaka hit$/), expect.stringMatching(/^Matematik 7A: flyttad till onsdag 10:00–11:00Gå tillbaka hit$/i)]);
    expect(rows.x).toMatchObject({ dayOfWeek: 3, startTime: "10:00", isLocked: true });
    expect(rows.y).toMatchObject({ roomId: "r-2" });

    // Back to the first step: the lock and the room are undone, in that order, and x stands where step 1 put it.
    await userEvent.click(screen.getAllByRole("button", { name: /Gå tillbaka (hit|till): Matematik 7A: flyttad/ })[0]!);
    await waitFor(() => expect(rows.y).toMatchObject({ roomId: "r-1" }));
    rerender();
    expect(rows.x).toMatchObject({ dayOfWeek: 3, isLocked: false });
    expect(view.result.current.history.steps().done).toHaveLength(1);
    expect(view.result.current.history.steps().undone).toHaveLength(2);

    // Redo to the second step: the room is B2 again and the lock is still off.
    await userEvent.click(screen.getByRole("button", { name: /Gör om (hit|till och med): Matematik 7A: sal B2/ }));
    await waitFor(() => expect(rows.y).toMatchObject({ roomId: "r-2" }));
    rerender();
    expect(rows.x).toMatchObject({ isLocked: false });
    expect(view.result.current.history.steps().done).toHaveLength(2);

    // And all the way back to the start: both lessons are as they were.
    await userEvent.click(screen.getByRole("button", { name: /Gå tillbaka (hit|till): Så här såg schemat ut/ }));
    await waitFor(() => expect(view.result.current.history.steps().done).toHaveLength(0));
    expect(rows.x).toMatchObject({ dayOfWeek: 1, startTime: "08:00", endTime: "09:00", isLocked: false });
    expect(rows.y).toMatchObject({ roomId: "r-1" });
  });

  it("stops at a lesson a colleague has changed since, says it, and what was undone before it stays undone", async () => {
    const { rows, view } = world();
    const x = base("x");
    const y = base("y");
    await act(async () => {
      await view.result.current.edits.undoableUpdate(x, { roomId: "r-2" });
      await view.result.current.edits.undoableUpdate(y, { roomId: "r-2" });
    });
    // A colleague moves the first lesson to another room.
    rows.x!["roomId"] = "r-1";
    rows.x!["teacherId"] = "t-9";
    const { rerender, showError } = draw(view);
    await open();
    await userEvent.click(screen.getByRole("button", { name: /Gå tillbaka (hit|till): Så här såg schemat ut/ }));
    await waitFor(() => expect(showError).toHaveBeenCalled());
    rerender();
    const steps = view.result.current.history.steps();
    // The second step was undone (y is back), the first is refused for good and dropped: x stands as the colleague left it.
    expect(rows.y).toMatchObject({ roomId: "r-1" });
    expect(steps.done).toHaveLength(0);
    expect(steps.undone).toHaveLength(1);
    expect((showError.mock.calls[0]![0] as ApiError).code).toBe("LESSON_CHANGED");
  });
});
