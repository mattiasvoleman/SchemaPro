import { describe, expect, it } from "vitest";
import {
  EMPTY_EXAM_FORM,
  applyItems,
  examInput,
  examProblems,
  formOfExam,
  formOfSettings,
  placedByDay,
  settingsInput,
  settingsProblems,
  validSeats,
  wholeIn,
  type ExamForm,
} from "@/lib/exam-form";
import type { Exam, ExamProposal, ExamSettings } from "@/lib/exam-types";

const YEAR = { startDate: "2026-08-17", endDate: "2027-06-11" };
const GROUPS = new Set(["g-9a", "g-9b"]);

const WEEK: ExamForm = {
  ...EMPTY_EXAM_FORM,
  name: "  Matematik, algebra ",
  subjectId: "s-ma",
  groupIds: ["g-9a", "g-9b"],
  lengthMinutes: "80",
  writers: "56",
  from: "2026-11-09",
  to: "2026-11-13",
  earliestStart: "08:30",
  latestEnd: "15:00",
};
const FIXED: ExamForm = {
  ...EMPTY_EXAM_FORM,
  name: "Nationellt prov",
  subjectId: "s-sv",
  groupIds: ["g-9a"],
  lengthMinutes: "120",
  writers: "27",
  windowKind: "FIXED",
  date: "2026-11-17",
  fixedStart: "08:30",
};

describe("wholeIn and validSeats", () => {
  it("take whole numbers inside the range and nothing else", () => {
    expect(wholeIn("5", 5, 10)).toBe(true);
    expect(wholeIn("10", 5, 10)).toBe(true);
    expect(wholeIn("4", 5, 10)).toBe(false);
    expect(wholeIn("11", 5, 10)).toBe(false);
    expect(wholeIn("", 0, 10)).toBe(false);
    expect(wholeIn("  ", 0, 10)).toBe(false);
    expect(wholeIn("2.5", 0, 10)).toBe(false);
    expect(wholeIn("abc", 0, 10)).toBe(false);
    expect(validSeats("24")).toBe(true);
    expect(validSeats("0")).toBe(false);
    expect(validSeats("2001")).toBe(false);
  });
});

describe("examProblems", () => {
  it("accepts a window and a fixed exam as the gateway does", () => {
    expect(examProblems(WEEK, YEAR, GROUPS)).toEqual([]);
    expect(examProblems(FIXED, YEAR, GROUPS)).toEqual([]);
  });

  it("names what is missing from an empty form", () => {
    expect(examProblems(EMPTY_EXAM_FORM, YEAR, GROUPS)).toEqual(["name", "subject", "groups", "length", "writers", "dates"]);
  });

  it("refuses a name that is too long, a class the year does not hold, and numbers outside their range", () => {
    expect(examProblems({ ...WEEK, name: "x".repeat(73) }, YEAR, GROUPS)).toEqual(["name"]);
    expect(examProblems({ ...WEEK, groupIds: ["g-9a", "g-gone"] }, YEAR, GROUPS)).toEqual(["groups"]);
    expect(examProblems({ ...WEEK, lengthMinutes: "4" }, YEAR, GROUPS)).toEqual(["length"]);
    expect(examProblems({ ...WEEK, lengthMinutes: "481" }, YEAR, GROUPS)).toEqual(["length"]);
    expect(examProblems({ ...WEEK, writers: "0" }, YEAR, GROUPS)).toEqual(["writers"]);
    expect(examProblems({ ...WEEK, writers: "2001" }, YEAR, GROUPS)).toEqual(["writers"]);
  });

  it("judges the window: order, the year and at most 31 days", () => {
    expect(examProblems({ ...WEEK, to: "2026-11-08" }, YEAR, GROUPS)).toEqual(["order"]);
    expect(examProblems({ ...WEEK, from: "2026-08-10", to: "2026-08-12" }, YEAR, GROUPS)).toEqual(["outsideYear"]);
    // Thirty-one days, both ends counted, is the most; the thirty-second is too many.
    expect(examProblems({ ...WEEK, from: "2026-11-01", to: "2026-12-02" }, YEAR, GROUPS)).toEqual(["tooLong"]);
    expect(examProblems({ ...WEEK, from: "2026-11-01", to: "2026-12-01" }, YEAR, GROUPS)).toEqual([]);
  });

  it("asks a fixed exam for a day inside the year and a start, and a window for limits in order", () => {
    expect(examProblems({ ...FIXED, fixedStart: "" }, YEAR, GROUPS)).toEqual(["fixedStart"]);
    expect(examProblems({ ...FIXED, date: "2027-06-12" }, YEAR, GROUPS)).toEqual(["outsideYear"]);
    expect(examProblems({ ...FIXED, date: "" }, YEAR, GROUPS)).toEqual(["dates"]);
    expect(examProblems({ ...WEEK, earliestStart: "15:00", latestEnd: "08:30" }, YEAR, GROUPS)).toEqual(["limits"]);
    expect(examProblems({ ...WEEK, earliestStart: "08:30", latestEnd: "" }, YEAR, GROUPS)).toEqual([]);
  });
});

describe("examInput", () => {
  it("sends a window with its limits and numbers as numbers", () => {
    expect(examInput(WEEK)).toEqual({
      subjectId: "s-ma",
      name: "Matematik, algebra",
      lengthMinutes: 80,
      writers: 56,
      windowKind: "WEEK",
      windowFrom: "2026-11-09",
      windowTo: "2026-11-13",
      earliestStart: "08:30",
      latestEnd: "15:00",
      groupIds: ["g-9a", "g-9b"],
    });
  });

  it("leaves out a limit that is empty, and sends a fixed exam as one day with its start", () => {
    expect(examInput({ ...WEEK, earliestStart: "", latestEnd: "" })).not.toHaveProperty("earliestStart");
    expect(examInput({ ...WEEK, earliestStart: "", latestEnd: "" })).not.toHaveProperty("latestEnd");
    const fixed = examInput({ ...FIXED, earliestStart: "08:00", latestEnd: "16:00" });
    expect(fixed).toMatchObject({ windowKind: "FIXED", windowFrom: "2026-11-17", windowTo: "2026-11-17", fixedStart: "08:30" });
    // The gateway refuses a fixed exam with daily limits.
    expect(fixed).not.toHaveProperty("earliestStart");
    expect(fixed).not.toHaveProperty("latestEnd");
  });
});

describe("formOfExam", () => {
  const exam = {
    id: "e-1",
    subjectId: "s-ma",
    name: "Matematik",
    lengthMinutes: 80,
    writers: 56,
    windowKind: "WEEK",
    windowFrom: "2026-11-09",
    windowTo: "2026-11-13",
    fixedStart: null,
    earliestStart: "08:30",
    latestEnd: null,
    groups: [
      { id: "g-9a", name: "9A" },
      { id: "g-gone", name: "9X" },
    ],
  } as unknown as Exam;

  it("opens a change on the exam, leaving out a class the year no longer holds", () => {
    expect(formOfExam(exam, GROUPS)).toEqual({
      name: "Matematik",
      subjectId: "s-ma",
      groupIds: ["g-9a"],
      lengthMinutes: "80",
      writers: "56",
      windowKind: "WEEK",
      from: "2026-11-09",
      to: "2026-11-13",
      date: "",
      fixedStart: "",
      earliestStart: "08:30",
      latestEnd: "",
    });
  });

  it("puts a fixed exam's day in the day field", () => {
    const fixed = formOfExam({ ...exam, windowKind: "FIXED", windowFrom: "2026-11-17", windowTo: "2026-11-17", fixedStart: "08:30", earliestStart: null }, GROUPS);
    expect(fixed).toMatchObject({ windowKind: "FIXED", date: "2026-11-17", fixedStart: "08:30", from: "", to: "" });
  });
});

describe("settings", () => {
  const settings: ExamSettings = {
    enabled: true,
    maxPerClassPerDay: 1,
    maxPerClassPerWeek: 3,
    writersPerInvigilator: 30,
    turnoverMinutes: 10,
    replacementSubject: { id: "s-prov", name: "Prov" },
  };

  it("round-trips the saved settings through the form", () => {
    expect(settingsInput(formOfSettings(settings))).toEqual({
      enabled: true,
      maxPerClassPerDay: 1,
      maxPerClassPerWeek: 3,
      writersPerInvigilator: 30,
      turnoverMinutes: 10,
      replacementSubjectId: "s-prov",
    });
    expect(settingsInput(formOfSettings({ ...settings, replacementSubject: null })).replacementSubjectId).toBeNull();
  });

  it("names what the gateway would refuse", () => {
    const form = formOfSettings(settings);
    expect(settingsProblems(form)).toEqual([]);
    expect(settingsProblems({ ...form, maxPerClassPerDay: "0" })).toEqual(["day"]);
    expect(settingsProblems({ ...form, maxPerClassPerWeek: "31" })).toEqual(["week"]);
    expect(settingsProblems({ ...form, maxPerClassPerDay: "4", maxPerClassPerWeek: "3" })).toEqual(["order"]);
    expect(settingsProblems({ ...form, writersPerInvigilator: "201" })).toEqual(["ratio"]);
    expect(settingsProblems({ ...form, turnoverMinutes: "-1" })).toEqual(["turnover"]);
    expect(settingsProblems({ ...form, turnoverMinutes: "0" })).toEqual([]);
  });
});

describe("the proposal", () => {
  const room = (roomId: string, writers: number, teacherIds: string[]) => ({
    roomId,
    roomName: roomId,
    writers,
    classes: ["9A"],
    invigilators: teacherIds.map((teacherId) => ({ teacherId, name: teacherId })),
  });
  const exam = (examId: string, date: string, start: string) => ({
    examId,
    name: examId,
    version: `v-${examId}`,
    date,
    start,
    end: "10:00",
    loss: 0,
    rooms: [room("r-1", 28, ["t-1"]), room("r-2", 28, ["t-2", "t-3"])],
  });
  const proposal = {
    status: "OPTIMAL",
    placed: [exam("a", "2026-11-09", "08:00"), exam("b", "2026-11-09", "10:00"), exam("c", "2026-11-11", "08:00")],
    unplaced: [],
    counter: [],
    metrics: null,
  } as ExamProposal;

  it("groups the placed exams by day in the order given", () => {
    expect(placedByDay(proposal.placed).map((day) => [day.date, day.exams.map((one) => one.examId)])).toEqual([
      ["2026-11-09", ["a", "b"]],
      ["2026-11-11", ["c"]],
    ]);
    expect(placedByDay([])).toEqual([]);
  });

  it("sends back exactly what the proposal gave for the chosen exams, in its order", () => {
    expect(applyItems(proposal, new Set(["c", "a"]))).toEqual([
      {
        examId: "a",
        examVersion: "v-a",
        date: "2026-11-09",
        start: "08:00",
        rooms: [
          { roomId: "r-1", writers: 28, teacherIds: ["t-1"] },
          { roomId: "r-2", writers: 28, teacherIds: ["t-2", "t-3"] },
        ],
      },
      {
        examId: "c",
        examVersion: "v-c",
        date: "2026-11-11",
        start: "08:00",
        rooms: [
          { roomId: "r-1", writers: 28, teacherIds: ["t-1"] },
          { roomId: "r-2", writers: 28, teacherIds: ["t-2", "t-3"] },
        ],
      },
    ]);
    expect(applyItems(proposal, new Set())).toEqual([]);
  });
});
