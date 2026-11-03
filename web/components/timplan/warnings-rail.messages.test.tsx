import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import { checkLocalTimplan, type GradeSpan, type TimplanVerdict } from "@/lib/timplan-coverage";
import { cellKey, entriesFromDraft, toCoverageVersion } from "@/lib/timplan-view";
import { B1, LAW_2028, NATIONAL } from "@/lib/__fixtures__/timplan-statute";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { WarningsRail } from "./warnings-rail";

/*
 * The rail's sentences for a plan with an årskurs span, with the real messages
 * and the figures the real check hands out: the other rail test echoes keys,
 * so it proves which sentence is CHOSEN but not what it then says. The
 * Swedish is the gateway's own wording (src/timplan/timplan-verdict-messages.ts).
 */

const SUBJECTS = [
  { id: "s-ma", name: "Matematik", nationalCode: "MA", countsTowardTimplan: true },
  { id: "s-bi", name: "Biologi", nationalCode: "BI", countsTowardTimplan: true },
  { id: "s-ke", name: "Kemi", nationalCode: "KE", countsTowardTimplan: true },
];
const names = new Map(NATIONAL.subjects.map((subject) => [subject.code, subject.name]));

function verdictsOf(span: GradeSpan, cells: Record<string, number>, version = B1): TimplanVerdict[] {
  const draft = new Map(Object.entries(cells).map(([key, minutes]) => [key, String(minutes)]));
  return checkLocalTimplan({
    planningWeeksTenths: 356,
    version: toCoverageVersion(version),
    nationalSubjects: NATIONAL.subjects,
    subjects: SUBJECTS,
    entries: entriesFromDraft(draft, new Map()).entries,
    gradeSpan: span,
  }).verdicts;
}

function show(locale: "sv" | "en", verdicts: TimplanVerdict[]) {
  render(
    <NextIntlClientProvider locale={locale} messages={locale === "sv" ? sv : en}>
      <WarningsRail verdicts={verdicts} nationalNames={names} live={false} selected={null} onSelect={() => {}} />
    </NextIntlClientProvider>,
  );
  // The sentence of the first verdict with this code that names `about`, if given.
  return (code: string, about?: string) =>
    screen.getAllByRole("button").find(
      (button) => button.getAttribute("data-code") === code && (about === undefined || button.textContent!.includes(about)),
    )?.textContent ?? "";
}

describe("the rail, in Swedish, for a plan that holds part of a stadium", () => {
  // F–5: mellanstadiet is two thirds held. Matematik short in it, and Kemi under its share of the minimum.
  const f5 = verdictsOf(
    { gradeFrom: 0, gradeTo: 5 },
    {
      [cellKey("s-ma", 4)]: 100,
      [cellKey("s-ma", 5)]: 100,
      [cellKey("s-bi", 4)]: 120,
      [cellKey("s-bi", 5)]: 120,
      [cellKey("s-ke", 4)]: 10,
    },
  );

  it("says how many of the stadium's årskurser the school has, and that the share is an estimate", () => {
    const say = show("sv", f5);
    const text = say("TIMPLAN_PARTIAL_STAGE_BELOW_SHARE", "Matematik i mellanstadiet");
    expect(text).toContain("Matematik i mellanstadiet: skolan har 2 av 3 årskurser i stadiet. ");
    expect(text).toContain("under andelen");
    expect(text).toContain("av stadiets timmar");
    expect(text).toContain("Andelen är en uppskattning, eftersom huvudmannen fördelar tiden fritt mellan årskurserna.");
    expect(text).toMatch(/^Notering/);
    expect(text).not.toMatch(/\bfel\b/i);
    // The merged cell is cut over all the årskurser it spans: five of six.
    expect(say("TIMPLAN_PARTIAL_STAGE_BELOW_SHARE", "låg- och mellanstadiet")).toContain("skolan har 5 av 6 årskurser i stadiet");
  });

  it("names the child and its share of the minimum, in a sentence of its own", () => {
    const child = f5.find((v) => v.code === "TIMPLAN_PARTIAL_STAGE_BELOW_SHARE" && v.childCode === "KE");
    expect(child).toBeDefined();
    const text = show("sv", [child!])("TIMPLAN_PARTIAL_STAGE_BELOW_SHARE");
    expect(text).toMatch(/^Notering/);
    expect(text).toContain("Kemi i mellanstadiet: skolan har 2 av 3 årskurser i stadiet.");
    expect(text).toContain("under andelen");
    expect(text).toContain("av minsta tiden inom");
    expect(text).toContain("Andelen är en uppskattning.");
    expect(text).not.toContain("eftersom huvudmannen");
  });

  it("calls the pool and the guarantee of a part of the form estimates, and a whole form's plainly", () => {
    const part = verdictsOf({ gradeFrom: 4, gradeTo: 9 }, {});
    const say = show("sv", part);
    expect(say("TIMPLAN_SKOLANS_VAL_OVERSPENT")).toContain("timplanen medger (en uppskattning efter planens årskurser).");
    expect(say("TIMPLAN_TOTAL_BELOW_GUARANTEE")).toMatch(/undervisningstiden 4 988 h \(en uppskattning efter planens årskurser\)\.$|undervisningstiden 4988 h \(en uppskattning efter planens årskurser\)\.$/);
  });

  it("says a pool or a total that only the stadier held in part breach is a notice, and a warning's sentence does not", () => {
    const notice = (code: "TIMPLAN_SKOLANS_VAL_OVERSPENT" | "TIMPLAN_TOTAL_BELOW_GUARANTEE"): TimplanVerdict => ({
      code,
      severity: "notice",
      params:
        code === "TIMPLAN_TOTAL_BELOW_GUARANTEE"
          ? { plannedHours: 3007, guaranteedHours: 3471.4, deficitHours: 464.4, estimated: 1, fromShares: 1 }
          : { takenHours: 620, availableHours: 302.3, overspentHours: 317.7, estimated: 1, fromShares: 1 },
    });
    const say = show("sv", [notice("TIMPLAN_SKOLANS_VAL_OVERSPENT"), notice("TIMPLAN_TOTAL_BELOW_GUARANTEE")]);
    for (const code of ["TIMPLAN_SKOLANS_VAL_OVERSPENT", "TIMPLAN_TOTAL_BELOW_GUARANTEE"]) {
      const text = say(code);
      expect(text).toMatch(/^Notering/);
      expect(text).toContain("(en uppskattning efter planens årskurser).");
      expect(text).toContain("Det ligger helt i stadier som skolan bara har delvis, där andelen är en uppskattning, och är därför bara en notis.");
    }
    // The warning's own sentence, estimate and all, never says notis.
    cleanup();
    const warning = verdictsOf({ gradeFrom: 4, gradeTo: 9 }, {});
    const warned = show("sv", warning)("TIMPLAN_TOTAL_BELOW_GUARANTEE");
    expect(warned).toMatch(/^Under mål/);
    expect(warned).not.toContain("bara en notis");
  });

  it("states them without the word for a plan with no span", () => {
    const whole = checkLocalTimplan({
      planningWeeksTenths: 356,
      version: toCoverageVersion(B1),
      nationalSubjects: NATIONAL.subjects,
      subjects: SUBJECTS,
      entries: [],
    }).verdicts;
    const say = show("sv", whole);
    expect(say("TIMPLAN_SKOLANS_VAL_OVERSPENT")).not.toContain("uppskattning");
    expect(say("TIMPLAN_TOTAL_BELOW_GUARANTEE")).not.toContain("uppskattning");
    expect(say("TIMPLAN_TOTAL_BELOW_GUARANTEE")).toMatch(/undervisningstiden 6 890 h\.$|undervisningstiden 6890 h\.$/);
  });

  it("says the total belongs to the whole form and is not compared, for a lydelse with no cells", () => {
    const verdicts = verdictsOf({ gradeFrom: 5, gradeTo: 10 }, {}, LAW_2028);
    const text = show("sv", verdicts)("TIMPLAN_TOTAL_NOT_JUDGED_FOR_SPAN");
    expect(text).toContain("Planen gäller årskurs 5–10, och den garanterade totalen");
    expect(text).toContain("gäller hela skolformen. Totalen jämförs därför inte.");
    expect(verdicts.some((v) => v.code === "TIMPLAN_TOTAL_BELOW_GUARANTEE")).toBe(false);
  });
});

describe("the rail, in English, for the same verdicts", () => {
  it("has a sentence for each, with the figures and the word estimate", () => {
    const f5 = verdictsOf({ gradeFrom: 0, gradeTo: 5 }, { [cellKey("s-ma", 4)]: 100, [cellKey("s-ke", 4)]: 10 });
    const say = show("en", [
      ...f5,
      ...verdictsOf({ gradeFrom: 4, gradeTo: 9 }, {}),
      ...verdictsOf({ gradeFrom: 5, gradeTo: 10 }, {}, LAW_2028),
    ]);
    expect(say("TIMPLAN_PARTIAL_STAGE_BELOW_SHARE", "Matematik in the middle stage")).toContain("the school has 2 of the stage's 3 years");
    expect(say("TIMPLAN_PARTIAL_STAGE_BELOW_SHARE", "Matematik")).toContain("The share is an estimate");
    expect(say("TIMPLAN_SKOLANS_VAL_OVERSPENT")).toContain("the timplan allows (an estimate for the plan's years).");
    expect(say("TIMPLAN_TOTAL_BELOW_GUARANTEE")).toContain("(an estimate for the plan's years).");
    expect(say("TIMPLAN_TOTAL_NOT_JUDGED_FOR_SPAN")).toContain("The plan is for years 5–10");
    expect(say("TIMPLAN_TOTAL_NOT_JUDGED_FOR_SPAN")).toContain("The total is therefore not compared.");
  });
});
