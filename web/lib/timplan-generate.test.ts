import { describe, expect, it } from "vitest";
import {
  DEFAULT_LESSON_MINUTES,
  editedRow,
  lessonLengthProblem,
  overridesFrom,
  parseLessons,
  rowKey,
  suggestLessonLength,
  type GenerateProposedRow,
  type RowEdit,
} from "./timplan-generate";

const row = (overrides: Partial<GenerateProposedRow> = {}): GenerateProposedRow => ({
  studentGroupId: "g-7a",
  groupName: "7A",
  subjectId: "s-ma",
  subjectName: "Matematik",
  gradeLevel: 7,
  targetMinutesPerWeek: 175,
  lessonsPerWeek: 3,
  minutesPerLesson: 60,
  plannedMinutesPerWeek: 180,
  surplusMinutesPerWeek: 5,
  overridden: false,
  capped: false,
  ...overrides,
});

describe("suggestLessonLength", () => {
  it("is 60 for a year without posts", () => {
    expect(suggestLessonLength([])).toBe(DEFAULT_LESSON_MINUTES);
  });

  it("is the length the year's posts use most", () => {
    expect(
      suggestLessonLength([{ minutesPerLesson: 50 }, { minutesPerLesson: 50 }, { minutesPerLesson: 60 }]),
    ).toBe(50);
  });

  it("breaks a tie towards the shorter length, which overshoots a target by less", () => {
    expect(suggestLessonLength([{ minutesPerLesson: 60 }, { minutesPerLesson: 40 }])).toBe(40);
  });

  it("never suggests a length the gateway would refuse", () => {
    expect(suggestLessonLength([{ minutesPerLesson: 47 }, { minutesPerLesson: 47 }, { minutesPerLesson: 300 }])).toBe(
      DEFAULT_LESSON_MINUTES,
    );
  });
});

describe("lessonLengthProblem and parseLessons: the DTO's bounds", () => {
  it.each([
    ["60", null],
    [" 45 ", null],
    ["15", null],
    ["240", null],
    ["", "integer"],
    ["4,5", "integer"],
    ["-5", "integer"],
    ["10", "range"],
    ["245", "range"],
    ["47", "grid"],
  ])("%j → %s", (text, problem) => {
    expect(lessonLengthProblem(text)).toBe(problem);
  });

  it("takes 1..40 lessons and nothing else", () => {
    expect(parseLessons("1")).toBe(1);
    expect(parseLessons("40")).toBe(40);
    expect(parseLessons("0")).toBeNull();
    expect(parseLessons("41")).toBeNull();
    expect(parseLessons("2.5")).toBeNull();
  });
});

describe("editedRow and overridesFrom", () => {
  it("an untouched row is the gateway's proposal: 175 as 3 × 60 is +5", () => {
    expect(editedRow(row(), undefined)).toEqual({
      lessons: 3,
      minutes: 60,
      planned: 180,
      surplus: 5,
      changed: false,
    });
  });

  it("recomputes the surplus of an edited row against the target", () => {
    expect(editedRow(row(), { lessons: "5", minutes: "35" })).toMatchObject({
      planned: 175,
      surplus: 0,
      changed: true,
    });
    expect(editedRow(row(), { lessons: "2", minutes: "60" })).toMatchObject({ surplus: -55 });
  });

  it("an edit typed back to the proposal is not a change", () => {
    expect(editedRow(row(), { lessons: " 3", minutes: "60 " }).changed).toBe(false);
  });

  it("sends the changed rows only", () => {
    const rows = [row(), row({ subjectId: "s-sv", subjectName: "Svenska" })];
    const edits = new Map<string, RowEdit>([
      [rowKey(rows[0]!), { lessons: "3", minutes: "60" }],
      [rowKey(rows[1]!), { lessons: "4", minutes: "45" }],
    ]);
    expect(overridesFrom(rows, edits)).toEqual([
      { studentGroupId: "g-7a", subjectId: "s-sv", lessonsPerWeek: 4, minutesPerLesson: 45 },
    ]);
  });

  it("is null while any row holds a figure the gateway refuses", () => {
    const rows = [row()];
    expect(overridesFrom(rows, new Map([[rowKey(rows[0]!), { lessons: "3", minutes: "62" }]]))).toBeNull();
    expect(overridesFrom(rows, new Map([[rowKey(rows[0]!), { lessons: "41", minutes: "60" }]]))).toBeNull();
  });
});
