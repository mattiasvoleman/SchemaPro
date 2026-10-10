import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { ApiError } from "@/lib/api";
import type { MessageLookup } from "@/lib/engine-message";
import type { BoardItem } from "@/lib/cover-types";
import {
  absentIds,
  BUILTIN_REASONS,
  bulkEligible,
  bulkItems,
  chainLookup,
  coverErrorText,
  groupByDate,
  groupByLesson,
  otherTeacherOptions,
  pairActions,
  pairKey,
  reasonName,
  reasonText,
  statusKey,
  weekOf,
  windowsOverlap,
} from "./cover-view";

/**
 * What the board shows and offers. The gateway refuses a decision on a pair
 * that is not OPEN (COVER_STALE), a cancel of a lesson that has started
 * (COVER_LESSON_STARTED) and anything on a lesson that has ended
 * (COVER_LESSON_HELD); the buttons follow the same rules so an admin is not
 * offered what will be refused.
 */

const NOW = Date.parse("2026-10-12T08:30:00Z");

function item(overrides: Partial<BoardItem> = {}): BoardItem {
  return {
    absenceId: "a-1",
    absentTeacherId: "t-anna",
    absentRole: "LEAD",
    lessonId: "l-1",
    date: "2026-10-12",
    startsAt: "2026-10-12T09:00:00Z",
    endsAt: "2026-10-12T10:00:00Z",
    subjectId: "s-ma",
    studentGroupId: "g-7a",
    extraGroupIds: [],
    roomId: "r-1",
    lessonStatus: "SCHEDULED",
    cancelCause: null,
    teachers: [{ teacherId: "t-anna", role: "LEAD" }],
    substituteId: null,
    decision: null,
    decidedAt: null,
    status: "OPEN",
    decisionStale: false,
    passed: false,
    outsideAbsence: false,
    ...overrides,
  };
}

/** A lookup over a namespace of the real messages, as next-intl would give it. */
function lookup(messages: Record<string, string>): MessageLookup {
  const t = ((key: string, values?: Record<string, string | number>) => {
    const template = messages[key];
    if (template === undefined) throw new Error(`missing ${key}`);
    return template.replace(/\{(\w+)\}/g, (_, name: string) => {
      if (!values || !(name in values)) throw new Error(`missing argument ${name}`);
      return String(values[name]);
    });
  }) as MessageLookup;
  t.has = (key: string) => key in messages;
  return t;
}

describe("statusKey", () => {
  it("names a pair's badge by status, an open pair that ran out as PASSED, a handled one by kind", () => {
    expect(statusKey(item())).toBe("OPEN");
    expect(statusKey(item({ passed: true }))).toBe("PASSED");
    expect(statusKey(item({ status: "COVERED", passed: true }))).toBe("COVERED");
    expect(statusKey(item({ status: "CANCELLED" }))).toBe("CANCELLED");
    expect(statusKey(item({ status: "HANDLED", decision: "SUPERVISED_STUDY" }))).toBe("HANDLED_SUPERVISED_STUDY");
    expect(statusKey(item({ status: "HANDLED", decision: "CO_TEACHER" }))).toBe("HANDLED_CO_TEACHER");
  });

  it("has a Swedish and an English word for every badge", () => {
    for (const key of ["OPEN", "COVERED", "CANCELLED", "HANDLED_SUPERVISED_STUDY", "HANDLED_CO_TEACHER", "PASSED"]) {
      expect(sv.coverStatus).toHaveProperty(key);
      expect(en.coverStatus).toHaveProperty(key);
    }
    expect(sv.coverStatus.OPEN).toBe("Behöver vikarie");
  });
});

describe("groupByLesson", () => {
  it("puts the pairs of one lesson together, in time order, absent people by id", () => {
    const groups = groupByLesson([
      item({ lessonId: "l-2", startsAt: "2026-10-12T11:00:00Z", endsAt: "2026-10-12T12:00:00Z" }),
      item({ lessonId: "l-1", absenceId: "a-2", absentTeacherId: "t-bo" }),
      item({ lessonId: "l-1" }),
    ]);
    expect(groups.map((group) => group.lessonId)).toEqual(["l-1", "l-2"]);
    expect(groups[0]!.pairs.map((pair) => pair.absentTeacherId)).toEqual(["t-anna", "t-bo"]);
    expect(absentIds(groups[0]!)).toEqual(new Set(["t-anna", "t-bo"]));
  });

  it("splits a week's lessons by date", () => {
    const groups = groupByLesson([
      item({ lessonId: "l-3", date: "2026-10-13", startsAt: "2026-10-13T09:00:00Z", endsAt: "2026-10-13T10:00:00Z" }),
      item(),
    ]);
    expect(groupByDate(groups).map((day) => [day.date, day.lessons.length])).toEqual([
      ["2026-10-12", 1],
      ["2026-10-13", 1],
    ]);
  });
});

describe("pairActions", () => {
  const none = new Set(["t-anna"]);

  it("offers every decision on an open pair before the lesson", () => {
    expect(pairActions(item(), NOW, none)).toEqual({
      assign: true,
      cancel: true,
      supervised: true,
      coTeacher: false,
      undo: false,
      coTeacherFirst: false,
    });
  });

  it("refuses a cancel once the lesson has started, and keeps cover open until it ends", () => {
    const started = item({ startsAt: "2026-10-12T08:00:00Z", endsAt: "2026-10-12T09:00:00Z" });
    const actions = pairActions(started, NOW, none);
    expect(actions.cancel).toBe(false);
    expect(actions.assign).toBe(true);
    expect(actions.supervised).toBe(true);
  });

  it("offers nothing on a lesson that has ended, not even undo (held lessons are never rewritten)", () => {
    const held = item({
      startsAt: "2026-10-12T06:00:00Z",
      endsAt: "2026-10-12T07:00:00Z",
      decision: "SUBSTITUTE",
      status: "COVERED",
      passed: true,
    });
    expect(Object.values(pairActions(held, NOW, none)).some(Boolean)).toBe(false);
  });

  it("puts 'Medläraren håller' first when another teacher stays — not when the other is absent too", () => {
    const coTaught = item({
      teachers: [
        { teacherId: "t-anna", role: "LEAD" },
        { teacherId: "t-bo", role: "ASSISTANT" },
      ],
    });
    expect(pairActions(coTaught, NOW, new Set(["t-anna"])).coTeacherFirst).toBe(true);
    expect(pairActions(coTaught, NOW, new Set(["t-anna", "t-bo"])).coTeacher).toBe(false);
  });

  it("offers only undo on a decided pair, and both on a decision the calendar lost", () => {
    const covered = item({ status: "COVERED", decision: "SUBSTITUTE", substituteId: "t-sub" });
    expect(pairActions(covered, NOW, none)).toMatchObject({ assign: false, cancel: false, undo: true });
    const stale = item({ status: "OPEN", decision: "SUBSTITUTE", decisionStale: true });
    expect(pairActions(stale, NOW, none)).toMatchObject({ assign: true, undo: true });
  });
});

describe("bulk", () => {
  const open = item();
  const started = item({ lessonId: "l-2", startsAt: "2026-10-12T08:00:00Z", endsAt: "2026-10-12T09:00:00Z" });
  const covered = item({ lessonId: "l-3", status: "COVERED", decision: "SUBSTITUTE" });
  const all = [open, started, covered];
  const selected = new Set(all.map(pairKey));

  it("cancels only what has not started, and sends what the admin saw as expected", () => {
    expect(bulkItems("CANCELLED", all, selected, NOW)).toEqual([
      { lessonId: "l-1", absenceId: "a-1", expected: "OPEN" },
    ]);
  });

  it("gives self-study to every open pair, and undoes only decided ones", () => {
    expect(bulkItems("SUPERVISED_STUDY", all, selected, NOW).map((entry) => entry.lessonId)).toEqual(["l-1", "l-2"]);
    expect(bulkItems("UNDO", all, selected, NOW)).toEqual([
      { lessonId: "l-3", absenceId: "a-1", expected: "COVERED" },
    ]);
  });

  it("leaves out what is not selected", () => {
    expect(bulkItems("SUPERVISED_STUDY", all, new Set([pairKey(started)]), NOW)).toHaveLength(1);
    expect(bulkEligible("CANCELLED", covered, NOW)).toBe(false);
  });
});

describe("the board's window", () => {
  it("runs Monday to Sunday of the ISO week", () => {
    expect(weekOf("2026-10-14")).toEqual({ from: "2026-10-12", to: "2026-10-18" });
    expect(weekOf("2026-10-18")).toEqual({ from: "2026-10-12", to: "2026-10-18" });
    expect(weekOf("2027-01-01")).toEqual({ from: "2026-12-28", to: "2027-01-03" });
  });

  it("is refetched when a change touches it, and only then", () => {
    expect(windowsOverlap({ from: "2026-10-12", to: "2026-10-12" }, { from: "2026-10-12", to: "2026-10-18" })).toBe(true);
    expect(windowsOverlap({ from: "2026-10-19", to: "2026-10-20" }, { from: "2026-10-12", to: "2026-10-18" })).toBe(false);
  });
});

describe("reasons in plain Swedish", () => {
  const t = lookup(sv.coverReasons as Record<string, string>);

  it("renders a ranking reason from its params", () => {
    expect(reasonText(t, { code: "QUAL_LEGITIMATION", params: { subject: "Matematik", grades: "7–9" } })).toBe(
      "Legitimerad i Matematik för åk 7–9",
    );
    expect(reasonText(t, { code: "TEACHES_GROUP_SUBJECT", params: { group: "7A", subject: "Matematik" } })).toBe(
      "Undervisar 7A i Matematik",
    );
  });

  it("says a qualification without a grade span without a dangling 'för åk'", () => {
    expect(reasonText(t, { code: "QUAL_BEHORIG", params: { subject: "Engelska" } })).toBe("Behörig i Engelska");
  });

  it("says ABSENT as away and nothing more", () => {
    expect(reasonText(t, { code: "ABSENT", params: {} })).toBe("Är själv frånvarande");
  });

  it("falls back to the code for a sentence the web does not know yet", () => {
    expect(reasonText(t, { code: "SOMETHING_NEW", params: {} })).toBe("SOMETHING_NEW");
  });

  it("has a sentence, in both languages, for every code the gateway ranks or excludes by", () => {
    // src/cover/cover-rank.ts RankReasonCode and src/cover/cover-rules.ts HardRuleCode.
    const codes = [
      "QUAL_LEGITIMATION", "QUAL_BEHORIG", "QUAL_TILLATEN", "TEACHES_SUBJECT", "TEACHES_GROUP_SUBJECT",
      "TEACHES_GROUP", "MENTOR", "GAP_FILL", "ON_SITE", "NOT_ON_SITE", "RELEASED", "AT_EVENT", "COUNTER_WEEK",
      "COUNTER_TERM", "UNDER_TARGET", "OVER_TARGET", "POOL_PREFERRED", "POOL", "POOL_LAST", "PREFERS_FREE",
      "INACTIVE", "ON_LESSON", "ABSENT", "BUSY_LESSON", "BUSY_DUTY", "UNAVAILABLE", "BOOKED_ROOM", "LUNCH",
      "DAILY_REST", "POOL_NOT_DECLARED",
    ];
    expect(codes.filter((code) => !(code in sv.coverReasons))).toEqual([]);
    expect(codes.filter((code) => !(code in en.coverReasons))).toEqual([]);
  });
});

describe("cover refusals", () => {
  const t = lookup(sv.coverErrors as Record<string, string>);

  it("are said in the reader's language from the code", () => {
    expect(coverErrorText(t, new ApiError(409, "Lektionen har redan hållits och ändras inte.", "COVER_LESSON_HELD"), "x")).toBe(
      "Lektionen har redan hållits och ändras inte.",
    );
  });

  it("fall back to the gateway's own sentence for a code the web lacks", () => {
    expect(coverErrorText(t, new ApiError(409, "Gatewayns mening.", "COVER_SOMETHING_NEW"), "x")).toBe("Gatewayns mening.");
  });

  it("cover every code the cover gateway refuses or warns with", () => {
    const codes = [
      "COVER_STALE", "COVER_LESSON_HELD", "COVER_LESSON_STARTED", "COVER_NOT_AFFECTED", "COVER_NO_DECISION",
      "CO_TEACHER_MISSING", "COVER_UNDO_ORDER", "COVER_UNDO_CONFLICT", "COVER_UNDO_CLASH", "COVER_RANGE",
      "COVER_SUBSTITUTE_REQUIRED", "COVER_PROPOSAL_STALE", "COVER_DUPLICATE", "COVER_INVALID",
      "SUBSTITUTE_IS_ABSENT", "SUBSTITUTE_ON_LESSON", "SUBSTITUTE_HAS_LESSON", "PUBLISH_IN_PROGRESS", "ABSENCE_OVERLAPS",
      "ABSENCE_HAS_DECISIONS", "ABSENCE_HAS_HELD_DECISIONS", "ABSENCE_NOT_YOURS", "ABSENCE_PERSON",
      "ABSENCE_PERSON_IS_FIXED", "ABSENCE_RANGE", "ABSENCE_REASON", "ABSENCE_SELF_EDIT_NARROW",
      "ABSENCE_SELF_REPORT_OFF", "ABSENCE_TOO_FAR_BACK", "ABSENCE_WITHDRAWN", "ABSENCE_WITHDRAW_TOO_LATE",
      "ABSENCE_END", "AVAILABILITY_SHAPE", "AVAILABILITY_NOT_YOURS", "POOL_MEMBER_MUST_BE_TEACHER",
      "REASON_BUILTIN_LABEL", "COVER_BREAKS_LUNCH", "COVER_BREAKS_DAILY_REST", "COVER_TEACHER_UNAVAILABLE",
      "COVER_TEACHER_BOOKED", "COVER_POOL_NOT_DECLARED",
    ];
    expect(codes.filter((code) => !(code in sv.coverErrors))).toEqual([]);
    expect(codes.filter((code) => !(code in en.coverErrors))).toEqual([]);
  });

  it("say a substitute's own lesson then in the reader's language, not the gateway's English", () => {
    const error = new ApiError(409, "The substitute already teaches another lesson at this time.", "SUBSTITUTE_HAS_LESSON");
    expect(coverErrorText(t, error, "x")).toBe("Vikarien har en egen lektion då och kan inte tillsättas.");
    expect(coverErrorText(lookup(en.coverErrors as Record<string, string>), error, "x")).toBe(
      "The substitute has a lesson of their own then and cannot be assigned.",
    );
  });

  it("read the cover's own warnings first and the engine's second, for a vikarie's toast", () => {
    const engine = lookup({ STAFF_TEACHER_NOT_QUALIFIED: "Inte behörig i {subject}." });
    const chained = chainLookup(t, engine);
    expect(chained("COVER_BREAKS_LUNCH", { minutes: 30 })).toBe("Vikarien förlorar sin lunch på 30 min.");
    expect(chained("STAFF_TEACHER_NOT_QUALIFIED", { subject: "Kemi" })).toBe("Inte behörig i Kemi.");
    expect(chained.has("NOPE")).toBe(false);
  });
});

describe("the other-teacher pick", () => {
  const teachers = ["t-anna", "t-bo", "t-cia", "t-dan", "t-eva", "t-fia"].map((id) => ({ id, name: id }));

  it("lists only who the gateway would put in with a warning — never the suggested, the lesson's own, the busy or the absent", () => {
    const options = otherTeacherOptions(teachers, item({ teachers: [{ teacherId: "t-anna", role: "LEAD" }] }), {
      lessonId: "l-1",
      candidates: [{ userId: "t-bo" }],
      excluded: [
        { userId: "t-cia", codes: [{ code: "BUSY_LESSON", params: { lessonId: "l-2" } }] },
        { userId: "t-dan", codes: [{ code: "ABSENT", params: {} }] },
        { userId: "t-eva", codes: [{ code: "LUNCH", params: { minutes: 30 } }, { code: "POOL_NOT_DECLARED", params: {} }] },
      ],
    });
    expect(options.map((teacher) => teacher.id)).toEqual(["t-eva", "t-fia"]);
  });
});

describe("reasonName", () => {
  const t = (key: string) => (sv.absenceReasons as Record<string, string>)[key] ?? key;

  it("names a built-in in the reader's language and a school's own by its label", () => {
    expect(reasonName(t, { builtin: "CHILD_CARE", label: null })).toBe("Vård av barn");
    expect(reasonName(t, { builtin: null, label: "Facklig tid" })).toBe("Facklig tid");
    expect(reasonName(t, undefined)).toBe("Ej angiven");
  });

  it("has every built-in the gateway seeds in both languages", () => {
    for (const key of [...BUILTIN_REASONS, "NONE"]) {
      expect(sv.absenceReasons).toHaveProperty(key);
      expect(en.absenceReasons).toHaveProperty(key);
    }
  });
});
