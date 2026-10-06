import { describe, expect, it } from "vitest";
import { sectionNationalSubjects } from "./national-subjects";
import type { NationalSubject } from "./types";

const subject = (
  code: string,
  name: string,
  parentCode: string | null = null,
  isGroup = false,
): NationalSubject => ({ code, name, parentCode, isGroup });

/** The seeded list, shuffled so nothing below passes by arrival order. */
const SEEDED: NationalSubject[] = [
  subject("KE", "Kemi", "NO"),
  subject("SV_SVA", "Svenska eller svenska som andraspråk"),
  subject("SO", "Samhällsorienterande ämnen", null, true),
  subject("BL", "Bild"),
  subject("HI", "Historia", "SO"),
  subject("NO", "Naturorienterande ämnen", null, true),
  subject("BI", "Biologi", "NO"),
  subject("GE", "Geografi", "SO"),
  subject("MA", "Matematik"),
  subject("SH", "Samhällskunskap", "SO"),
  subject("FY", "Fysik", "NO"),
  subject("RE", "Religionskunskap", "SO"),
  subject("IDH", "Idrott och hälsa"),
];

describe("sectionNationalSubjects", () => {
  it("lists the flat subjects first, then one section per ämnesgrupp", () => {
    const sections = sectionNationalSubjects(SEEDED);

    expect(sections.map((section) => section.group?.code ?? null)).toEqual([null, "NO", "SO"]);
    expect(sections[0]!.options.map((option) => option.code)).toEqual([
      "BL",
      "IDH",
      "MA",
      "SV_SVA",
    ]);
  });

  it("puts the group itself at the top of its section, then its children in Swedish order", () => {
    // NO is a legal nationalCode in its own right — lågstadiet teaches it as
    // one subject — so it must be pickable, not just a heading.
    const [, no, so] = sectionNationalSubjects(SEEDED);

    expect(no!.options.map((option) => option.code)).toEqual(["NO", "BI", "FY", "KE"]);
    expect(so!.options.map((option) => option.code)).toEqual(["SO", "GE", "HI", "RE", "SH"]);
  });

  it("lists every subject exactly once", () => {
    // A child listed both flat and under its parent is two options for one
    // code, and a coverage sum that could meet it twice.
    const codes = sectionNationalSubjects(SEEDED).flatMap((section) =>
      section.options.map((option) => option.code),
    );

    expect([...codes].sort()).toEqual(SEEDED.map((s) => s.code).sort());
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("shows a child whose parent is missing as a flat subject rather than dropping it", () => {
    const sections = sectionNationalSubjects([
      subject("MA", "Matematik"),
      subject("BI", "Biologi", "NO"),
    ]);

    expect(sections).toHaveLength(1);
    expect(sections[0]!.options.map((option) => option.code)).toEqual(["BI", "MA"]);
  });

  it("sorts in Swedish, with Ö after Å and Ä", () => {
    const sections = sectionNationalSubjects([
      subject("X1", "Övrigt"),
      subject("X2", "Ämnesval"),
      subject("X3", "Bild"),
    ]);

    expect(sections[0]!.options.map((option) => option.name)).toEqual([
      "Bild",
      "Ämnesval",
      "Övrigt",
    ]);
  });

  it("returns no sections for an empty list", () => {
    expect(sectionNationalSubjects([])).toEqual([]);
  });
});
