import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CreateLessonDialog, type CreateDraft } from "./create-lesson-dialog";
import { LessonEditDialog, type LessonEditDraft } from "./lesson-edit-dialog";

vi.mock("next-intl", () => ({
  // DateField reads the active locale for its month and weekday names.
  useLocale: () => "sv",
  useTranslations: () => (key: string) => key,
}));

/**
 * Every control in Lägg till lektion and Justera lektion, named by the label
 * printed above or beside it.
 *
 * A Radix Select trigger is a button, and a Label beside it names nothing
 * unless it points at the trigger's id. The lock Switch's title was a plain
 * div. A screen reader stepping through either dialog heard the value —
 * "Måndag", "Ingen sal" — or nothing, never the question.
 */

const NONE = "__none__";

const createDraft: CreateDraft = {
  subjectId: "",
  studentGroupId: "",
  extraGroupIds: [],
  studentIds: [],
  dayOfWeek: "1",
  startTime: "08:00",
  endTime: "09:00",
  roomId: NONE,
  teacherId: NONE,
  isLocked: false,
  recurrence: "ALL_WEEKS",
  startDate: "",
  endDate: "",
};

const editDraft: LessonEditDraft = {
  dayOfWeek: "1",
  startTime: "08:00",
  endTime: "09:00",
  roomId: NONE,
  teacherId: NONE,
  isLocked: true,
  recurrence: "ALL_WEEKS",
  startDate: "",
  endDate: "",
};

const renderCreate = () =>
  render(
    <CreateLessonDialog
      draft={createDraft}
      onDraftChange={vi.fn()}
      onClose={vi.fn()}
      subjects={[]}
      groups={[]}
      rooms={[]}
      teachers={[]}
      students={[]}
      groupById={new Map()}
      teacherById={new Map()}
      slotMatches={null}
      onSlotMatchesChange={vi.fn()}
      onSearchSlots={vi.fn()}
      onCreate={vi.fn()}
      pending={false}
      none={NONE}
    />,
  );

const renderEdit = () =>
  render(
    <LessonEditDialog
      open
      onOpenChange={vi.fn()}
      lessonName="Matematik · 7A"
      draft={editDraft}
      onDraftChange={vi.fn()}
      rooms={[]}
      teachers={[]}
      onDelete={vi.fn()}
      deletePending={false}
      onDuplicate={vi.fn()}
      onPark={vi.fn()}
      onCancel={vi.fn()}
      onSave={vi.fn()}
      savePending={false}
      none={NONE}
    />,
  );

describe.each([
  [
    "Lägg till lektion",
    renderCreate,
    ["addSubject", "addGroup", "editDay", "editRoom", "editTeacher", "recurrenceLabel"],
  ],
  ["Justera lektion", renderEdit, ["editDay", "editRoom", "editTeacher", "recurrenceLabel"]],
] as const)("%s", (_, renderDialog, pickers) => {
  it("names every picker by its label", () => {
    renderDialog();
    for (const name of pickers) {
      expect(screen.getByRole("combobox", { name })).toBeInTheDocument();
    }
  });

  it("names the lock switch by its label, and describes it by its hint", () => {
    renderDialog();
    expect(screen.getByRole("switch", { name: "lockLabel" })).toHaveAccessibleDescription(
      "lockHint",
    );
  });

  it("names the date fields by their labels", () => {
    // Already true before the pickers were fixed: the walkthrough's tree
    // reader printed the placeholder (åååå-mm-dd) before the label, but the
    // inputs have had a <label for> all along. Kept so that stays so.
    renderDialog();
    expect(screen.getByRole("textbox", { name: "periodFrom" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "periodTo" })).toBeInTheDocument();
  });
});
