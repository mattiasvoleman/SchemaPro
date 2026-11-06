import { describe, expect, it } from "vitest";
import { callState, groupsInOrder, isDone, liveFigures, pupilsToFind, silentTeachers } from "./crisis-live";
import { call, noLessonCall, pupil, teacher } from "./__fixtures__/crisis";

const ANNA = teacher("t-anna", "Anna Berg");
const BO = teacher("t-bo", "Bo Ek");
const ANSWERED = teacher("t-cia", "Cia Dahl", "2027-01-12T09:18:00.000Z");

/** 7A: one found, one missing, one nobody has marked, one absent before. */
const sevenA = call(
  "c-7a",
  "7A",
  [pupil("s1", "Ines", "Ek", "FOUND"), pupil("s2", "Jamal", "Ali", "MISSING"), pupil("s3", "Klara", "Nyman"), pupil("s4", "Leo", "Berg", "ABSENT_BEFORE")],
  { teachers: [ANNA] },
);
/** 7B: all marked. */
const sevenB = call("c-7b", "7B", [pupil("s5", "Maja", "Ek", "FOUND"), pupil("s6", "Nils", "Ek", "FOUND")], { teachers: [ANSWERED] });
/** 8A: nobody answers for it. */
const eightA = call("c-8a", "8A", [pupil("s7", "Olle", "Lind"), pupil("s8", "Pia", "Lind")], {
  teachers: [teacher(null, null)],
});

describe("where a group stands", () => {
  it("is done when everyone expected has a mark, and says if any are missing", () => {
    expect(callState(sevenB)).toBe("DONE");
    expect(callState(call("c", "9A", [pupil("a", "A", "A", "FOUND"), pupil("b", "B", "B", "MISSING")]))).toBe("DONE_MISSING");
  });

  it("is in progress once someone is marked, and waiting before", () => {
    expect(callState(sevenA)).toBe("IN_PROGRESS");
    expect(callState(eightA)).toBe("WAITING");
  });

  it("counts a group with nobody left to ask (everyone absent before) as done", () => {
    expect(callState(call("c", "9B", [pupil("a", "A", "A", "ABSENT_BEFORE")]))).toBe("DONE");
  });
});

describe("the live figures", () => {
  it("are worked out from the groups: pupils, groups done and the teachers who owe nothing", () => {
    expect(liveFigures([sevenA, sevenB, eightA])).toEqual({
      groupsDone: 1,
      groups: 3,
      pupils: 8,
      found: 3,
      missing: 1,
      unreported: 3,
      absentBefore: 1,
      // Anna (7A) has marked nobody; Cia (7B) has answered; 8A has no teacher.
      teachersAnswered: 1,
      teachers: 2,
    });
  });

  it("are zeros for an alarm with no groups, not a missing figure", () => {
    expect(liveFigures([])).toMatchObject({ groupsDone: 0, groups: 0, pupils: 0, teachers: 0, teachersAnswered: 0 });
  });
});

describe("the teachers who have not answered", () => {
  it("are those with a group still to ask after and no mark of their own, each once with their groups", () => {
    const second = call("c-7c", "7C", [pupil("s9", "Rut", "Ek")], { teachers: [ANNA, BO] });
    expect(silentTeachers([sevenA, sevenB, eightA, second])).toEqual([
      { userId: "t-anna", name: "Anna Berg", groups: ["7A", "7C"] },
      { userId: "t-bo", name: "Bo Ek", groups: ["7C"] },
    ]);
  });

  it("are released by a colleague's or the administration's marks that finish the group", () => {
    const finished = call("c-7a", "7A", [pupil("s1", "Ines", "Ek", "FOUND"), pupil("s2", "Jamal", "Ali", "FOUND")], { teachers: [ANNA] });
    expect(silentTeachers([finished])).toEqual([]);
  });

  it("are nobody for a group nobody answers for", () => {
    expect(silentTeachers([eightA])).toEqual([]);
  });
});

describe("the pupils still to find", () => {
  it("are the missing first and then the unreported, each by group and name, and never the found or the absent", () => {
    const rows = pupilsToFind([sevenA, sevenB, eightA]);
    expect(rows.map((row) => [row.pupil.status, row.groupName, row.pupil.firstName])).toEqual([
      ["MISSING", "7A", "Jamal"],
      ["UNREPORTED", "7A", "Klara"],
      ["UNREPORTED", "8A", "Olle"],
      ["UNREPORTED", "8A", "Pia"],
    ]);
  });

  it("carry who answers for the group, for the administration to ask", () => {
    expect(pupilsToFind([sevenA])[0]).toMatchObject({ callId: "c-7a", teachers: ["Anna Berg"], subjectName: "Matematik", roomName: "Sal 12" });
    expect(pupilsToFind([eightA])[0]?.teachers).toEqual([]);
  });
});

describe("the group of pupils on no lesson", () => {
  // Three pupils on no lesson's list: one found by the administration, one missing, one nobody has said anything about.
  const nobody = noLessonCall("c-none", [pupil("s20", "Åsa", "Berg", "FOUND"), pupil("s21", "Bengt", "Ek", "MISSING"), pupil("s22", "Cecilia", "Ek")]);

  it("is listed first, and the others keep the order the gateway gave", () => {
    expect(groupsInOrder([sevenA, eightA, nobody, sevenB]).map((one) => one.id)).toEqual(["c-none", "c-7a", "c-8a", "c-7b"]);
    expect(groupsInOrder([sevenA, sevenB]).map((one) => one.id)).toEqual(["c-7a", "c-7b"]);
  });

  it("is counted in the figures like any group: its pupils, its marks, and that it is not done while one is unreported", () => {
    const figures = liveFigures([sevenA, nobody]);
    expect(figures.groups).toBe(2);
    expect(figures.pupils).toBe(7);
    expect(figures.found).toBe(2);
    expect(figures.missing).toBe(2);
    expect(figures.unreported).toBe(2);
    expect(isDone(nobody)).toBe(false);
    expect(callState(nobody)).toBe("IN_PROGRESS");
    // Nobody answers for it, so no teacher is waited for because of it.
    expect(silentTeachers([nobody])).toEqual([]);
    expect(figures.teachers).toBe(1);
  });

  it("puts its pupils first among the pupils still to find of the same kind, and says which group they are on", () => {
    const rows = pupilsToFind([sevenA, eightA, nobody]);
    expect(rows.map((row) => [row.pupil.status, row.basis, row.pupil.firstName])).toEqual([
      ["MISSING", "NO_LESSON", "Bengt"],
      ["MISSING", "LESSON", "Jamal"],
      ["UNREPORTED", "NO_LESSON", "Cecilia"],
      ["UNREPORTED", "LESSON", "Klara"],
      ["UNREPORTED", "LESSON", "Olle"],
      ["UNREPORTED", "LESSON", "Pia"],
    ]);
    expect(rows[0]!.teachers).toEqual([]);
  });
});
