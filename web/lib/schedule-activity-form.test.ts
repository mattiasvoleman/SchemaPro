import { describe, expect, it } from "vitest";
import {
  EMPTY_ACTIVITY_FORM,
  activityProblems,
  formOfActivity,
  hasCreditsAhead,
  inputOf,
  ownerIdsOf,
  previewState,
  selectionOf,
  teachersOf,
  type ActivityForm,
  type OwnerGroup,
} from "@/lib/schedule-activity-form";
import type { ScheduleActivity } from "@/lib/schedule-activity-types";

const YEAR = { startDate: "2026-08-17", endDate: "2027-06-11" };
const GROUPS: OwnerGroup[] = [
  { id: "7a", kind: "CLASS", gradeLevel: 7, halfOfId: null },
  { id: "7b", kind: "CLASS", gradeLevel: 7, halfOfId: null },
  { id: "8a", kind: "CLASS", gradeLevel: 8, halfOfId: null },
  { id: "7a-1", kind: "CLASS", gradeLevel: 7, halfOfId: "7a" },
  { id: "sva7", kind: "TEACHING_GROUP", gradeLevel: null, halfOfId: null },
];
const form = (overrides: Partial<ActivityForm> = {}): ActivityForm => ({
  ...EMPTY_ACTIVITY_FORM,
  name: "Friluftsdag åk 7",
  fromDate: "2026-11-02",
  toDate: "2026-11-02",
  minGradeLevel: 7,
  maxGradeLevel: 7,
  replacementSubjectId: "tema",
  ...overrides,
});

describe("the activity form", () => {
  it("names what the gateway would refuse, beside the fields", () => {
    expect(activityProblems(form(), YEAR)).toEqual([]);
    expect(activityProblems(form({ name: "  " }), YEAR)).toEqual(["name"]);
    // 80, not the avbokning's 120: the name is also the name of each credit.
    expect(activityProblems(form({ name: "x".repeat(81) }), YEAR)).toEqual(["name"]);
    expect(activityProblems(form({ name: "x".repeat(80) }), YEAR)).toEqual([]);
    expect(activityProblems(form({ toDate: "" }), YEAR)).toEqual(["dates"]);
    expect(activityProblems(form({ fromDate: "2026-11-06", toDate: "2026-11-02" }), YEAR)).toEqual(["order"]);
    expect(activityProblems(form({ fromDate: "2026-08-10", toDate: "2026-08-20" }), YEAR)).toEqual(["outsideYear"]);
    expect(activityProblems(form({ toDate: "2026-12-03" }), YEAR)).toEqual(["tooLong"]);
    expect(activityProblems(form({ toDate: "2026-12-02" }), YEAR)).toEqual([]);
    expect(activityProblems(form({ startTime: "08:00" }), YEAR)).toEqual(["time"]);
    expect(activityProblems(form({ minGradeLevel: 9, maxGradeLevel: 7 }), YEAR)).toEqual(["grades"]);
    expect(activityProblems(form({ scope: "GROUPS" }), YEAR)).toEqual(["groups"]);
    expect(activityProblems(form({ replacementSubjectId: "" }), YEAR)).toEqual(["subject"]);
    expect(activityProblems(form({ description: "x".repeat(301) }), YEAR)).toEqual(["description"]);
  });

  it("holds credits to what the gateway takes: one line per subject, 1-600 minutes, whole days", () => {
    const row = (id: number, subjectId: string, minutes: string) => ({ id, subjectId, minutes });
    expect(activityProblems(form({ credits: [row(0, "idh", "300")] }), YEAR)).toEqual([]);
    expect(activityProblems(form({ credits: [row(0, "", "300")] }), YEAR)).toEqual(["creditSubject"]);
    expect(activityProblems(form({ credits: [row(0, "idh", "300"), row(1, "idh", "60")] }), YEAR)).toEqual([
      "creditDuplicate",
    ]);
    for (const minutes of ["", "0", "601", "1.5", "abc"]) {
      expect(activityProblems(form({ credits: [row(0, "idh", minutes)] }), YEAR)).toEqual(["creditMinutes"]);
    }
    expect(activityProblems(form({ credits: [row(0, "idh", "600")] }), YEAR)).toEqual([]);
    // A partly held day credited in full would count the morning twice.
    expect(
      activityProblems(form({ credits: [row(0, "idh", "300")], startTime: "08:00", endTime: "12:00" }), YEAR),
    ).toEqual(["creditPartialDay"]);
    const thirteen = Array.from({ length: 13 }, (_, index) => row(index, `s${index}`, "10"));
    expect(activityProblems(form({ credits: thirteen }), YEAR)).toEqual(["creditCount"]);
  });

  it("finds the classes that get a replacement lesson as the gateway does, so a stale pick is never sent", () => {
    expect([...ownerIdsOf(form({ scope: "GRADES", minGradeLevel: 7, maxGradeLevel: 7 }), GROUPS)].sort()).toEqual([
      "7a",
      "7b",
    ]);
    expect([...ownerIdsOf(form({ scope: "GRADES", minGradeLevel: 7, maxGradeLevel: 8 }), GROUPS)].sort()).toEqual([
      "7a",
      "7b",
      "8a",
    ]);
    // The school: every class, never a half or a teaching group.
    expect([...ownerIdsOf(form({ scope: "SCHOOL" }), GROUPS)].sort()).toEqual(["7a", "7b", "8a"]);
    // Named groups; a half rides on its class when the class is named too.
    expect([...ownerIdsOf(form({ scope: "GROUPS", groupIds: ["7a", "7a-1", "sva7"] }), GROUPS)].sort()).toEqual([
      "7a",
      "sva7",
    ]);
    expect([...ownerIdsOf(form({ scope: "GROUPS", groupIds: ["7a-1"] }), GROUPS)]).toEqual(["7a-1"]);
  });

  it("sends the first teacher of a class as its lead, in a fixed order, and only for the activity's classes", () => {
    const picks = { "7b": ["anna", "bo"], "7a": ["cia"], "8a": ["dan"], "7a-1": ["eva"] };
    const owners = ownerIdsOf(form({ scope: "GRADES" }), GROUPS);
    expect(teachersOf({ teachers: picks }, owners)).toEqual([
      { studentGroupId: "7a", teacherId: "cia", role: "LEAD" },
      { studentGroupId: "7b", teacherId: "anna", role: "LEAD" },
      { studentGroupId: "7b", teacherId: "bo", role: "ASSISTANT" },
    ]);
    // A teacher named twice for one class is sent once.
    expect(teachersOf({ teachers: { "7a": ["anna", "anna"] } }, owners)).toEqual([
      { studentGroupId: "7a", teacherId: "anna", role: "LEAD" },
    ]);
    // At most eight a class (ACTIVITY_TEACHER).
    const nine = Array.from({ length: 9 }, (_, index) => `t${index}`);
    expect(teachersOf({ teachers: { "7a": nine } }, owners)).toHaveLength(8);
  });

  it("builds a selection with only the scope's own fields and nothing empty", () => {
    expect(selectionOf(form(), "y26", GROUPS)).toEqual({
      academicYearId: "y26",
      name: "Friluftsdag åk 7",
      fromDate: "2026-11-02",
      toDate: "2026-11-02",
      scope: "GRADES",
      minGradeLevel: 7,
      maxGradeLevel: 7,
      replacementSubjectId: "tema",
    });
    const full = selectionOf(
      form({
        name: "  Prao  ",
        scope: "GROUPS",
        groupIds: ["8a", "7a"],
        startTime: "08:00",
        endTime: "12:00",
        description: "  Ta med matsäck.  ",
        teachers: { "7a": ["anna"] },
      }),
      "y26",
      GROUPS,
    );
    expect(full).toEqual({
      academicYearId: "y26",
      name: "Prao",
      fromDate: "2026-11-02",
      toDate: "2026-11-02",
      startTime: "08:00",
      endTime: "12:00",
      scope: "GROUPS",
      groupIds: ["7a", "8a"],
      replacementSubjectId: "tema",
      description: "Ta med matsäck.",
      teachers: [{ studentGroupId: "7a", teacherId: "anna", role: "LEAD" }],
    });
    // The create carries the digest and says whether to tell the families; the preview carries neither.
    expect(inputOf(form({ notify: false }), "y26", GROUPS, "d".repeat(64))).toMatchObject({
      expectedDigest: "d".repeat(64),
      notify: false,
    });
    expect(selectionOf(form(), "y26", GROUPS)).not.toHaveProperty("notify");
    expect(selectionOf(form(), "y26", GROUPS)).not.toHaveProperty("expectedDigest");
  });

  it("tells a preview that still holds from one that must be asked for again", () => {
    const base = selectionOf(form(), "y26", GROUPS);
    expect(previewState(null, base)).toBe("stale");
    expect(previewState(base, base)).toBe("current");
    // Ticking the notice is not part of the request.
    expect(previewState(base, selectionOf(form({ notify: false }), "y26", GROUPS))).toBe("current");
    // Teachers, credits and the description change the digest but not what was counted.
    const picked = selectionOf(form({ teachers: { "7a": ["anna"] } }), "y26", GROUPS);
    expect(previewState(base, picked)).toBe("adjusted");
    expect(previewState(base, selectionOf(form({ description: "Ta med matsäck." }), "y26", GROUPS))).toBe("adjusted");
    expect(
      previewState(base, selectionOf(form({ credits: [{ id: 0, subjectId: "idh", minutes: "300" }] }), "y26", GROUPS)),
    ).toBe("adjusted");
    // Anything the plan is made from makes it another preview.
    expect(previewState(base, selectionOf(form({ toDate: "2026-11-03" }), "y26", GROUPS))).toBe("stale");
    expect(previewState(base, selectionOf(form({ replacementSubjectId: "annat" }), "y26", GROUPS))).toBe("stale");
    expect(previewState(picked, selectionOf(form({ scope: "SCHOOL", teachers: { "7a": ["anna"] } }), "y26", GROUPS))).toBe(
      "stale",
    );
  });

  describe("a change of an existing activity", () => {
    const activity: ScheduleActivity = {
      id: "a-1",
      academicYearId: "y26",
      batchId: "b-1",
      name: "Friluftsdag åk 7",
      description: "Ta med matsäck.",
      fromDate: "2026-11-02",
      toDate: "2026-11-03",
      startTime: null,
      endTime: null,
      scope: "GROUPS",
      minGradeLevel: null,
      maxGradeLevel: null,
      scopeGroupIds: ["7a", "7b"],
      replacementSubject: { id: "tema", name: "Temadag", countsTowardTimplan: false },
      cancelled: 40,
      replacementLessons: 4,
      credits: 4,
      creditLines: [{ subjectId: "idh", minutes: 300 }],
      teachers: [
        { studentGroupId: "7a", teacherId: "bo", role: "ASSISTANT" },
        { studentGroupId: "7a", teacherId: "anna", role: "LEAD" },
        { studentGroupId: "7b", teacherId: "cia", role: "LEAD" },
      ],
      notifies: false,
      createdAt: "2026-10-01T08:00:00.000Z",
      createdByUserId: null,
      removedAt: null,
      reinstated: 0,
      doubleCounts: false,
    };

    it("opens on the activity, the leading teacher first, so a save sends the same lead", () => {
      const opened = formOfActivity(activity, [{ subjectId: "idh", minutes: 300 }], 0);
      expect(opened).toMatchObject({
        name: "Friluftsdag åk 7",
        description: "Ta med matsäck.",
        scope: "GROUPS",
        groupIds: ["7a", "7b"],
        replacementSubjectId: "tema",
        notify: false,
        teachers: { "7a": ["anna", "bo"], "7b": ["cia"] },
        credits: [{ id: 0, subjectId: "idh", minutes: "300" }],
      });
      expect(teachersOf(opened, ownerIdsOf(opened, GROUPS))).toEqual([
        { studentGroupId: "7a", teacherId: "anna", role: "LEAD" },
        { studentGroupId: "7a", teacherId: "bo", role: "ASSISTANT" },
        { studentGroupId: "7b", teacherId: "cia", role: "LEAD" },
      ]);
    });

    it("asks for another subject when the old one counts toward the timplan now", () => {
      const opened = formOfActivity({ ...activity, doubleCounts: true }, [], 0);
      expect(opened.replacementSubjectId).toBe("");
      expect(activityProblems(opened, YEAR)).toEqual(["subject"]);
    });

    it("carries credit lines only while there are days ahead to write them for", () => {
      expect(hasCreditsAhead(activity, "2026-11-02")).toBe(true);
      // Today's credit is not rewritten (the gateway writes after today only), and a finished activity has none ahead.
      expect(hasCreditsAhead(activity, "2026-11-03")).toBe(false);
      expect(hasCreditsAhead({ ...activity, credits: 0 }, "2026-10-01")).toBe(false);
    });
  });
});
