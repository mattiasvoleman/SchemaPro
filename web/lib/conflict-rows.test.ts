import { createTranslator } from "use-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import type { ProblemLookup } from "@/lib/api-error-text";
import { detectConflicts } from "@/lib/conflicts";
import { problemSentence } from "@/lib/problem-codes";
import type { MasterLesson } from "@/lib/types";
import { conflictRows, type ConflictNames } from "./conflict-rows";

const lesson = (id: string, overrides: Partial<MasterLesson>): MasterLesson => ({
  id,
  academicYearId: "y1",
  subjectId: "Ma",
  studentGroupId: "7A",
  teacherId: null,
  coTeacherId: null,
  roomId: null,
  dayOfWeek: 1,
  startTime: "10:00:00",
  endTime: "11:00:00",
  isLocked: false,
  isParked: false,
  recurrence: "ALL_WEEKS",
  startDate: null,
  endDate: null,
  extraGroupIds: [],
  studentIds: [],
  ...overrides,
});

const NAMES: Record<string, string> = { Ma: "Matematik", Ke: "Kemi", "7A": "7A", "8B": "8B" };
const names: ConflictNames = { group: (id) => NAMES[id] ?? id, subject: (id) => NAMES[id] ?? id };

const swedish = createTranslator({ locale: "sv", messages: sv, namespace: "common" }) as unknown as ProblemLookup;
const english = createTranslator({ locale: "en", messages: en, namespace: "common" }) as unknown as ProblemLookup;

describe("the rows of the krocklista", () => {
  // Matematik 7A (Anna, sal 1) Monday 10:00-11:00 and Kemi 8B (Anna, sal 1) 10:30-11:30: one clash of the teacher and the room, seen from both.
  const a = lesson("a", { teacherId: "anna", roomId: "r1" });
  const b = lesson("b", { subjectId: "Ke", studentGroupId: "8B", teacherId: "anna", roomId: "r1", startTime: "10:30:00", endTime: "11:30:00" });
  const lessonById = new Map([a, b].map((entry) => [entry.id, entry]));
  const conflictMap = detectConflicts([a, b], []);

  it("has a row for each lesson that clashes, each saying what it clashes with by class, subject, day and time", () => {
    const rows = conflictRows(conflictMap, lessonById, names);
    expect(rows.map((row) => row.lesson.id)).toEqual(["a", "b"]);
    expect(rows[0]!.reasons.map((reason) => reason.kind)).toEqual(["TEACHER", "ROOM"]);
    const sentences = rows[0]!.reasons.map((reason) => problemSentence("MASTER_LESSON_REFUSED", reason.values, swedish));
    // The sentence the refusal of a save is said in, with the OTHER lesson named: Matematik's row names Kemi, and Kemi's row names Matematik.
    expect(sentences).toEqual(["Läraren har redan Kemi med 8B, måndag 10:30–11:30.", "Salen är redan upptagen av Kemi med 8B, måndag 10:30–11:30."]);
    expect(rows[1]!.reasons.map((reason) => problemSentence("MASTER_LESSON_REFUSED", reason.values, english))).toEqual([
      "The teacher already has Matematik with 7A, Monday 10:00–11:00.",
      "The room is already taken by Matematik with 7A, Monday 10:00–11:00.",
    ]);
  });

  it("has no row for a week with no clash", () => {
    expect(conflictRows(new Map(), lessonById, names)).toEqual([]);
    expect(conflictRows(detectConflicts([a], []), lessonById, names)).toEqual([]);
  });

  it("orders the week by day, then clock, then class", () => {
    const early = lesson("early", { dayOfWeek: 1, startTime: "08:00:00", endTime: "09:00:00", teacherId: "bo" });
    const early2 = lesson("early2", { dayOfWeek: 1, startTime: "08:30:00", endTime: "09:30:00", teacherId: "bo", studentGroupId: "8B" });
    // Wednesday's hour starts earlier on the clock than Monday's: the day comes first.
    const late = lesson("late", { dayOfWeek: 3, teacherId: "cy", startTime: "07:00:00", endTime: "08:00:00" });
    const late2 = lesson("late2", { dayOfWeek: 3, teacherId: "cy", studentGroupId: "8B", startTime: "07:00:00", endTime: "08:00:00" });
    const all = [late, late2, early2, early];
    const rows = conflictRows(detectConflicts(all, []), new Map(all.map((entry) => [entry.id, entry])), names);
    expect(rows.map((row) => row.lesson.id)).toEqual(["early", "early2", "late", "late2"]);
  });

  it("says a clash only the pupils' ombyte made as that, with the other lesson named", () => {
    const rows = conflictRows(
      new Map([["a", [{ kind: "GROUP" as const, otherLessonId: "b", pupilBufferOnly: true as const }]]]),
      lessonById,
      names,
    );
    expect(problemSentence("MASTER_LESSON_REFUSED", rows[0]!.reasons[0]!.values, swedish)).toBe(
      "Klassen är upptagen med ombyte eller dusch kring Kemi med 8B, måndag 10:30–11:30.",
    );
  });

  it("says the closed hours and the board's rules with no other lesson, and the room lock as the list's own", () => {
    const rows = conflictRows(
      new Map([
        ["a", [{ kind: "FRAME" as const }, { kind: "LUNCH" as const }, { kind: "AVAILABILITY" as const }, { kind: "ROOM_LOCK" as const }]],
      ]),
      lessonById,
      names,
    );
    expect(rows[0]!.reasons.map((reason) => (reason.values ? problemSentence("MASTER_LESSON_REFUSED", reason.values, swedish) : null))).toEqual([
      "Tiden ligger utanför ramtiden för klassens stadium.",
      "Tiden ligger på klassens lunch.",
      "Läraren, salen eller klassen är markerad som inte tillgänglig då.",
      null,
    ]);
  });

  it("tells a clash with the same lesson once, and skips a lesson the page no longer holds", () => {
    const rows = conflictRows(
      new Map([
        ["a", [{ kind: "TEACHER" as const, otherLessonId: "b" }, { kind: "TEACHER" as const, otherLessonId: "b" }]],
        ["gone", [{ kind: "LUNCH" as const }]],
      ]),
      lessonById,
      names,
    );
    expect(rows.map((row) => [row.lesson.id, row.reasons.length])).toEqual([["a", 1]]);
  });
});
