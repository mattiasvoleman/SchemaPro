import { describe, expect, it } from "vitest";
import fixture from "../../src/meal-counts/__fixtures__/week.json";
import {
  addDays,
  changeOf,
  csvName,
  formOf,
  formProblem,
  isKitchenEmail,
  letterPossible,
  type MealCountsView,
  type MealSettings,
  type MealSettingsForm,
} from "@/lib/meal-counts";

/** The view the gateway builds (src/meal-counts/meal-counts.spec.ts holds it to its rows), read under the page's own types. */
const view: MealCountsView = fixture.view;

describe("the contract with the gateway", () => {
  it("is a view the page's types accept, with a day to the date and a sitting to the window", () => {
    expect(view.days.map((day) => day.date)).toEqual(["2027-02-04", "2027-02-05", "2027-02-06", "2027-02-07", "2027-02-08", "2027-02-09", "2027-02-10"]);
    expect(view.days[0]!.sittings.map((s) => [s.start, s.end, s.portions])).toEqual([
      ["10:30", "11:00", 50],
      ["11:00", "11:30", 30],
    ]);
    expect(view.days[0]!.totals).toEqual({ pupils: 79, absentBefore: 3, staff: 4, portions: 80, absentAfter: 4, underActivity: 30 });
    expect(view.cutoff).toBe("08:30");
    expect(view.staffModelled).toBe(true);
  });

  it("carries no pupil: counts, times and the names of classes", () => {
    expect(JSON.stringify(view)).not.toMatch(/studentId|email|firstName|lastName|diet|allerg/i);
  });
});

describe("addDays", () => {
  it("counts calendar days, across a month, a year and a leap day, whatever the browser's zone", () => {
    expect(addDays("2027-02-04", 6)).toBe("2027-02-10");
    expect(addDays("2027-02-26", 4)).toBe("2027-03-02");
    expect(addDays("2027-12-30", 3)).toBe("2028-01-02");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addDays("2027-03-01", -1)).toBe("2027-02-28");
    expect(addDays("2027-03-28", 1)).toBe("2027-03-29");
    expect(addDays("2027-10-31", 1)).toBe("2027-11-01");
  });
});

describe("csvName", () => {
  it("is named for the day, or for the first and the last, as the gateway names it", () => {
    expect(csvName("2027-02-04", "2027-02-04")).toBe("portioner-2027-02-04.csv");
    expect(csvName("2027-02-04", "2027-02-10")).toBe("portioner-2027-02-04-2027-02-10.csv");
  });
});

describe("isKitchenEmail", () => {
  it("takes one address", () => {
    expect(isKitchenEmail("kok@skolan.se")).toBe(true);
    expect(isKitchenEmail("kok.skolan+mat@kommun.example.se")).toBe(true);
  });
  it.each(["", "kok", "kok@skolan", "a@b.se, c@d.se", "a@b.se;c@d.se", "Köket <kok@skolan.se>", "a b@skolan.se", `${"a".repeat(250)}@skolan.se`])("refuses %j", (value) => {
    expect(isKitchenEmail(value)).toBe(false);
  });
});

const stored: MealSettings = { cutoffTime: "08:30", letterEnabled: true, kitchenEmail: "kok@skolan.se", lastLetterOn: "2027-02-03" };
const form = (over: Partial<MealSettingsForm> = {}): MealSettingsForm => ({ ...formOf(stored), ...over });

describe("the settings form", () => {
  it("starts from what is stored, with none as empty text", () => {
    expect(formOf(stored)).toEqual({ cutoff: "08:30", email: "kok@skolan.se", enabled: true });
    expect(formOf({ cutoffTime: null, letterEnabled: false, kitchenEmail: null, lastLetterOn: null })).toEqual({ cutoff: "", email: "", enabled: false });
  });

  it("can hold the letter on only with an hour and one address", () => {
    expect(letterPossible(form())).toBe(true);
    expect(letterPossible(form({ cutoff: "" }))).toBe(false);
    expect(letterPossible(form({ email: "" }))).toBe(false);
    expect(letterPossible(form({ email: "  kok@skolan.se " }))).toBe(true);
    expect(letterPossible(form({ cutoff: "24:00" }))).toBe(false);
  });

  it("names the first thing wrong, in the order the fields stand", () => {
    expect(formProblem(form())).toBeNull();
    expect(formProblem(form({ cutoff: "8:30" }))).toBe("cutoff");
    expect(formProblem(form({ email: "a@b.se, c@d.se" }))).toBe("email");
    expect(formProblem(form({ cutoff: "", enabled: true }))).toBe("letter");
    expect(formProblem(form({ email: "", enabled: true }))).toBe("letter");
    expect(formProblem(form({ cutoff: "", email: "", enabled: false }))).toBeNull();
    expect(formProblem(form({ cutoff: "8:30", email: "x" }))).toBe("cutoff");
  });

  it("saves what differs and nothing else, an empty field as null", () => {
    expect(changeOf(form(), stored)).toEqual({});
    expect(changeOf(form({ cutoff: "09:00" }), stored)).toEqual({ cutoffTime: "09:00" });
    expect(changeOf(form({ email: " ny@skolan.se " }), stored)).toEqual({ kitchenEmail: "ny@skolan.se" });
    expect(changeOf(form({ enabled: false, cutoff: "", email: "" }), stored)).toEqual({ cutoffTime: null, kitchenEmail: null, letterEnabled: false });
    expect(changeOf(form({ email: "kok@skolan.se " }), stored)).toEqual({});
  });
});
