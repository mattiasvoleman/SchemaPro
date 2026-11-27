import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { RoomChoice, RoomChoices } from "@/lib/possible-times";
import type { MasterLesson } from "@/lib/types";
import type { LessonEditDraft } from "./lesson-edit-dialog";
import { LessonRoomChoices } from "./lesson-room-choices";
import sv from "@/messages/sv.json";
import en from "@/messages/en.json";

const post = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: { post } }));

const NONE = "none";
const LESSON = { id: "a", isParked: false } as MasterLesson;
const DRAFT: LessonEditDraft = { dayOfWeek: "2", startTime: "09:30", endTime: "10:30", roomId: "r1", teacherId: "t1", isLocked: false, recurrence: "ALL_WEEKS", startDate: "", endDate: "" };

const room = (over: Partial<RoomChoice> & { roomId: string; name: string }): RoomChoice => ({
  capacity: 30,
  needed: 25,
  state: "FREE",
  tooSmall: false,
  typeOk: true,
  sameTypeAsOwn: true,
  allowed: true,
  current: false,
  shared: false,
  rank: null,
  occupant: null,
  occupants: 0,
  closedBy: null,
  closedParams: {},
  ...over,
});
const ANSWER: RoomChoices = {
  academicYearId: "y",
  lessonId: "a",
  className: "7A",
  subjectName: "Matematik",
  dayOfWeek: 2,
  startMinutes: 570,
  endMinutes: 630,
  rooms: [
    room({ roomId: "r1", name: "Sal 101", current: true, rank: 1 }),
    room({ roomId: "r2", name: "Sal 102", rank: 2, capacity: 26 }),
    room({ roomId: "r3", name: "Liten sal", capacity: 10, tooSmall: true, allowed: false }),
    room({ roomId: "r4", name: "Sal 103", state: "BUSY", occupants: 2, occupant: { lessonId: "x", className: "7B", subjectName: "Svenska", dayOfWeek: 2, startMinutes: 540, endMinutes: 600, isLocked: false } }),
    room({ roomId: "r5", name: "Utlånad", state: "CLOSED", closedBy: "OTHER_SCHOOL", closedParams: { schools: "Norra" } }),
    room({ roomId: "r6", name: "Delad", shared: true, capacity: null }),
  ],
};

function show(locale: "sv" | "en" = "sv", draft: LessonEditDraft = DRAFT, onDraftChange = vi.fn()) {
  const view = render(
    <NextIntlClientProvider locale={locale} messages={(locale === "sv" ? sv : en) as never}>
      <LessonRoomChoices lesson={LESSON} draft={draft} onDraftChange={onDraftChange} none={NONE} />
    </NextIntlClientProvider>,
  );
  return { view, onDraftChange };
}
const open = () => {
  const details = document.querySelector("details")!;
  details.open = true;
  fireEvent(details, new Event("toggle"));
};

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue(ANSWER);
});
afterEach(cleanup);

describe("the room chooser inside Justera lektion", () => {
  it("asks nothing until it is opened, then asks for the day and the start the fields say", async () => {
    show();
    expect(post).not.toHaveBeenCalled();
    open();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post).toHaveBeenCalledWith("/api/v1/master-lessons/room-choices", { lessonId: "a", dayOfWeek: 2, startTime: "09:30" }, expect.anything());
  });

  it("lists every room in the order it was given, with seats against pupils and what is the matter with each, in words", async () => {
    show();
    open();
    await screen.findByRole("button", { name: /^Sal 101/ });
    const rows = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(rows).toEqual([
      "Sal 10130 platser, 25 elever" + "lektionens sal, ledig, förslag 1",
      "Sal 10226 platser, 25 elever" + "ledig, förslag 2",
      "Liten sal10 platser, 25 elever" + "ledig, för liten",
      "Sal 10330 platser, 25 elever" + "upptagen av Svenska 7B Tisdag 09:00–10:00 och en till",
      "Utlånad30 platser, 25 elever" + "stängd: Annan skola",
      "Deladplatser okända, 25 elever" + "ledig, delas av flera lektioner: domaren räknar eleverna när lektionen läggs",
    ]);
  });

  it("fills the Sal field with the room pressed, and takes the choice away when it is pressed again", async () => {
    const { onDraftChange } = show();
    open();
    fireEvent.click(await screen.findByRole("button", { name: /^Sal 102/ }));
    expect(onDraftChange).toHaveBeenCalledWith({ ...DRAFT, roomId: "r2" });
    cleanup();
    const again = show("sv", { ...DRAFT, roomId: "r2" });
    open();
    const pressed = await screen.findByRole("button", { name: /^Sal 102/ });
    expect(pressed.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(pressed);
    expect(again.onDraftChange).toHaveBeenCalledWith({ ...DRAFT, roomId: NONE });
  });

  it("asks again when the clock changes while it is open, and not for a clock that is none", async () => {
    const { view } = show();
    open();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    view.rerender(
      <NextIntlClientProvider locale="sv" messages={sv as never}>
        <LessonRoomChoices lesson={LESSON} draft={{ ...DRAFT, startTime: "11:00" }} onDraftChange={vi.fn()} none={NONE} />
      </NextIntlClientProvider>,
    );
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1]![1]).toMatchObject({ startTime: "11:00" });
    view.rerender(
      <NextIntlClientProvider locale="sv" messages={sv as never}>
        <LessonRoomChoices lesson={LESSON} draft={{ ...DRAFT, startTime: "" }} onDraftChange={vi.fn()} none={NONE} />
      </NextIntlClientProvider>,
    );
    expect(await screen.findByText("Skriv ett klockslag för att se salarna.")).toBeTruthy();
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("says it could not look when the gateway does not answer, or answers with something else", async () => {
    post.mockRejectedValue(new Error("down"));
    show();
    open();
    expect(await screen.findByText(/Det gick inte att hämta salarna\. Fältet Sal fungerar som förut\./)).toBeTruthy();
    cleanup();
    post.mockResolvedValue({ nope: true });
    show();
    open();
    expect(await screen.findByText(/Det gick inte att hämta salarna/)).toBeTruthy();
  });

  it("is said in English too", async () => {
    show("en");
    open();
    await screen.findByRole("button", { name: /^Sal 101/ });
    expect(screen.getByText("taken by Svenska 7B Tuesday 09:00–10:00 and one more")).toBeTruthy();
    expect(screen.getByText("closed: Other school")).toBeTruthy();
    expect(screen.getByText("Rooms for this time")).toBeTruthy();
  });
});
