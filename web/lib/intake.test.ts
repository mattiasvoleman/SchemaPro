import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import { GRADE_GAPS, KNOWN_GAP_CODES, ownerOf, type IntakeView } from "@/lib/intake";

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
    // Every definition line, not only the ones the strict shape above reads: a gap written with another key, or on two lines, is a gap this file
    // would otherwise never compare (the texts, the stub's levels and its order all hang on this list).
    expect(gatewayGaps, "a GAP_DEFINITIONS entry that the parse above does not read").toHaveLength([...GATEWAY.matchAll(/\{ code: '[A-Z_]+', area: /g)].length);
    expect(gatewayAreas).toHaveLength(15);
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

  it("say that the page counts the ACTIVE läsår and not a year planned for the next term (the route takes no year; the Generera page plans the successor)", () => {
    const text = messages as { year: string; intro: string };
    expect(text.year).toMatch(/\{name\}/);
    expect(text.year.toLowerCase()).toMatch(/aktivt|active/);
    expect(text.intro.toLowerCase()).toMatch(/aktiva läsåret|active school year/);
    expect(text.intro.toLowerCase()).toMatch(/nästa termin|next term/);
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

/*
 * The stub's answers (e2e/stub/fixtures/gateway-intake.ts) held to the gateway's definitions (the review of #406, g406-L-7-2).
 *
 * The stub behind the browser gates answers GET /intake with three schools whose areas, gaps and levels are written by hand, and it cannot import
 * src/intake/intake.ts. A level that changes on the gateway's side (g406-L-1 moved one) then showed in no test: the page's gates drew the old level for
 * as long as nobody looked. The levels, the areas, the order and the found-counts of every answer are held to the list this file already reads.
 */
describe("the stub's answers to GET /intake", async () => {
  const { intakeRoutes } = await import("../e2e/stub/fixtures/gateway-intake");
  const handler = intakeRoutes.find((entry) => entry.method === "GET" && entry.pattern === "/api/v1/intake")!.handler;
  const answer = (scenario: string | null) =>
    handler({ person: null, params: {}, query: new URLSearchParams(), body: null, scenario, school: null }) as IntakeView;

  const SCENARIOS: [string, string | null][] = [
    ["the stub's own school (the default)", null],
    ["intake-empty", "intake-empty"],
    ["intake-demo", "intake-demo"],
  ];

  it("is found by the test (a route that was not found would fail the three below at once)", () => {
    expect(intakeRoutes.filter((entry) => entry.pattern === "/api/v1/intake")).toHaveLength(1);
  });

  describe.each(SCENARIOS)("%s", (_name, scenario) => {
    it("has the gateway's areas in the gateway's order, each with the counts the gateway gives it", () => {
      const view = answer(scenario);
      expect(view.areas.map((area) => area.area)).toEqual(gatewayAreas);
      for (const area of view.areas) expect(Object.keys(area.found), area.area).toEqual(gatewayFound[area.area]);
    });

    it("has every gap the gateway has, in its own area and in its order, at the level the gateway gives it", () => {
      const view = answer(scenario);
      for (const area of view.areas) {
        const defined = gatewayGaps.filter((entry) => entry.area === area.area);
        expect(area.gaps.map((entry) => entry.code), area.area).toEqual(defined.map((entry) => entry.code));
        for (const entry of area.gaps) {
          const definition = defined.find((one) => one.code === entry.code)!;
          // UNSTAFFED_POSTS is SOFT, and HARD for a school that has chosen Generering utan lärare: Vägra (src/intake/intake.ts `assess`).
          const allowed = entry.code === "UNSTAFFED_POSTS" ? [definition.level, "HARD"] : [definition.level];
          expect(allowed, `${area.area} ${entry.code} is ${entry.level} in the stub and ${definition.level} in the gateway`).toContain(entry.level);
        }
      }
    });

    it("waits for the year in exactly the areas the gateway says belong to a year, and only for a school with none (`waitsForYear: !hasYear && YEAR_BOUND_AREAS.includes(area)`)", () => {
      const view = answer(scenario);
      for (const area of view.areas) {
        if (area.waitsForYear) expect(view.year, `${area.area} waits for a year the school has`).toBeNull();
        // Both ways: an area the gateway holds back for a school with no year and the stub does not (or the reverse) draws the page's "väntar på läsåret" on one side only.
        expect(area.waitsForYear, `${area.area}: the stub's waitsForYear for a school ${view.year === null ? "with no year" : "with a year"}`).toBe(
          view.year === null && gatewayYearBound.includes(area.area),
        );
      }
    });

    it("counts its own levels: hard, soft and info are the gaps that are there, by level", () => {
      const view = answer(scenario);
      const there = view.areas.flatMap((area) => area.gaps).filter((entry) => entry.count > 0);
      expect({ hard: view.hard, soft: view.soft, info: view.info }).toEqual({
        hard: there.filter((entry) => entry.level === "HARD").length,
        soft: there.filter((entry) => entry.level === "SOFT").length,
        info: there.filter((entry) => entry.level === "INFO").length,
      });
    });
  });
});
