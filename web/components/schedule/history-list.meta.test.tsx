import { act, render, renderHook, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { useScheduleHistory, type HistoryEntry } from "@/lib/use-schedule-history";
import { HistoryList } from "./history-list";

/*
 * A block's move and lock and a class's meal are steps of the list like any other (E9, granskaren g521): they used to carry no meta, and read "Ändring i
 * schemat" and "Ändrade lunchen" whatever they were, so that three of them in a row could not be told apart, nor a screen reader's "Gå tillbaka till: …".
 */
const at = new Date(2026, 10, 28, 10, 5).getTime();
const step = (label: string, meta: HistoryEntry["meta"]): HistoryEntry => ({ label, meta, at, undo: async () => {}, redo: async () => {} });
const entries: HistoryEntry[] = [
  step("block-move", { what: "block-move", name: "Språkval åk 7", dayOfWeek: 3, startTime: "09:00", endTime: "10:00" }),
  step("block-lock", { what: "block-lock", name: "Språkval åk 7", locked: true }),
  step("block-lock", { what: "block-lock", name: "Språkval åk 7", locked: false }),
  step("lunch", { what: "lunch", kind: "place", dayOfWeek: 2, startTime: "11:30" }),
  step("lunch", { what: "lunch", kind: "move", dayOfWeek: 4, startTime: "12:00" }),
  step("lunch", { what: "lunch", kind: "remove", dayOfWeek: 5, startTime: "11:00" }),
  step("lunch", undefined),
];

async function lines(locale: "sv" | "en") {
  const hook = renderHook(() => useScheduleHistory());
  act(() => entries.forEach((entry) => hook.result.current.push(entry)));
  render(
    <NextIntlClientProvider locale={locale} messages={locale === "sv" ? sv : en}>
      <HistoryList history={hook.result.current} subjectById={new Map() as never} teacherById={new Map() as never} roomById={new Map() as never} groupLabel={() => ""} showError={vi.fn()} />
    </NextIntlClientProvider>,
  );
  await userEvent.click(screen.getByText(/Det du har gjort i den här sessionen|What you have done in this session/));
  return [...document.querySelectorAll("ol > li")].map((li) => li.textContent?.replace(/^\d\d:\d\d /, "").replace(/(Gå tillbaka hit|Go back here|Nu|Now)$/, ""));
}

describe("the steps of a block and of a meal", () => {
  it("say what they were, in Swedish", async () => {
    expect(await lines("sv")).toEqual([
      "Ändrade lunchen",
      "Lunch borttagen från fredag 11:00",
      "Lunch flyttad till torsdag 12:00",
      "Lunch lagd tisdag 11:30",
      "Låste upp blocket Språkval åk 7",
      "Låste blocket Språkval åk 7",
      "Blocket Språkval åk 7: flyttat till onsdag 09:00–10:00",
      "Så här såg schemat ut när du började",
    ]);
  });

  it("say what they were, in English", async () => {
    expect(await lines("en")).toEqual([
      "Changed the lunch",
      "Lunch removed from Friday 11:00",
      "Lunch moved to Thursday 12:00",
      "Lunch placed at Tuesday 11:30",
      "Unlocked the block Språkval åk 7",
      "Locked the block Språkval åk 7",
      "The block Språkval åk 7: moved to Wednesday 09:00–10:00",
      "The timetable as it was when you began",
    ]);
  });
});
