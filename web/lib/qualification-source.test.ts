import { describe, expect, it } from "vitest";
import { qualificationSourceChoices, qualificationUsers } from "./qualification-source";
import type { Subject } from "./types";

const subject = (id: string, qualificationSubjectId: string | null = null): Subject => ({
  id,
  name: id.toUpperCase(),
  code: null,
  color: null,
  requiredRoomTypeId: null,
  nationalCode: null,
  countsTowardTimplan: true,
  qualificationSubjectId,
});

const SCHOOL = [subject("so"), subject("so-ws", "so"), subject("ma"), subject("ke")];

describe("qualificationSourceChoices", () => {
  it("offers the school's other subjects that take their behörighet from none", () => {
    expect(qualificationSourceChoices(SCHOOL, SCHOOL[2]!).map((s) => s.id)).toEqual(["so", "ke"]);
  });

  it("never offers the subject itself, and never one that inherits (one level only)", () => {
    expect(qualificationSourceChoices(SCHOOL, SCHOOL[0]!).map((s) => s.id)).toEqual(["ma", "ke"]);
    // A subject that already inherits may change its source: it is not offered itself, and the others are.
    expect(qualificationSourceChoices(SCHOOL, SCHOOL[1]!).map((s) => s.id)).toEqual(["so", "ma", "ke"]);
  });

  it("offers every subject without a pointer to a subject that is being made", () => {
    expect(qualificationSourceChoices(SCHOOL, null).map((s) => s.id)).toEqual(["so", "ma", "ke"]);
  });

  it("reads a row from an API that sent no pointer at all as one that takes none", () => {
    const old = { ...subject("ma") } as Partial<Subject>;
    delete old.qualificationSubjectId;
    expect(qualificationSourceChoices([old as Subject, subject("so")], null).map((s) => s.id)).toEqual(["ma", "so"]);
  });
});

describe("qualificationUsers", () => {
  it("lists the subjects that take their behörighet from the one asked about, and none otherwise", () => {
    expect(qualificationUsers(SCHOOL, "so").map((s) => s.id)).toEqual(["so-ws"]);
    expect(qualificationUsers(SCHOOL, "ma")).toEqual([]);
  });
});
