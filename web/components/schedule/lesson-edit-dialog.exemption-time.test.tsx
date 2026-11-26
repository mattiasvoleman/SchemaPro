import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { MasterLesson } from "@/lib/types";
import { LessonEditDialog, type LessonEditDraft } from "./lesson-edit-dialog";

/*
 * UNDANTAG MED FLIT is for the time it was given for. The gateway says so (another time that breaks the rule asks again), and so does the
 * question's own sentence. The dialog holds the answer in its draft, and a change of the time must not carry it to the new time unasked.
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
const exempt = { ...base, isLocked: true, exemptFrom: ["FRAME" as const] } as MasterLesson;
const atBase: LessonEditDraft = {
  dayOfWeek: "1",
  startTime: "14:30",
  endTime: "15:30",
  roomId: NONE,
  teacherId: "anna",
  isLocked: false,
  recurrence: "ALL_WEEKS",
  startDate: "",
  endDate: "",
};

const draw = (lesson: MasterLesson, draft: LessonEditDraft) => {
  const changed = vi.fn();
  render(
    <LessonEditDialog
      open
      lesson={lesson}
      onOpenChange={() => {}}
      lessonName="Matematik 7A"
      draft={draft}
      onDraftChange={changed}
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
  return changed;
};

describe("an exemption is for the time it was given for", () => {
  it("lets go of the lesson's exemption when the clock is changed, so that the new time is asked again, and the lock stays as the lesson has it", () => {
    const changed = draw(exempt, { ...atBase, isLocked: true, exempt: ["FRAME"] });
    fireEvent.change(screen.getByLabelText("Slut"), { target: { value: "15:45" } });
    expect(changed).toHaveBeenCalledWith({ ...atBase, endTime: "15:45", isLocked: true, exempt: [] });
  });

  it("lets go of an answer yes given for another time when the clock moves on, and gives the lock back as the lesson had it", () => {
    // "Lägg ändå" was answered for 15:45; the end is then moved to 16:00: the 15:45 yes is not 16:00's.
    const changed = draw(base, { ...atBase, endTime: "15:45", isLocked: true, exempt: ["FRAME"] });
    fireEvent.change(screen.getByLabelText("Slut"), { target: { value: "16:00" } });
    expect(changed).toHaveBeenCalledWith({ ...atBase, endTime: "16:00", isLocked: false, exempt: [] });
  });

  it("gives the lesson's own exemption back when the time comes back to the lesson's own", () => {
    const changed = draw(exempt, { ...atBase, endTime: "15:45", isLocked: true, exempt: ["LUNCH"] });
    fireEvent.change(screen.getByLabelText("Slut"), { target: { value: "15:30" } });
    expect(changed).toHaveBeenCalledWith({ ...atBase, isLocked: true, exempt: ["FRAME"] });
  });

  it("says nothing of an exemption in the draft that has none, and leaves a change of the clock as it was", () => {
    const changed = draw(base, atBase);
    fireEvent.change(screen.getByLabelText("Slut"), { target: { value: "15:45" } });
    expect(changed).toHaveBeenCalledWith({ ...atBase, endTime: "15:45" });
  });
});
