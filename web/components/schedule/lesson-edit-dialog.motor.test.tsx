import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MasterLesson } from "@/lib/types";
import { LessonEditDialog, type LessonEditDraft } from "./lesson-edit-dialog";

/*
 * LÅST ELLER FRI FÖR MOTORN (E4): Justera lektion says, under the lock, what the next Generera does with the lesson as it is saved. The words are
 * the gateway's rule (lib/motor-owner.ts); a lesson read without the column says nothing.
 */
vi.mock("@/lib/api", () => ({ api: { post: vi.fn(() => new Promise(() => {})) } }));
vi.mock("next-intl", async () => {
  const { createTranslator } = await import("use-intl");
  const sv = (await import("@/messages/sv.json")).default;
  return {
    useLocale: () => "sv",
    useTranslations: (namespace: string) => createTranslator({ locale: "sv", messages: sv, namespace: namespace as never }),
  };
});

const NONE = "__none__";
const base = {
  id: "l-1",
  academicYearId: "y1",
  subjectId: "Ma",
  studentGroupId: "7A",
  teacherId: "anna",
  coTeacherId: null,
  roomId: null,
  dayOfWeek: 1,
  startTime: "14:30:00",
  endTime: "15:30:00",
  isLocked: false,
  isParked: false,
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  extraGroupIds: [],
  studentIds: [],
} as MasterLesson;
const draft: LessonEditDraft = { dayOfWeek: "1", startTime: "14:30", endTime: "15:30", roomId: NONE, teacherId: "anna", isLocked: false, recurrence: "ALL_WEEKS", startDate: "", endDate: "" };

const draw = (lesson: MasterLesson, over: Partial<LessonEditDraft> = {}) =>
  render(
    <LessonEditDialog
      open
      lesson={lesson}
      onOpenChange={() => {}}
      lessonName="Matematik 7A"
      draft={{ ...draft, ...over }}
      onDraftChange={() => {}}
      rooms={[]}
      teachers={[]}
      onDelete={() => {}}
      deletePending={false}
      onDuplicate={() => {}}
      onPark={() => {}}
      onSuggestSwaps={() => {}}
      onCancel={() => {}}
      onSave={() => {}}
      savePending={false}
      none={NONE}
    />,
  );

describe("Justera lektion says whether the motor keeps the lesson", () => {
  it.each([
    ["a lesson Generera laid and nobody locked", { isGenerated: true }, "Fri för motorn: nästa Generera lägger om lektionen."],
    ["a locked lesson", { isGenerated: true, isLocked: true }, "Låst för motorn: Generera låter lektionen stå där den är."],
    ["a lesson made by hand", { isGenerated: false }, "Låst för motorn: lektionen är handgjord, och Generera låter den stå."],
    ["a lesson with an extra class", { isGenerated: true, extraGroupIds: ["8B"] }, "Låst för motorn: lektionen har en extra klass eller utvalda elever, och Generera låter den stå."],
    ["a lesson written from a förläggning", { isGenerated: true, isLocked: true, fromPlacement: true }, "Fri för motorn: nästa Generera skriver om lektionen ur sin förläggning."],
  ])("for %s", (_name, over, sentence) => {
    // The draft holds the lock the lesson has, as the dialog opens it.
    draw({ ...base, ...over } as MasterLesson, { isLocked: "isLocked" in over && over.isLocked === true });
    expect(screen.getByText(sentence)).toBeInTheDocument();
  });

  it("says nothing for a lesson read without the column", () => {
    draw(base);
    expect(screen.queryByText(/för motorn/)).toBeNull();
  });

  // The sentence sits under the lock's own switch and says what the save will leave: it follows the switch, not the lesson as it was read.
  it("follows the lock switch: a free lesson the reader locks is kept, and a locked one the reader unlocks is free", () => {
    const first = draw({ ...base, isGenerated: true }, { isLocked: true });
    expect(screen.getByText("Låst för motorn: Generera låter lektionen stå där den är.")).toBeInTheDocument();
    first.unmount();
    draw({ ...base, isGenerated: true, isLocked: true }, { isLocked: false });
    expect(screen.getByText("Fri för motorn: nästa Generera lägger om lektionen.")).toBeInTheDocument();
  });

  // L-3 (granskaren g511). The sentence says what Spara leaves, and Spara hands a generated lesson over when it writes other weeks and locks a
  // lesson it moves: "Fri för motorn" under either was a promise the save broke.
  it("says a generated lesson whose weeks the reader changes is kept, and that a restated window is not a change", () => {
    const lesson = { ...base, isGenerated: true } as MasterLesson;
    const same = draw(lesson, { recurrence: "ALL_WEEKS", startDate: "", endDate: "" });
    expect(screen.getByText("Fri för motorn: nästa Generera lägger om lektionen.")).toBeInTheDocument();
    same.unmount();
    for (const over of [{ recurrence: "ODD_WEEKS" as const }, { startDate: "2026-09-07" }, { endDate: "2026-12-18" }]) {
      const changed = draw(lesson, over);
      expect(screen.getByText("Låst för motorn: andra veckor gör lektionen handgjord, och Generera låter den stå.")).toBeInTheDocument();
      expect(screen.queryByText(/Fri för motorn/)).toBeNull();
      changed.unmount();
    }
  });

  it("says a generated lesson the reader moves is locked by Spara, and that one the reader unlocks in the same save stays free", () => {
    const lesson = { ...base, isGenerated: true } as MasterLesson;
    for (const over of [{ dayOfWeek: "2" }, { startTime: "13:00" }, { endTime: "16:00" }]) {
      const moved = draw(lesson, over);
      expect(screen.getByText("Låst för motorn: Spara låser en flyttad lektion, och Generera låter den stå där du lägger den.")).toBeInTheDocument();
      moved.unmount();
    }
    draw({ ...lesson, isLocked: true }, { isLocked: false, dayOfWeek: "2" });
    expect(screen.getByText("Fri för motorn: nästa Generera lägger om lektionen.")).toBeInTheDocument();
  });

  it("says a lesson made by hand is kept whichever way the switch stands", () => {
    draw({ ...base, isGenerated: false }, { isLocked: false });
    expect(screen.getByText("Låst för motorn: lektionen är handgjord, och Generera låter den stå.")).toBeInTheDocument();
  });
});
