import { describe, expect, it } from "vitest";
import {
  EMPTY_SCOPE_DRAFT,
  SCOPE_LEVEL_MAX,
  SCOPE_NOTE_MAX,
  isIsoDay,
  scopeDraftToBody,
  scopeToDraft,
  validateScopeDraft,
  type ScopeAssessmentDraft,
} from "./scope-assessment-form";

const draft = (over: Partial<ScopeAssessmentDraft> = {}): ScopeAssessmentDraft => ({ ...EMPTY_SCOPE_DRAFT, ...over });

describe("validateScopeDraft", () => {
  it("says an empty draft says nothing: no level and no exception", () => {
    expect(validateScopeDraft(draft())).toEqual({ reason: "empty" });
    expect(validateScopeDraft(draft({ level: "  ", note: "bara en anteckning" }))).toEqual({ reason: "empty" });
  });

  it("accepts a level alone and an exception alone, and the edges of the level", () => {
    expect(validateScopeDraft(draft({ level: "600" }))).toBeNull();
    expect(validateScopeDraft(draft({ exceptionKind: "SMALL_GROUP" }))).toBeNull();
    expect(validateScopeDraft(draft({ level: "1" }))).toBeNull();
    expect(validateScopeDraft(draft({ level: String(SCOPE_LEVEL_MAX) }))).toBeNull();
  });

  it("holds the level to whole hours in 1..1500", () => {
    expect(validateScopeDraft(draft({ level: "600,5" }))).toEqual({ reason: "levelWhole" });
    expect(validateScopeDraft(draft({ level: "abc" }))).toEqual({ reason: "levelWhole" });
    expect(validateScopeDraft(draft({ level: "-5" }))).toEqual({ reason: "levelWhole" });
    expect(validateScopeDraft(draft({ level: "0" }))).toEqual({ reason: "levelRange", max: SCOPE_LEVEL_MAX });
    expect(validateScopeDraft(draft({ level: String(SCOPE_LEVEL_MAX + 1) }))).toEqual({ reason: "levelRange", max: SCOPE_LEVEL_MAX });
  });

  it("wants the day for the exception on the teacher's own initiative and refuses it for anything else", () => {
    expect(validateScopeDraft(draft({ exceptionKind: "OWN_INITIATIVE" }))).toEqual({ reason: "initiativeNeedsDay" });
    expect(validateScopeDraft(draft({ exceptionKind: "OWN_INITIATIVE", ownInitiativeOn: "2027-05-02" }))).toBeNull();
    expect(validateScopeDraft(draft({ exceptionKind: "SMALL_GROUP", ownInitiativeOn: "2027-05-02" }))).toEqual({ reason: "dayNeedsInitiative" });
    expect(validateScopeDraft(draft({ level: "600", ownInitiativeOn: "2027-05-02" }))).toEqual({ reason: "dayNeedsInitiative" });
  });

  it("refuses a day that does not exist, though it is shaped right", () => {
    expect(validateScopeDraft(draft({ exceptionKind: "OWN_INITIATIVE", ownInitiativeOn: "2027-02-30" }))).toEqual({ reason: "dayInvalid" });
    expect(validateScopeDraft(draft({ exceptionKind: "OWN_INITIATIVE", ownInitiativeOn: "2027-13-01" }))).toEqual({ reason: "dayInvalid" });
    expect(validateScopeDraft(draft({ exceptionKind: "OWN_INITIATIVE", ownInitiativeOn: "02/05/2027" }))).toEqual({ reason: "dayInvalid" });
  });

  it("holds the note to the table's 500 characters, counted after trimming", () => {
    expect(validateScopeDraft(draft({ level: "600", note: "x".repeat(SCOPE_NOTE_MAX) }))).toBeNull();
    expect(validateScopeDraft(draft({ level: "600", note: `  ${"x".repeat(SCOPE_NOTE_MAX)}  ` }))).toBeNull();
    expect(validateScopeDraft(draft({ level: "600", note: "x".repeat(SCOPE_NOTE_MAX + 1) }))).toEqual({ reason: "noteLong", max: SCOPE_NOTE_MAX });
  });
});

describe("isIsoDay", () => {
  it("is the round trip, as the gateway's", () => {
    expect(isIsoDay("2028-02-29")).toBe(true);
    expect(isIsoDay("2027-02-29")).toBe(false);
    expect(isIsoDay("2027-2-9")).toBe(false);
    expect(isIsoDay("")).toBe(false);
  });
});

describe("scopeDraftToBody", () => {
  it("sends the whole row with what is empty as null", () => {
    expect(scopeDraftToBody(draft({ level: "600" }))).toEqual({ teachingLevelHours: 600, exceptionKind: null, ownInitiativeOn: null, note: null });
    expect(scopeDraftToBody(draft({ exceptionKind: "SMALL_GROUP", note: "  två elever  " }))).toEqual({
      teachingLevelHours: null,
      exceptionKind: "SMALL_GROUP",
      ownInitiativeOn: null,
      note: "två elever",
    });
  });

  it("sends the day only with the exception it belongs to, though the draft still holds one from before the kind changed", () => {
    expect(scopeDraftToBody(draft({ exceptionKind: "OWN_INITIATIVE", ownInitiativeOn: "2027-05-02" })).ownInitiativeOn).toBe("2027-05-02");
    expect(scopeDraftToBody(draft({ level: "600", exceptionKind: "SMALL_GROUP", ownInitiativeOn: "2027-05-02" })).ownInitiativeOn).toBeNull();
  });
});

describe("scopeToDraft", () => {
  it("opens empty for a teacher without an assessment", () => {
    expect(scopeToDraft(undefined)).toEqual(EMPTY_SCOPE_DRAFT);
    expect(scopeToDraft(null)).toEqual(EMPTY_SCOPE_DRAFT);
  });

  it("reads the report's row and the gateway's answer alike", () => {
    expect(scopeToDraft({ levelHours: 600, exceptionKind: "OWN_INITIATIVE", ownInitiativeOn: "2027-05-02", note: "skäl" })).toEqual({
      level: "600",
      exceptionKind: "OWN_INITIATIVE",
      ownInitiativeOn: "2027-05-02",
      note: "skäl",
    });
    expect(scopeToDraft({ teachingLevelHours: 550, exceptionKind: null, ownInitiativeOn: null, note: null })).toEqual({
      level: "550",
      exceptionKind: "",
      ownInitiativeOn: "",
      note: "",
    });
  });
});
