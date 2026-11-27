import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { TIMES } from "@/lib/possible-times.fixture";
import type { MasterLesson } from "@/lib/types";
import type { LessonEditDraft } from "./lesson-edit-dialog";
import { LessonPossibleTimes } from "./lesson-possible-times";
import sv from "@/messages/sv.json";
import en from "@/messages/en.json";

const post = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: { post } }));

const LESSON = { id: "a", isParked: false } as MasterLesson;
const DRAFT: LessonEditDraft = {
  dayOfWeek: "1",
  startTime: "09:00",
  endTime: "10:00",
  roomId: "r1",
  teacherId: "t1",
  isLocked: false,
  recurrence: "ALL_WEEKS",
  startDate: "",
  endDate: "",
};

function show(locale: "sv" | "en" = "sv", draft: LessonEditDraft = DRAFT, onDraftChange = vi.fn()) {
  const view = render(
    <NextIntlClientProvider locale={locale} messages={(locale === "sv" ? sv : en) as never}>
      <LessonPossibleTimes lesson={LESSON} draft={draft} onDraftChange={onDraftChange} />
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
  post.mockResolvedValue(TIMES);
});
afterEach(cleanup);

describe("the possible times inside Justera lektion", () => {
  it("asks nothing until it is opened, and then asks once for the lesson", async () => {
    show();
    expect(screen.getByText("Möjliga tider")).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
    open();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0]![1]).toMatchObject({ lessonId: "a" });
  });

  it("lists the best times as buttons that say what they do, and fills day and clock when one is pressed", async () => {
    const { onDraftChange } = show();
    open();
    const first = await screen.findByRole("button", { name: /^1\. Tisdag 08:00–09:00/ });
    expect(first.textContent).toContain("ingen skillnad för veckan i övrigt");
    fireEvent.click(first);
    expect(onDraftChange).toHaveBeenCalledWith({ ...DRAFT, dayOfWeek: "2", startTime: "08:00", endTime: "09:00" });
  });

  it("fills the room too when the gateway offered the time in another, and says so", async () => {
    const { onDraftChange } = show();
    open();
    const third = await screen.findByRole("button", { name: /^3\. Onsdag 10:00–11:00/ });
    expect(third.textContent).toContain("i en annan sal");
    fireEvent.click(third);
    expect(onDraftChange).toHaveBeenCalledWith({ ...DRAFT, dayOfWeek: "3", startTime: "10:00", endTime: "11:00", roomId: "r2" });
  });

  it("marks the time the fields already say as the pressed one", async () => {
    show("sv", { ...DRAFT, dayOfWeek: "2", startTime: "08:30", endTime: "09:30" });
    open();
    const list = await screen.findByRole("list");
    const pressed = within(list).getAllByRole("button").filter((button) => button.getAttribute("aria-pressed") === "true");
    expect(pressed.map((button) => button.textContent?.slice(0, 21))).toEqual(["2. Tisdag 08:30–09:30"]);
  });

  it("says it could not look when the gateway does not answer, or answers with something else, and leaves the fields alone", async () => {
    post.mockRejectedValue(new Error("down"));
    const { onDraftChange } = show();
    open();
    expect(await screen.findByText(/Det gick inte att hämta de möjliga tiderna\. Fälten nedan/)).toBeTruthy();
    cleanup();
    post.mockResolvedValue("<html>");
    show();
    open();
    expect(await screen.findByText(/Det gick inte att hämta de möjliga tiderna\. Fälten nedan/)).toBeTruthy();
    expect(onDraftChange).not.toHaveBeenCalled();
  });

  it("says there is no time when there is none, and every word in English too", async () => {
    post.mockResolvedValue({ ...TIMES, options: [] });
    show("en");
    open();
    expect(await screen.findByText("There is no time in the week to put Matematik 7A at.")).toBeTruthy();
    expect(screen.getByText("Possible times")).toBeTruthy();
  });
});
