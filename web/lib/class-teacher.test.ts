import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import {
  AREA_NOT_YOURS,
  CODES,
  FRAME_REASONS,
  addDaysIso,
  canSplit,
  clockOf,
  createTarget,
  draftOf,
  emptyForm,
  formOfChange,
  formProblems,
  gridSpan,
  initialForm,
  isEditable,
  isFault,
  isFrameReason,
  isPublishable,
  isRefusalReason,
  isTime,
  layoutLanes,
  lessonOfDraft,
  lessonState,
  LESSON_IS_PLACED,
  minutesOf,
  mondayOf,
  openSpansOf,
  previewTarget,
  problemOf,
  spotOfOccasion,
  spotOfTemplate,
  splitMinutes,
  updateTarget,
  weekdayOf,
  type ChangeForm,
  type LessonSpot,
} from "./class-teacher";
import { draft, occasion, templateLesson, week } from "./__fixtures__/class-teacher";

/**
 * The web's own arithmetic for Klasslärarens schema: the clock, the calendar,
 * the columns of the week, the form of each change and what it sends, and an
 * ApiError told as the page tells it. What may be changed is the database's
 * frame, never decided here (lib/class-teacher.ts says so); these tests hold
 * the parts that are decided here.
 */

const TUESDAY_LESSON: LessonSpot = spotOfOccasion(occasion());
const TEMPLATE_SPOT: LessonSpot = spotOfTemplate(templateLesson());

const form = (patch: Partial<ChangeForm>): ChangeForm => ({ ...emptyForm(), ...patch });
const codes = (kind: Parameters<typeof formProblems>[0], patch: Partial<ChangeForm>, spot: LessonSpot) =>
  formProblems(kind, form(patch), spot).map((issue) => `${issue.field}:${issue.code}`);

describe("the clock", () => {
  it("reads and writes HH:MM", () => {
    expect(minutesOf("08:30")).toBe(510);
    expect(clockOf(510)).toBe("08:30");
    expect(clockOf(minutesOf("00:05"))).toBe("00:05");
    expect(minutesOf("8:30")).toBeNaN();
    expect(minutesOf("25:00")).toBeNaN();
    expect(minutesOf("")).toBeNaN();
  });

  it("knows a time from what is not one", () => {
    expect(["00:00", "09:05", "23:59"].every(isTime)).toBe(true);
    expect(["", "9:05", "24:00", "09:60", "09:05:00"].some(isTime)).toBe(false);
  });
});

describe("the calendar", () => {
  it("moves a date by whole days across a month and across the clock change", () => {
    expect(addDaysIso("2026-11-02", 7)).toBe("2026-11-09");
    expect(addDaysIso("2026-11-02", -7)).toBe("2026-10-26");
    // The last Sunday of October, when the clock goes back: still exactly one day.
    expect(addDaysIso("2026-10-25", 1)).toBe("2026-10-26");
    expect(addDaysIso("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("numbers the weekday 1 to 7 from Monday and finds the Monday of a week", () => {
    expect(weekdayOf("2026-11-02")).toBe(1);
    expect(weekdayOf("2026-11-08")).toBe(7);
    expect(mondayOf("2026-11-04")).toBe("2026-11-02");
    expect(mondayOf("2026-11-08")).toBe("2026-11-02");
    expect(mondayOf("2026-11-02")).toBe("2026-11-02");
  });
});

describe("the state of a lesson", () => {
  it("is the frame's: a lesson without a refusal may be changed", () => {
    expect(isEditable({ refusal: null })).toBe(true);
    expect(isEditable({ refusal: "OTHER_TEACHER" })).toBe(false);
  });

  it("puts a draft before anything else, then a cancellation, then the frame", () => {
    expect(lessonState({ refusal: null, draftId: null })).toBe("editable");
    expect(lessonState({ refusal: "TIME_CLOSED", draftId: null })).toBe("locked");
    expect(lessonState({ refusal: "NOT_SCHEDULED", draftId: null, status: "CANCELLED" })).toBe("cancelled");
    expect(lessonState({ refusal: null, draftId: "d-1", status: "SCHEDULED" })).toBe("draft");
    expect(lessonState({ refusal: "TIME_CLOSED", draftId: "d-1" })).toBe("draft");
  });

  it("knows the reasons it can say", () => {
    expect(FRAME_REASONS).toHaveLength(27);
    expect(isFrameReason("TIME_CLOSED")).toBe(true);
    expect(isFrameReason("A_NEW_ONE")).toBe(false);
    expect(isFrameReason(undefined)).toBe(false);
  });

  // The gateway adds one reason to the frame's, which the web mirrors one for one (class-teacher.contract.test.ts).
  it("knows the reason of a lesson placed on its timplanspost as a refusal, though it is no frame reason", () => {
    expect(isFrameReason(LESSON_IS_PLACED)).toBe(false);
    expect(isRefusalReason(LESSON_IS_PLACED)).toBe(true);
    expect(isRefusalReason("TIME_CLOSED")).toBe(true);
    expect(isRefusalReason("A_NEW_ONE")).toBe(false);
    expect(isEditable({ refusal: LESSON_IS_PLACED })).toBe(false);
    expect(lessonState({ refusal: LESSON_IS_PLACED, draftId: null, status: "SCHEDULED" })).toBe("locked");
  });
});

describe("lessons side by side", () => {
  const lane = (items: Array<[string, string, string]>) =>
    Object.fromEntries(layoutLanes(items.map(([id, start, end]) => ({ id, start: minutesOf(start), end: minutesOf(end) }))));

  it("gives lessons that do not overlap a lane each of the whole width", () => {
    expect(lane([["a", "08:00", "09:00"], ["b", "09:00", "10:00"]])).toEqual({ a: { lane: 0, lanes: 1 }, b: { lane: 0, lanes: 1 } });
  });

  it("puts two lessons at once side by side", () => {
    expect(lane([["a", "08:00", "09:00"], ["b", "08:30", "09:30"]])).toEqual({ a: { lane: 0, lanes: 2 }, b: { lane: 1, lanes: 2 } });
  });

  it("lets a chain of overlaps reuse a lane that has ended, and sizes the whole cluster alike", () => {
    expect(lane([["a", "08:00", "10:00"], ["b", "09:00", "11:00"], ["c", "10:00", "12:00"], ["d", "13:00", "14:00"]])).toEqual({
      a: { lane: 0, lanes: 2 },
      b: { lane: 1, lanes: 2 },
      c: { lane: 0, lanes: 2 },
      d: { lane: 0, lanes: 1 },
    });
  });

  it("spans the hours drawn, at least two, and the school day when nothing is drawn", () => {
    expect(gridSpan([minutesOf("09:15"), minutesOf("10:45")])).toEqual({ from: 540, to: 660 });
    expect(gridSpan([minutesOf("08:00"), minutesOf("08:30")])).toEqual({ from: 480, to: 600 });
    expect(gridSpan([])).toEqual({ from: 480, to: 960 });
    expect(gridSpan([Number.NaN])).toEqual({ from: 480, to: 960 });
  });

  it("lists the open spans of a day in time order", () => {
    const open = [
      { dayOfWeek: 2, start: "13:00", end: "15:00" },
      { dayOfWeek: 1, start: "08:00", end: "09:00" },
      { dayOfWeek: 2, start: "08:00", end: "12:00" },
    ];
    expect(openSpansOf(open, 2)).toEqual([{ start: "08:00", end: "12:00" }, { start: "13:00", end: "15:00" }]);
    expect(openSpansOf(open, 3)).toEqual([]);
  });
});

describe("the form of a change", () => {
  it("opens as the lesson stands, so only what is to change need be touched", () => {
    expect(initialForm("OCCASION_MOVE", TUESDAY_LESSON)).toEqual(form({ date: "2026-11-03", start: "09:00", end: "10:00" }));
    expect(initialForm("OCCASION_CANCEL", TUESDAY_LESSON)).toEqual(emptyForm());
    expect(initialForm("OCCASION_ROOM", TUESDAY_LESSON)).toEqual(emptyForm());
    expect(initialForm("TEMPLATE_MOVE", TEMPLATE_SPOT)).toEqual(form({ dayOfWeek: "2", start: "09:00", end: "10:30" }));
  });

  it("opens a split at its middle, the second part starting where the first ends", () => {
    expect(initialForm("TEMPLATE_SPLIT", TEMPLATE_SPOT)).toEqual(form({ dayOfWeek: "2", keepEnd: "09:45", start: "09:45", end: "10:30" }));
    // To the nearest five minutes down, and both parts still hold at least 15 minutes.
    const odd = initialForm("TEMPLATE_SPLIT", { ...TEMPLATE_SPOT, start: "09:00", end: "09:35" });
    expect(odd.keepEnd).toBe("09:15");
    expect(formProblems("TEMPLATE_SPLIT", odd, { ...TEMPLATE_SPOT, start: "09:00", end: "09:35" })).toEqual([]);
  });

  it("splits only a lesson that can give two parts of 15 minutes", () => {
    expect(canSplit({ start: "09:00", end: "09:30" })).toBe(true);
    expect(canSplit({ start: "09:00", end: "09:29" })).toBe(false);
  });

  it("reads a draft back into the form over the lesson as it stands", () => {
    const moved = draft({ targetDate: "2026-11-05", targetStart: "11:00", targetEnd: "12:00", targetRoomId: "r-14", note: "Prov" });
    expect(formOfChange(moved, TUESDAY_LESSON)).toEqual(form({ date: "2026-11-05", start: "11:00", end: "12:00", roomId: "r-14", note: "Prov" }));
    const room = draft({ kind: "OCCASION_ROOM", targetDate: null, targetStart: null, targetEnd: null, targetRoomId: "r-14" });
    expect(formOfChange(room, TUESDAY_LESSON)).toEqual(form({ roomId: "r-14" }));
    const split = draft({
      kind: "TEMPLATE_SPLIT", calendarLessonId: null, masterLessonId: "m-ma", date: null, targetDate: null,
      targetDayOfWeek: 4, targetStart: "10:00", targetEnd: "10:45", keepEnd: "09:45",
    });
    expect(formOfChange(split, TEMPLATE_SPOT)).toEqual(form({ dayOfWeek: "4", start: "10:00", end: "10:45", keepEnd: "09:45" }));
  });
});

describe("what the form cannot be sent with", () => {
  it("asks a move for a weekday date, and times in order", () => {
    expect(codes("OCCASION_MOVE", { date: "", start: "09:00", end: "10:00" }, TUESDAY_LESSON)).toEqual(["date:DATE_MISSING"]);
    // 2026-11-07 is a Saturday.
    expect(codes("OCCASION_MOVE", { date: "2026-11-07", start: "09:00", end: "10:00" }, TUESDAY_LESSON)).toEqual(["date:DATE_WEEKEND"]);
    expect(codes("OCCASION_MOVE", { date: "2026-11-04", start: "", end: "10:00" }, TUESDAY_LESSON)).toEqual(["start:TIME_MISSING"]);
    expect(codes("OCCASION_MOVE", { date: "2026-11-04", start: "09:00", end: "" }, TUESDAY_LESSON)).toEqual(["end:TIME_MISSING"]);
    expect(codes("OCCASION_MOVE", { date: "2026-11-04", start: "10:00", end: "10:00" }, TUESDAY_LESSON)).toEqual(["end:END_NOT_AFTER_START"]);
    expect(codes("OCCASION_MOVE", { date: "2026-11-04", start: "10:00", end: "09:00" }, TUESDAY_LESSON)).toEqual(["end:END_NOT_AFTER_START"]);
    expect(codes("OCCASION_MOVE", { date: "2026-11-04", start: "09:00", end: "10:00" }, TUESDAY_LESSON)).toEqual([]);
  });

  it("calls a move to where the lesson already is no change, unless it also changes the room", () => {
    const same = { date: "2026-11-03", start: "09:00", end: "10:00" };
    expect(codes("OCCASION_MOVE", same, TUESDAY_LESSON)).toEqual(["form:NO_CHANGE"]);
    expect(codes("OCCASION_MOVE", { ...same, roomId: "r-12" }, TUESDAY_LESSON)).toEqual(["form:NO_CHANGE"]);
    expect(codes("OCCASION_MOVE", { ...same, roomId: "r-14" }, TUESDAY_LESSON)).toEqual([]);
    expect(isFault({ field: "form", code: "NO_CHANGE" })).toBe(false);
    expect(isFault({ field: "end", code: "END_NOT_AFTER_START" })).toBe(true);
  });

  it("asks a room change for another room, and a cancellation for nothing", () => {
    expect(codes("OCCASION_ROOM", {}, TUESDAY_LESSON)).toEqual(["roomId:ROOM_MISSING"]);
    expect(codes("OCCASION_ROOM", { roomId: "r-12" }, TUESDAY_LESSON)).toEqual(["form:NO_CHANGE"]);
    expect(codes("OCCASION_ROOM", { roomId: "r-14" }, TUESDAY_LESSON)).toEqual([]);
    expect(codes("OCCASION_CANCEL", {}, TUESDAY_LESSON)).toEqual([]);
    expect(codes("OCCASION_CANCEL", { note: "x".repeat(201) }, TUESDAY_LESSON)).toEqual(["note:NOTE_TOO_LONG"]);
  });

  it("asks a move in the template for a weekday and times in order", () => {
    expect(codes("TEMPLATE_MOVE", { dayOfWeek: "", start: "09:00", end: "10:30" }, TEMPLATE_SPOT)).toEqual(["dayOfWeek:DAY_MISSING"]);
    expect(codes("TEMPLATE_MOVE", { dayOfWeek: "6", start: "09:00", end: "10:30" }, TEMPLATE_SPOT)).toEqual(["dayOfWeek:DAY_MISSING"]);
    expect(codes("TEMPLATE_MOVE", { dayOfWeek: "2", start: "09:00", end: "10:30" }, TEMPLATE_SPOT)).toEqual(["form:NO_CHANGE"]);
    expect(codes("TEMPLATE_MOVE", { dayOfWeek: "3", start: "09:00", end: "10:30" }, TEMPLATE_SPOT)).toEqual([]);
  });

  describe("a split", () => {
    // The lesson is 09:00-10:30, 90 minutes.
    const split = (patch: Partial<ChangeForm>) => codes("TEMPLATE_SPLIT", { dayOfWeek: "3", ...patch }, TEMPLATE_SPOT);

    it("is whole when the two parts add up to the lesson", () => {
      expect(split({ keepEnd: "09:45", start: "10:00", end: "10:45" })).toEqual([]);
      expect(split({ keepEnd: "09:30", start: "11:00", end: "12:00" })).toEqual([]);
      expect(splitMinutes(form({ keepEnd: "09:45", start: "10:00", end: "10:45" }), TEMPLATE_SPOT)).toEqual({ first: 45, second: 45, total: 90 });
    });

    it("is refused when the minutes do not add up", () => {
      expect(split({ keepEnd: "09:45", start: "10:00", end: "10:40" })).toEqual(["form:SPLIT_MINUTES"]);
      expect(split({ keepEnd: "09:45", start: "10:00", end: "11:00" })).toEqual(["form:SPLIT_MINUTES"]);
    });

    it("is refused when a part is shorter than 15 minutes", () => {
      expect(split({ keepEnd: "09:10", start: "10:00", end: "11:20" })).toEqual(["form:PART_TOO_SHORT"]);
      expect(split({ keepEnd: "10:15", start: "10:00", end: "10:10" })).toEqual(["form:PART_TOO_SHORT"]);
    });

    it("needs the first part to end inside the lesson", () => {
      expect(split({ keepEnd: "", start: "10:00", end: "10:45" })).toEqual(["keepEnd:KEEP_END_MISSING"]);
      expect(split({ keepEnd: "09:00", start: "10:00", end: "10:45" })).toEqual(["keepEnd:KEEP_END_OUTSIDE"]);
      expect(split({ keepEnd: "10:30", start: "10:00", end: "10:45" })).toEqual(["keepEnd:KEEP_END_OUTSIDE"]);
    });

    it("measures the parts in minutes, not in clock text", () => {
      expect(splitMinutes(form({ keepEnd: "", start: "", end: "" }), TEMPLATE_SPOT).first).toBeNaN();
    });
  });
});

describe("what a change sends", () => {
  const move = form({ date: "2026-11-04", start: "10:00", end: "11:00", roomId: "r-14", note: "  Prov  " });

  it("sends a kind the fields it names and none of the others", () => {
    expect(createTarget("OCCASION_MOVE", move)).toEqual({ targetDate: "2026-11-04", targetStart: "10:00", targetEnd: "11:00", targetRoomId: "r-14", note: "Prov" });
    expect(createTarget("OCCASION_CANCEL", move)).toEqual({ note: "Prov" });
    expect(createTarget("OCCASION_ROOM", move)).toEqual({ targetRoomId: "r-14", note: "Prov" });
    const template = form({ dayOfWeek: "3", start: "10:00", end: "11:30", keepEnd: "09:45" });
    expect(createTarget("TEMPLATE_MOVE", template)).toEqual({ targetDayOfWeek: 3, targetStart: "10:00", targetEnd: "11:30" });
    expect(createTarget("TEMPLATE_SPLIT", template)).toEqual({ targetDayOfWeek: 3, targetStart: "10:00", targetEnd: "11:30", keepEnd: "09:45" });
  });

  it("leaves out a room the form keeps and a note it has none of", () => {
    expect(createTarget("OCCASION_MOVE", { ...move, roomId: "", note: "" })).toEqual({ targetDate: "2026-11-04", targetStart: "10:00", targetEnd: "11:00" });
  });

  it("asks a preview without the note, so a typed word is no reason to ask again", () => {
    expect(previewTarget("OCCASION_MOVE", move)).toEqual({ targetDate: "2026-11-04", targetStart: "10:00", targetEnd: "11:00", targetRoomId: "r-14" });
    expect(previewTarget("OCCASION_CANCEL", move)).toEqual({});
  });

  it("clears the room on a patch that keeps the lesson's, and writes the note as it stands", () => {
    expect(updateTarget("OCCASION_MOVE", { ...move, roomId: "", note: "" })).toEqual({
      targetDate: "2026-11-04", targetStart: "10:00", targetEnd: "11:00", targetRoomId: null, note: "",
    });
    expect(updateTarget("OCCASION_CANCEL", move)).toEqual({ note: "Prov" });
    // A room change always names its room; it is never cleared.
    expect(updateTarget("OCCASION_ROOM", move)).toEqual({ targetRoomId: "r-14", note: "Prov" });
  });
});

describe("the week on screen", () => {
  it("finds the draft a lesson has, and the lesson a draft is about", () => {
    const one = draft();
    const held = week({ occasions: [occasion({ draftId: "d-1" })], drafts: [one] });
    expect(draftOf(held, "d-1")).toBe(one);
    expect(draftOf(held, null)).toBeNull();
    expect(draftOf(held, "d-gone")).toBeNull();
    expect(lessonOfDraft(held, one)?.id).toBe("o-ma");
    expect(lessonOfDraft(held, draft({ calendarLessonId: null, masterLessonId: "m-ma" }))?.id).toBe("m-ma");
    expect(lessonOfDraft(held, draft({ calendarLessonId: "o-elsewhere" }))).toBeNull();
    expect(lessonOfDraft(held, draft({ calendarLessonId: null, masterLessonId: null }))).toBeNull();
  });

  it("lets only a draft the check calls OK be published", () => {
    expect(isPublishable({ state: "OK" })).toBe(true);
    expect(isPublishable({ state: "CONFLICT", conflicts: [] })).toBe(false);
    expect(isPublishable(undefined)).toBe(false);
  });
});

describe("an ApiError, as the page tells it", () => {
  const error = (status: number, code?: string, params?: Record<string, string | number>) => new ApiError(status, "Sentence", code, params);

  it("tells a refusal outside the frame, with its reason when the gateway sent it", () => {
    expect(problemOf(error(403, CODES.OUTSIDE_FRAME, { reason: "TIME_CLOSED" }))).toEqual({ kind: "frame", reason: "TIME_CLOSED" });
    // The global filter forwards only `code` and flat `params`: a reason that did not arrive is null, and the preview names it.
    expect(problemOf(error(403, CODES.OUTSIDE_FRAME))).toEqual({ kind: "frame", reason: null });
    expect(problemOf(error(403, CODES.OUTSIDE_FRAME, { reason: "SOMETHING_NEW" }))).toEqual({ kind: "frame", reason: null });
    // The reason the gateway adds to the frame's is kept, so the page can say it in its own words.
    expect(problemOf(error(403, CODES.OUTSIDE_FRAME, { reason: LESSON_IS_PLACED }))).toEqual({ kind: "frame", reason: LESSON_IS_PLACED });
  });

  it("tells each of the 409s apart by its code, since the status cannot", () => {
    expect(problemOf(error(409, CODES.STALE))).toEqual({ kind: "stale" });
    expect(problemOf(error(409, CODES.REV))).toEqual({ kind: "rev" });
    expect(problemOf(error(409, CODES.DRAFT_EXISTS))).toEqual({ kind: "exists" });
    expect(problemOf(error(409, CODES.CONFLICT))).toEqual({ kind: "conflict" });
    expect(problemOf(error(409, CODES.APPOINTER_GONE))).toEqual({ kind: "appointerGone" });
  });

  it("tells the 403s, the 404 and the 400", () => {
    expect(problemOf(error(403, CODES.NOT_APPOINTED))).toEqual({ kind: "notAppointed" });
    expect(problemOf(error(403, CODES.PUBLISH_OFF))).toEqual({ kind: "publishOff" });
    expect(problemOf(error(404, CODES.GONE))).toEqual({ kind: "gone" });
    expect(problemOf(error(404))).toEqual({ kind: "gone" });
    expect(problemOf(error(400, CODES.INVALID))).toEqual({ kind: "invalid" });
    expect(problemOf(error(400, CODES.NO_CHANGE))).toEqual({ kind: "invalid" });
  });

  it("carries the gateway's own sentence for a write outside the administrator's profile", () => {
    const refused = new ApiError(403, "Schemaläggare ändrar inte publicering.", AREA_NOT_YOURS);
    expect(problemOf(refused)).toEqual({ kind: "areaNotYours", message: "Schemaläggare ändrar inte publicering." });
  });

  it("calls anything else something else, with the message when there is one", () => {
    expect(problemOf(error(500))).toEqual({ kind: "other", message: "Sentence" });
    expect(problemOf(new Error("boom"))).toEqual({ kind: "other", message: null });
    expect(problemOf("nope")).toEqual({ kind: "other", message: null });
  });
});
