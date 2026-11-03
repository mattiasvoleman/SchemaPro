import { describe, expect, it } from "vitest";
import {
  B1,
  LAW_2028,
  SAMESKOLA,
  SPECIALSKOLA,
  SPECIALSKOLA_2028,
} from "@/lib/__fixtures__/timplan-statute";
import type { SchoolUnit } from "@/lib/school-units";
import {
  copySpanRequest,
  formGrades,
  sameSpan,
  spanGradeOptions,
  spanHoldsWholeForm,
  spanNotice,
  spanText,
  suggestedSpan,
  unitSpanForForm,
  versionKeepsNumbering,
} from "@/lib/timplan-span";

const unit = (
  name: string,
  gradeFrom: number | null,
  gradeTo: number | null,
  schoolTypes: SchoolUnit["schoolTypes"] = ["GR"],
): SchoolUnit => ({ id: name, name, code: null, schoolTypes, gradeFrom, gradeTo, fromSource: false });

describe("unitSpanForForm: the skolenheternas årskurser in the plan's numbering", () => {
  it("is the hull of the span of every unit that holds the plan's school type", () => {
    // Two units with a gap between them are one school's plan, and a plan has one span.
    expect(unitSpanForForm([unit("F–3", 0, 3), unit("7–9", 7, 9)], "GRUNDSKOLA", false)).toEqual({
      gradeFrom: 0,
      gradeTo: 9,
    });
    expect(unitSpanForForm([unit("Norra", 4, 9)], "GRUNDSKOLA", false)).toEqual({ gradeFrom: 4, gradeTo: 9 });
  });

  it("reads a unit stated in the nine-year numbering as the tioårig one does: 4–9 becomes 5–10, F–9 becomes 1–10", () => {
    expect(unitSpanForForm([unit("Norra", 4, 9)], "GRUNDSKOLA", true)).toEqual({ gradeFrom: 5, gradeTo: 10 });
    expect(unitSpanForForm([unit("Södra", 0, 9)], "GRUNDSKOLA", true)).toEqual({ gradeFrom: 1, gradeTo: 10 });
    // Åk 1 of an approval includes the new åk 1, the former förskoleklass.
    expect(unitSpanForForm([unit("Östra", 1, 6)], "GRUNDSKOLA", true)).toEqual({ gradeFrom: 1, gradeTo: 7 });
  });

  it("takes only the units of the plan's school type", () => {
    const units = [
      unit("Grund", 4, 9, ["GR"]),
      unit("Anpassad", 1, 9, ["GRS"]),
      unit("Träning", 1, 9, ["TR"]),
      unit("Special", 1, 10, ["SP"]),
      unit("Sameskola", 1, 6, ["SAM"]),
      unit("Fritids", 0, 3, ["FTH"]),
    ];
    expect(unitSpanForForm(units, "GRUNDSKOLA", false)).toEqual({ gradeFrom: 4, gradeTo: 9 });
    expect(unitSpanForForm(units, "ANPASSAD_GRUNDSKOLA_AMNEN", false)).toEqual({ gradeFrom: 1, gradeTo: 9 });
    expect(unitSpanForForm(units, "ANPASSAD_GRUNDSKOLA_AMNESOMRADEN", false)).toEqual({ gradeFrom: 1, gradeTo: 9 });
    expect(unitSpanForForm(units, "SPECIALSKOLA", false)).toEqual({ gradeFrom: 1, gradeTo: 10 });
    expect(unitSpanForForm(units, "SAMESKOLA", false)).toEqual({ gradeFrom: 1, gradeTo: 6 });
  });

  it("counts a unit with several school types for each, and none with a span half set", () => {
    expect(unitSpanForForm([unit("F–6", 0, 6, ["FKLASS", "GR"])], "GRUNDSKOLA", false)).toEqual({
      gradeFrom: 0,
      gradeTo: 6,
    });
    expect(unitSpanForForm([unit("Utan", null, null), unit("Halv", 4, null), unit("Halv", null, 9)], "GRUNDSKOLA", false)).toBeNull();
    expect(unitSpanForForm([unit("Utan", null, null), unit("Norra", 7, 9)], "GRUNDSKOLA", false)).toEqual({
      gradeFrom: 7,
      gradeTo: 9,
    });
  });

  it("is null when no unit matches: there is nothing to prefill with", () => {
    expect(unitSpanForForm([], "GRUNDSKOLA", false)).toBeNull();
    expect(unitSpanForForm([unit("Special", 1, 10, ["SP"])], "GRUNDSKOLA", false)).toBeNull();
    // A unit that holds förskoleklass only has no årskurs in the tioårig numbering.
    expect(unitSpanForForm([unit("F", 0, 0, ["GR"])], "GRUNDSKOLA", true)).toBeNull();
  });
});

describe("the årskurser a form has, and the selects offer", () => {
  it("offers F and 1–9 for the nine-year grundskola, 0–10 for the specialskola, 0–6 for the sameskola", () => {
    expect(spanGradeOptions(B1)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(spanGradeOptions(SPECIALSKOLA)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(spanGradeOptions(SAMESKOLA)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("counts 1..10 in the tioårig lydelse, whose årskurs 1 is the former förskoleklass: no row 0", () => {
    expect(spanGradeOptions(LAW_2028)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(spanGradeOptions(SPECIALSKOLA_2028)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(formGrades(LAW_2028)[0]).toBe(1);
  });

  it("knows when a span holds every årskurs of the form", () => {
    expect(spanHoldsWholeForm({ gradeFrom: 0, gradeTo: 9 }, B1)).toBe(true);
    expect(spanHoldsWholeForm({ gradeFrom: 1, gradeTo: 9 }, B1)).toBe(true);
    expect(spanHoldsWholeForm({ gradeFrom: 4, gradeTo: 9 }, B1)).toBe(false);
    expect(spanHoldsWholeForm({ gradeFrom: 1, gradeTo: 9 }, LAW_2028)).toBe(false);
    expect(spanHoldsWholeForm({ gradeFrom: 1, gradeTo: 10 }, LAW_2028)).toBe(true);
  });
});

describe("suggestedSpan: what a new plan, a copy and a span dialog start from", () => {
  it("is the skolenheternas span for the plan's lydelse", () => {
    const units = [unit("Norra", 4, 9)];
    expect(suggestedSpan(units, B1)).toEqual({ gradeFrom: 4, gradeTo: 9 });
    expect(suggestedSpan(units, LAW_2028)).toEqual({ gradeFrom: 5, gradeTo: 10 });
  });

  it("is none for a teacher, who never fetches the skolenheter, and for a school with no matching unit", () => {
    expect(suggestedSpan(undefined, B1)).toBeNull();
    expect(suggestedSpan([], B1)).toBeNull();
    expect(suggestedSpan([unit("Special", 1, 10, ["SP"])], B1)).toBeNull();
  });

  it("is the whole form, not a span, when the units hold every årskurs of the form", () => {
    expect(suggestedSpan([unit("F–9", 0, 9)], B1)).toBeNull();
    expect(suggestedSpan([unit("1–9", 1, 9)], B1)).toBeNull();
    expect(suggestedSpan([unit("0–9", 0, 9)], LAW_2028)).toBeNull();
  });
});

describe("spanNotice: when the plan's årskurser are not the skolenheternas", () => {
  const norra = [unit("Norra", 4, 9)];

  it("names both spans when they differ", () => {
    // A plan spanning 1–9 is the whole form: the lågstadium the units lack still counts.
    expect(spanNotice({ gradeFrom: 1, gradeTo: 9 }, norra, B1)).toEqual({
      plan: { gradeFrom: 1, gradeTo: 9 },
      units: { gradeFrom: 4, gradeTo: 9 },
    });
    expect(spanNotice({ gradeFrom: 4, gradeTo: 6 }, norra, B1)).toEqual({
      plan: { gradeFrom: 4, gradeTo: 6 },
      units: { gradeFrom: 4, gradeTo: 9 },
    });
  });

  it("is quiet when the plan's span is the units'", () => {
    expect(spanNotice({ gradeFrom: 4, gradeTo: 9 }, norra, B1)).toBeNull();
  });

  it("says so for a plan with no span against units that do not hold the whole form", () => {
    expect(spanNotice(null, norra, B1)).toEqual({ plan: null, units: { gradeFrom: 4, gradeTo: 9 } });
    expect(spanNotice(null, [unit("F–9", 0, 9)], B1)).toBeNull();
  });

  it("compares the årskurser the form has: F–6 units and a 1–6 plan judge the same", () => {
    expect(spanNotice({ gradeFrom: 1, gradeTo: 6 }, [unit("F–6", 0, 6)], B1)).toBeNull();
    expect(spanNotice({ gradeFrom: 0, gradeTo: 6 }, [unit("1–6", 1, 6)], B1)).toBeNull();
  });

  it("compares in the plan's numbering: nine-year units 4–9 are 5–10 against a 2028 plan", () => {
    expect(spanNotice({ gradeFrom: 5, gradeTo: 10 }, norra, LAW_2028)).toBeNull();
    expect(spanNotice({ gradeFrom: 4, gradeTo: 9 }, norra, LAW_2028)).toEqual({
      plan: { gradeFrom: 4, gradeTo: 9 },
      units: { gradeFrom: 5, gradeTo: 10 },
    });
  });

  it("has nothing to say with no skolenheter to read (a teacher), or none of the plan's school type", () => {
    expect(spanNotice({ gradeFrom: 4, gradeTo: 6 }, undefined, B1)).toBeNull();
    expect(spanNotice({ gradeFrom: 4, gradeTo: 6 }, [], B1)).toBeNull();
    expect(spanNotice({ gradeFrom: 4, gradeTo: 6 }, [unit("Special", 1, 10, ["SP"])], B1)).toBeNull();
  });
});

describe("copySpanRequest: a copy says nothing of the span unless it was changed", () => {
  const s49 = { gradeFrom: 4, gradeTo: 9 };
  it("leaves the keys out while the fields show the source's own span", () => {
    expect(copySpanRequest(s49, s49)).toBeUndefined();
    expect(copySpanRequest(null, null)).toBeUndefined();
  });

  it("states a changed span, and null for the whole form", () => {
    expect(copySpanRequest({ gradeFrom: 5, gradeTo: 9 }, s49)).toEqual({ gradeFrom: 5, gradeTo: 9 });
    expect(copySpanRequest(null, s49)).toBeNull();
  });

  it("states the suggestion for a source with no span: the reopened draft is given one", () => {
    expect(copySpanRequest(s49, null)).toEqual(s49);
  });
});

describe("small helpers", () => {
  it("compares spans by their ends, null with null", () => {
    expect(sameSpan(null, null)).toBe(true);
    expect(sameSpan(null, { gradeFrom: 1, gradeTo: 2 })).toBe(false);
    expect(sameSpan({ gradeFrom: 1, gradeTo: 2 }, { gradeFrom: 1, gradeTo: 2 })).toBe(true);
    expect(sameSpan({ gradeFrom: 1, gradeTo: 2 }, { gradeFrom: 1, gradeTo: 3 })).toBe(false);
  });

  it("keeps a plan with a span from a lydelse that numbers the årskurser the other way", () => {
    expect(versionKeepsNumbering("HT2023", "HT2024")).toBe(true);
    expect(versionKeepsNumbering("HT2023", "HT2028")).toBe(false);
    expect(versionKeepsNumbering("HT2028", "HT2029")).toBe(true);
  });

  it("writes a span in words: a range, or one årskurs", () => {
    const t = (key: string, values?: Record<string, string | number>) => `${key}(${Object.values(values ?? {}).join("|")})`;
    expect(spanText(t, { gradeFrom: 4, gradeTo: 9 })).toBe("spanRange(4|9)");
    expect(spanText(t, { gradeFrom: 9, gradeTo: 9 })).toBe("spanOne(9)");
  });
});
