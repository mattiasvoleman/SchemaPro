import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * ÅTGÄRDSFÖRSLAG VID VÄGRAN: the web's mirror of the gateway's types, held to the source (the review of #388, g388-L-5e).
 *
 * lib/suggestion-types.ts says what the gateway sends of the analysis of a run (src/optimization/suggestions.ts): "Types only, mirrored by
 * hand". Nothing bound the two, so a field renamed on one side was found by a page that read `undefined`, and a rule, a proof or a failure
 * added on the gateway's side was a code the card had no sentence for. The gateway's own contract spec (suggestions-contract.spec.ts) binds the
 * engine and the gateway; this binds the gateway and the web. It reads the gateway's two files as text, as intake.test.ts reads
 * src/intake/intake.ts: the web cannot import them, and CI checks the whole repository out.
 *
 * What is compared: the closed sets (the five rules, the three proofs, the four verdicts, the three states, the five failures), and the
 * fields of the change and of the answer, each by name and by the type it is declared with.
 */

const ROOT = join(__dirname, "..", "..");
const GATEWAY_INTERFACE = readFileSync(join(ROOT, "src", "optimization", "interfaces", "suggest-changes.interface.ts"), "utf8");
const GATEWAY = readFileSync(join(ROOT, "src", "optimization", "suggestions.ts"), "utf8");
const WEB = readFileSync(join(__dirname, "suggestion-types.ts"), "utf8");
const GATEWAY_REPORT = readFileSync(join(ROOT, "src", "optimization", "timeout-report.ts"), "utf8");
const QUERIES = readFileSync(join(__dirname, "queries.ts"), "utf8");

/** The strings of `export const NAME = [ 'A', 'B' ] as const`. */
function gatewayList(source: string, name: string): string[] {
  const body = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`).exec(source)?.[1] ?? "";
  return [...body.matchAll(/'([A-Z_]+)'/g)].map((found) => found[1]!);
}

/** The strings of `export type NAME = "A" | "B"` (one declaration, however many lines). */
function webUnion(name: string): string[] {
  const body = new RegExp(`export type ${name} =([^;]*);`).exec(WEB)?.[1] ?? "";
  return [...body.matchAll(/"([A-Z_]+)"/g)].map((found) => found[1]!);
}

/** The fields of `export interface NAME { ... }`, by name, with their declared type text. A field has one line; comments between are skipped. */
function fields(source: string, name: string): Map<string, string> {
  const body = new RegExp(`export interface ${name} \\{\\n([\\s\\S]*?)\\n\\}`).exec(source)?.[1] ?? "";
  const found = new Map<string, string>();
  for (const line of body.split("\n")) {
    const field = /^ {2}(\w+)(\??): ([^;]+);/.exec(line);
    if (field) found.set(field[1]!, `${field[2]}${field[3]!}`);
  }
  return found;
}

/** A type as text, without blanks and in the web's names: the gateway's `SuggestVerdict` is the web's `SuggestionVerdict`, and so on. */
const ALIASES: [RegExp, string][] = [
  [/\bSuggestVerdict\b/g, "SuggestionVerdict"],
  [/\bSuggestionsState\b/g, '"RUNNING"|"DONE"|"FAILED"'],
  [/\bTimeoutReportView\b/g, "SuggestionReport"],
  [/\bStoredChange\b/g, "SuggestionChange"],
  [/\bSuggestionChangeView\b/g, "SuggestionChange"],
];
const asWeb = (type: string): string => ALIASES.reduce((text, [from, to]) => text.replace(from, to), type.replace(/\s+/g, ""));

/**
 * What differs between the gateway's list and the web's, as the sentence a failing build is mended from. The gateway adds a rule, a proof, a
 * failure or a field and the web has none for it (an additive change, which is how the gateway is allowed to move): the sentence names it and
 * says where it goes, so that the diff below it is not the only thing read.
 */
function missingAndExtra(what: string, web: readonly string[], gateway: readonly string[]): string {
  const missing = gateway.filter((name) => !web.includes(name));
  const extra = web.filter((name) => !gateway.includes(name));
  return [
    missing.length > 0 ? `the gateway has ${missing.join(", ")} (${what}) that web/lib/suggestion-types.ts lacks: add it there, and give the card a sentence for it` : "",
    extra.length > 0 ? `web/lib/suggestion-types.ts has ${extra.join(", ")} (${what}) that the gateway has not` : "",
    missing.length === 0 && extra.length === 0 ? `${what}: the same names in another order` : "",
  ]
    .filter((line) => line !== "")
    .join("; ");
}

describe("what this test reads (a parse that finds nothing would pass everything below)", () => {
  // These numbers are the parse's, and they move when the gateway adds a name: the tests below say which name, and these only that the count moved.
  const COUNT = "the count moved: update it here when the name is added to web/lib/suggestion-types.ts (the tests below say which name)";
  it("finds every set and every field it compares", () => {
    expect(gatewayList(GATEWAY_INTERFACE, "SUGGESTION_RULES"), COUNT).toHaveLength(5);
    expect(gatewayList(GATEWAY_INTERFACE, "SUGGESTION_PROOFS"), COUNT).toHaveLength(3);
    expect(gatewayList(GATEWAY_INTERFACE, "SUGGEST_VERDICTS"), COUNT).toHaveLength(4);
    expect(gatewayList(GATEWAY, "SUGGESTION_STATES"), COUNT).toHaveLength(3);
    expect(gatewayList(GATEWAY, "SUGGESTION_FAILURES"), COUNT).toHaveLength(5);
    expect(webUnion("SuggestionRule"), COUNT).toHaveLength(5);
    expect(fields(GATEWAY, "StoredChange").size, COUNT).toBe(14);
    expect(fields(GATEWAY, "SuggestionsStored").size, COUNT).toBe(13);
    expect(fields(WEB, "SuggestionChange").size, COUNT).toBe(14);
    expect(fields(WEB, "Suggestions").size, COUNT).toBe(12);
  });
});

describe("the closed sets the card has a sentence for", () => {
  it.each([
    ["the rules, mildest first", webUnion("SuggestionRule"), gatewayList(GATEWAY_INTERFACE, "SUGGESTION_RULES")],
    ["the proofs", webUnion("SuggestionProof"), gatewayList(GATEWAY_INTERFACE, "SUGGESTION_PROOFS")],
    ["the verdicts", webUnion("SuggestionVerdict"), gatewayList(GATEWAY_INTERFACE, "SUGGEST_VERDICTS")],
    ["the failures", webUnion("SuggestionsFailure"), gatewayList(GATEWAY, "SUGGESTION_FAILURES")],
  ])("%s are the gateway's, in its order", (name, web, gateway) => {
    expect(web, missingAndExtra(name, web, gateway)).toEqual(gateway);
  });

  it("the states are the gateway's", () => {
    const state = /^ {2}state: ([^;]+);/m.exec(WEB.slice(WEB.indexOf("export interface Suggestions {")))?.[1] ?? "";
    expect([...state.matchAll(/"([A-Z_]+)"/g)].map((found) => found[1])).toEqual(gatewayList(GATEWAY, "SUGGESTION_STATES"));
  });
});

describe("the fields of a change", () => {
  // The view the page reads is the stored change without the Users ids and with the teachers named
  // (`SuggestionChangeView = Omit<StoredChange, 'teacherIds'> & { teacherNames: string[] }`).
  const gatewayView = new Map(fields(GATEWAY, "StoredChange"));
  gatewayView.delete("teacherIds");
  gatewayView.set("teacherNames", "string[]");

  it("says the gateway's view is the stored change without teacherIds and with teacherNames (so that the line above is the one this reads)", () => {
    expect(GATEWAY).toMatch(/export type SuggestionChangeView = Omit<StoredChange, 'teacherIds'> & \{ teacherNames: string\[\] \};/);
  });

  it("has the gateway's names, and no other", () => {
    const web = [...fields(WEB, "SuggestionChange").keys()];
    expect(web.sort(), missingAndExtra("fields of a change", web, [...gatewayView.keys()])).toEqual([...gatewayView.keys()].sort());
  });

  it.each([...gatewayView.keys()])("%s has the type the gateway declares", (field) => {
    expect(asWeb(fields(WEB, "SuggestionChange").get(field) ?? "(not a field)")).toBe(asWeb(gatewayView.get(field)!));
  });
});

describe("the fields of the answer", () => {
  // The view the page reads is the stored value without `previous` (the finished analysis a RUNNING one was asked over, G6b: the column's own, no
  // view carries it) and with its changes made views.
  const gateway = new Map(fields(GATEWAY, "SuggestionsStored"));
  gateway.delete("previous");

  it("says the gateway's view is the stored value without previous and with its changes made views (so that this reads the right interface)", () => {
    expect(GATEWAY).toMatch(
      /export type SuggestionsView = Omit<SuggestionsStored, 'changes' \| 'previous'> & \{ changes: SuggestionChangeView\[\] \};/,
    );
  });

  it("keeps the previous analysis out of the view: the page is never shown what a press was asked over", () => {
    expect([...fields(WEB, "Suggestions").keys()]).not.toContain("previous");
    expect(fields(GATEWAY, "SuggestionsStored").get("previous")).toBe("SuggestionsStored | null");
  });

  it("has the gateway's names, and no other", () => {
    const web = [...fields(WEB, "Suggestions").keys()];
    expect(web.sort(), missingAndExtra("fields of the answer", web, [...gateway.keys()])).toEqual([...gateway.keys()].sort());
  });

  it.each([...gateway.keys()])("%s has the type the gateway declares", (field) => {
    expect(asWeb(fields(WEB, "Suggestions").get(field) ?? "(not a field)")).toBe(asWeb(gateway.get(field)!));
  });
});

describe("the report of a NOT_FOUND (where the analysis' time went)", () => {
  // The analysis keeps the engine's TimeoutReport through the gateway's own whitelist (timeout-report.ts), and the page reads it as a run's
  // `TimeoutReport` (lib/queries.ts). This file writes the shape out because the gateway's typecheck cannot resolve queries.ts; so the three
  // are held to one another here, and the steps are the gateway's list.
  const names = (text: string, name: string): string[] => {
    const body = new RegExp(`export interface ${name} \\{\\n([\\s\\S]*?)\\n\\}`).exec(text)?.[1] ?? "";
    return [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((found) => found[1]!);
  };
  const stagesOf = (text: string, name: string): string[] => {
    const body = new RegExp(`export interface ${name} \\{\\n([\\s\\S]*?)\\n\\}`).exec(text)?.[1] ?? "";
    const line = /^ {2}stages: \{ stage: ([^;]+); seconds: number \}\[\];/m.exec(body)?.[1] ?? "";
    return [...line.matchAll(/"([A-Z_]+)"/g)].map((found) => found[1]!);
  };

  it("reads what it compares", () => {
    expect(names(GATEWAY_REPORT, "TimeoutReportView").length).toBeGreaterThan(6);
    expect(stagesOf(WEB, "SuggestionReport").length).toBeGreaterThan(4);
    expect(stagesOf(QUERIES, "TimeoutReport").length).toBeGreaterThan(4);
  });

  it("has the fields of the gateway's report, in its order", () => {
    expect(names(WEB, "SuggestionReport")).toEqual(names(GATEWAY_REPORT, "TimeoutReportView"));
  });

  it("names the steps the gateway has a sentence for, in its order, and is the run's report to the page", () => {
    const gateway = gatewayList(GATEWAY_REPORT, "TIMEOUT_STAGES");
    expect(stagesOf(WEB, "SuggestionReport"), missingAndExtra("steps of a report", stagesOf(WEB, "SuggestionReport"), gateway)).toEqual(gateway);
    expect(stagesOf(QUERIES, "TimeoutReport")).toEqual(stagesOf(WEB, "SuggestionReport"));
    expect(names(QUERIES, "TimeoutReport")).toEqual(names(WEB, "SuggestionReport"));
  });

  it("is a nullable `report` of the analysis the gateway keeps as the same view", () => {
    expect(fields(WEB, "Suggestions").get("report")).toBe("SuggestionReport | null");
    expect(fields(GATEWAY, "SuggestionsStored").get("report")).toBe("TimeoutReportView | null");
  });
});

