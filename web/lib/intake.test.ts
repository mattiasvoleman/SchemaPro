import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { GRADE_GAPS, KNOWN_GAP_CODES, ownerOf } from "@/lib/intake";

/*
 * Vad kom in's seam: the gateway decides what is a gap and how hard (src/intake/intake.ts), the web gives each its words and the
 * page that owns it. A gap the gateway has and the web lacks is shown as its bare code and with no link, and "no gap" is then said
 * over a gap the person cannot read; this holds the two to each other the way the unit specs of either cannot.
 */

const GATEWAY = readFileSync(join(__dirname, "..", "..", "src", "intake", "intake.ts"), "utf8");

const gatewayGaps = [...GATEWAY.matchAll(/\{ code: '([A-Z_]+)', area: '([A-Z_]+)', level: '(HARD|SOFT|INFO)' \}/g)].map((match) => ({
  code: match[1]!,
  area: match[2]!,
  level: match[3]!,
}));
const gatewayAreas = [...(/INTAKE_AREAS = \[([\s\S]*?)\] as const/.exec(GATEWAY)?.[1] ?? "").matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]!);
const gatewayFound = Object.fromEntries(
  [...(/INTAKE_FOUND[^=]*= \{([\s\S]*?)\n\};/.exec(GATEWAY)?.[1] ?? "").matchAll(/([A-Z_]+): \[([^\]]*)\]/g)].map((match) => [
    match[1]!,
    [...match[2]!.matchAll(/'(\w+)'/g)].map((key) => key[1]!),
  ]),
) as Record<string, string[]>;

const gatewayYearBound = [...(/YEAR_BOUND_AREAS[^=]*= \[([\s\S]*?)\];/.exec(GATEWAY)?.[1] ?? "").matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]!);

describe("what this test reads of the gateway", () => {
  it("is every gap, area and found-count (a parse that finds nothing would pass everything below)", () => {
    expect(gatewayGaps.length).toBeGreaterThan(15);
    expect(gatewayAreas).toHaveLength(11);
    expect(Object.keys(gatewayFound)).toEqual(gatewayAreas);
    expect(gatewayYearBound.length).toBeGreaterThan(3);
    expect(gatewayYearBound.every((area) => gatewayAreas.includes(area))).toBe(true);
  });
});

describe.each([
  ["sv", sv.intake],
  ["en", en.intake],
])("the %s texts of Vad kom in", (_language, messages) => {
  it("have a title and a hint for every gap the gateway has, and none for a gap it has not", () => {
    const codes = gatewayGaps.map((entry) => entry.code);
    expect(Object.keys(messages.gaps).sort()).toEqual([...codes].sort());
    for (const code of codes) {
      const entry = (messages.gaps as Record<string, { title: string; hint: string }>)[code]!;
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.hint.length).toBeGreaterThan(0);
    }
  });

  it("name the areas in the order the gateway gives them, and every count an area finds", () => {
    expect(Object.keys(messages.areas)).toEqual(gatewayAreas);
    const found = Object.keys(messages.found).sort();
    expect(found).toEqual([...new Set(Object.values(gatewayFound).flat())].sort());
  });

  it("say, for a post with no teacher, what is different when the school has chosen Vägra", () => {
    expect((messages.gaps.UNSTAFFED_POSTS as { hintHard?: string }).hintHard?.length).toBeGreaterThan(0);
  });

  it("say that an area waits for the year, which only the year-bound areas do", () => {
    expect((messages as { waitsForYear: string }).waitsForYear.length).toBeGreaterThan(0);
  });

  it("name the three levels", () => {
    expect(Object.keys(messages.levels).sort()).toEqual(["HARD", "INFO", "SOFT"]);
  });
});

describe("the page that owns each gap", () => {
  it("is known for every gap the gateway has, and for no code it has not", () => {
    expect([...KNOWN_GAP_CODES].sort()).toEqual(gatewayGaps.map((entry) => entry.code).sort());
  });

  it("is a row of the admin menu: the link is to a page the menu names, by the menu's own word", () => {
    const nav = sv.nav as Record<string, string>;
    const menu = readFileSync(join(__dirname, "..", "components", "layout", "admin-nav.ts"), "utf8");
    for (const code of KNOWN_GAP_CODES) {
      const owner = ownerOf(code)!;
      expect(nav[owner.navKey], `${code}: a menu label for ${owner.navKey}`).toBeTruthy();
      expect(menu, `${code}: ${owner.href} is a row of the admin menu`).toContain(`{ labelKey: "${owner.navKey}", href: "${owner.href}"`);
    }
  });

  it("is none for a code a newer gateway has", () => {
    expect(ownerOf("A_GAP_FROM_NEXT_YEAR")).toBeNull();
  });
});

describe("the gaps that list årskurser as numbers", () => {
  it("are the three whose items the gateway reads off the årskurs, and no gap that lists names", () => {
    // FRAME_TIMES_MISSING, TIMPLAN_MISSING and TIMPLAN_NOT_DECIDED are written with asItems (a number as a string) in intake.ts.
    const asItems = [...GATEWAY.matchAll(/^\s+([A-Z_]+): (?:yearBound\()?asItems\(/gm)].map((match) => match[1]!);
    expect([...GRADE_GAPS].sort()).toEqual(asItems.sort());
  });
});
