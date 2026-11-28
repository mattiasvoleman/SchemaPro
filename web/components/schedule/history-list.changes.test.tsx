import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { useScheduleHistory, type HistoryEntry, type HistoryLesson } from "@/lib/use-schedule-history";
import { HistoryList } from "./history-list";

/*
 * What a step says it changed (E9, granskaren g521). A save of the edit dialog carries every field of the dialog (page.tsx doSaveEdit: day, clock, room,
 * teacher, lock, weeks, dates), so the list has to say what DIFFERS from the lesson as it stood, or a change of the room reads "flyttad till …, upplåst,
 * andra veckor" on every save.
 */
const STOOD: HistoryLesson = {
  subjectId: "ma",
  studentGroupId: "g-7a",
  dayOfWeek: 2,
  startTime: "10:00:00",
  endTime: "11:00:00",
  roomId: "r-a12",
  teacherId: "t-bo",
  isLocked: true,
  isParked: false,
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
};
// What doSaveEdit sends when only the room was changed: everything the dialog holds, as the dialog read it from the lesson.
const SAVE = { dayOfWeek: 2, startTime: "10:00", endTime: "11:00", roomId: "r-a12", teacherId: "t-bo", isLocked: true, recurrence: "ALL_WEEKS", startDate: null, endDate: null };

const subjectById = new Map([["ma", { id: "ma", name: "Matematik" }]]) as never;
const teacherById = new Map([["t-bo", { id: "t-bo", firstName: "Bo", lastName: "Ek" }], ["t-cy", { id: "t-cy", firstName: "Cy", lastName: "Dahl" }]]) as never;
const roomById = new Map([["r-a12", { id: "r-a12", name: "A12" }], ["r-b3", { id: "r-b3", name: "B3" }]]) as never;
const groupLabel = (lesson: { studentGroupId: string; extraGroupIds?: string[] }) => ["7A", ...(lesson.extraGroupIds ?? [])].join(" + ");

function listOf(patch: object, locale: "sv" | "en" = "sv", lesson: HistoryLesson = STOOD) {
  const hook = renderHook(() => useScheduleHistory());
  const entry: HistoryEntry = { label: "update", meta: { what: "update", lesson, patch }, at: new Date(2026, 10, 28, 10, 5).getTime(), undo: async () => {}, redo: async () => {} };
  act(() => hook.result.current.push(entry));
  render(
    <NextIntlClientProvider locale={locale} messages={locale === "sv" ? sv : en}>
      <HistoryList history={hook.result.current} subjectById={subjectById} teacherById={teacherById} roomById={roomById} groupLabel={groupLabel} showError={vi.fn()} />
    </NextIntlClientProvider>,
  );
  return userEvent.click(screen.getByText(/Det du har gjort i den här sessionen|What you have done in this session/)).then(() => document.querySelector("ol > li")!.textContent);
}

describe("a step says what it changed, and not what the dialog restated", () => {
  it("names only the room when only the room was changed by a save of the dialog", async () => {
    expect(await listOf({ ...SAVE, roomId: "r-b3" })).toBe("10:05 Matematik 7A: sal B3Nu");
  });

  it("names only the teacher when the teacher is the one change", async () => {
    expect(await listOf({ ...SAVE, teacherId: "t-cy" })).toBe("10:05 Matematik 7A: lärare C. DahlNu");
  });

  it("says a lesson is moved when its clock is, to the day it stands on, and not when the dialog only restated the time", async () => {
    expect(await listOf({ ...SAVE, startTime: "13:00", endTime: "14:00", isLocked: false })).toBe("10:05 Matematik 7A: flyttad till tisdag 13:00–14:00, upplåstNu");
  });

  it("reads a clock the way the lesson holds it (HH:MM:SS) against the way the dialog writes it (HH:MM)", async () => {
    expect(await listOf({ ...SAVE, roomId: null })).toBe("10:05 Matematik 7A: utan salNu");
  });

  it("names the lesson alone for a save that changed nothing", async () => {
    expect(await listOf(SAVE)).toBe("10:05 Matematik 7ANu");
  });

  it("writes the weekday in lower case in Swedish and with a capital in English", async () => {
    expect(await listOf({ dayOfWeek: 3, startTime: "08:00", endTime: "09:00" })).toBe("10:05 Matematik 7A: flyttad till onsdag 08:00–09:00Nu");
    document.body.innerHTML = "";
    expect(await listOf({ dayOfWeek: 3, startTime: "08:00", endTime: "09:00" }, "en")).toBe("10:05 Matematik 7A: moved to Wednesday 08:00–09:00Now");
  });

  it("names a lesson with the classes it has besides its own", async () => {
    expect(await listOf(SAVE, "sv", { ...STOOD, extraGroupIds: ["7B"] })).toBe("10:05 Matematik 7A + 7BNu");
  });

  it("names each of the things a save can change when it is the only one: the day, the start, the end, no teacher, parked, placed, and the weeks", async () => {
    const one = async (patch: object, lesson: HistoryLesson = STOOD) => {
      document.body.innerHTML = "";
      return listOf({ ...SAVE, ...patch }, "sv", lesson);
    };
    expect(await one({ dayOfWeek: 4 })).toBe("10:05 Matematik 7A: flyttad till torsdag 10:00–11:00Nu");
    expect(await one({ startTime: "09:30" })).toBe("10:05 Matematik 7A: flyttad till tisdag 09:30–11:00Nu");
    expect(await one({ endTime: "11:30" })).toBe("10:05 Matematik 7A: flyttad till tisdag 10:00–11:30Nu");
    expect(await one({ teacherId: null })).toBe("10:05 Matematik 7A: utan lärareNu");
    expect(await one({ isParked: true })).toBe("10:05 Matematik 7A: satt åt sidanNu");
    expect(await one({ isParked: false }, { ...STOOD, isParked: true })).toBe("10:05 Matematik 7A: lagd i schematNu");
    expect(await one({ recurrence: "ODD_WEEKS" })).toBe("10:05 Matematik 7A: andra veckorNu");
    expect(await one({ startDate: "2026-09-01" })).toBe("10:05 Matematik 7A: andra veckorNu");
    expect(await one({ endDate: "2026-12-18" })).toBe("10:05 Matematik 7A: andra veckorNu");
  });
});
