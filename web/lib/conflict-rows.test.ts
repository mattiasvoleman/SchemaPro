import { createTranslator } from "use-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import type { ProblemLookup } from "@/lib/api-error-text";
import { detectConflicts } from "@/lib/conflicts";
import type { AvailabilityConstraint } from "@/lib/types";
import { problemSentence } from "@/lib/problem-codes";
import type { MasterLesson } from "@/lib/types";
import { conflictRows, reasonSentences, type ConflictNames } from "./conflict-rows";

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

  describe("a closed hour, said by whose it is (the judge's own words)", () => {
    const row = (overrides: Partial<AvailabilityConstraint>): AvailabilityConstraint => ({
      id: "c",
      resourceType: "TEACHER",
      userId: "anna",
      roomId: null,
      studentGroupId: null,
      minGradeLevel: null,
      maxGradeLevel: null,
      dayOfWeek: 1,
      date: null,
      startTime: "09:00",
      endTime: "12:00",
      type: "UNAVAILABLE",
      reason: null,
      ...overrides,
    });
    const own = lesson("own", { teacherId: "anna", roomId: "r1" });
    const said = (constraints: AvailabilityConstraint[], spans?: Map<string, { min: number; max: number }>) => {
      const map = detectConflicts([own], constraints, undefined, undefined, spans as never);
      return conflictRows(map, new Map([["own", own]]), names, { constraints, gradeSpanOf: spans as never })[0]!.reasons.map((reason) =>
        problemSentence("MASTER_LESSON_REFUSED", reason.values, swedish),
      );
    };

    it("says the teacher's, the room's and the class's own row for what it is, one sentence for each row that closes the hour", () => {
      expect(
        said([
          row({ id: "t" }),
          row({ id: "r", resourceType: "ROOM", userId: null, roomId: "r1" }),
          row({ id: "g", resourceType: "STUDENT_GROUP", userId: null, studentGroupId: "7A" }),
        ]),
      ).toEqual(["Läraren är markerad som inte tillgänglig då.", "Salen är markerad som inte tillgänglig då.", "Klassen är markerad som inte tillgänglig då."]);
    });

    it("says a rule on whole årskurser as the judge does: the time is closed to the year", () => {
      const year = row({ id: "y", resourceType: "GRADE_LEVEL", userId: null, minGradeLevel: 7, maxGradeLevel: 7 });
      expect(said([year], new Map([["7A", { min: 7, max: 7 }]]))).toEqual(["Tiden är stängd för klassens årskurs."]);
    });

    it("says the general sentence when it is not told the rows", () => {
      const map = detectConflicts([own], [row({ id: "t" })]);
      const reasons = conflictRows(map, new Map([["own", own]]), names)[0]!.reasons;
      expect(reasons.map((reason) => problemSentence("MASTER_LESSON_REFUSED", reason.values, swedish))).toEqual([
        "Läraren, salen eller klassen är markerad som inte tillgänglig då.",
      ]);
    });
  });

  it("says a clash of classes that share no class as the pupils', and a clash of one class as the class's", () => {
    // 8B's lesson and 7A's: no class in common, so what they share is pupils. An extra class in common makes it the class's.
    const sameClass = lesson("c", { subjectId: "Ke", studentGroupId: "8B", extraGroupIds: ["7A"], startTime: "10:30:00", endTime: "11:30:00" });
    const all = new Map([a, b, sameClass].map((entry) => [entry.id, entry]));
    const rows = conflictRows(
      new Map([["a", [{ kind: "GROUP" as const, otherLessonId: "b" }, { kind: "GROUP" as const, otherLessonId: "c" }]]]),
      all,
      names,
    );
    expect(rows[0]!.reasons.map((reason) => problemSentence("MASTER_LESSON_REFUSED", reason.values, swedish))).toEqual([
      "Elever i klassen är också med i en annan grupp som har Kemi med 8B, måndag 10:30–11:30.",
      "Klassen har redan Kemi med 8B, måndag 10:30–11:30.",
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

describe("the sentences of a lesson's reasons (the list's rows and the grid's cards)", () => {
  const a = lesson("a", { teacherId: "anna" });
  const b = lesson("b", { subjectId: "Ke", studentGroupId: "8B", teacherId: "anna", startTime: "10:30:00", endTime: "11:30:00" });
  const byId = new Map([a, b].map((entry) => [entry.id, entry]));

  it("says each reason in the refusal's sentence, the room's lock in the page's own, and leaves out a reason that has no sentence", () => {
    const rows = conflictRows(
      new Map([["a", [{ kind: "TEACHER" as const, otherLessonId: "b" }, { kind: "FRAME" as const }, { kind: "ROOM_LOCK" as const }]]]),
      byId,
      names,
    );
    expect(reasonSentences(rows[0]!.reasons, "Salen är låst.", swedish)).toEqual([
      "Läraren har redan Kemi med 8B, måndag 10:30–11:30.",
      "Tiden ligger utanför ramtiden för klassens stadium.",
      "Salen är låst.",
    ]);
    // The other lesson's class has no name here (a class the page holds no name for): the sentence of a clash cannot be written, and is
    // not written as "Läraren har redan  med , dag …" or as an empty point in a list.
    const unnamed = conflictRows(new Map([["a", [{ kind: "TEACHER" as const, otherLessonId: "b" }, { kind: "LUNCH" as const }]]]), byId, {
      group: () => "",
      subject: (id) => NAMES[id] ?? id,
    });
    expect(reasonSentences(unnamed[0]!.reasons, "x", swedish)).toEqual(["Tiden ligger på klassens lunch."]);
    expect(reasonSentences(unnamed[0]!.reasons.slice(0, 1), "x", swedish)).toEqual([]);
  });
});
