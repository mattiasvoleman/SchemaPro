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
  [/\bStoredChange\b/g, "SuggestionChange"],
  [/\bSuggestionChangeView\b/g, "SuggestionChange"],
];
const asWeb = (type: string): string => ALIASES.reduce((text, [from, to]) => text.replace(from, to), type.replace(/\s+/g, ""));

describe("what this test reads (a parse that finds nothing would pass everything below)", () => {
  it("finds every set and every field it compares", () => {
    expect(gatewayList(GATEWAY_INTERFACE, "SUGGESTION_RULES")).toHaveLength(5);
    expect(gatewayList(GATEWAY_INTERFACE, "SUGGESTION_PROOFS")).toHaveLength(3);
    expect(gatewayList(GATEWAY_INTERFACE, "SUGGEST_VERDICTS")).toHaveLength(4);
    expect(gatewayList(GATEWAY, "SUGGESTION_STATES")).toHaveLength(3);
    expect(gatewayList(GATEWAY, "SUGGESTION_FAILURES")).toHaveLength(5);
    expect(webUnion("SuggestionRule")).toHaveLength(5);
    expect(fields(GATEWAY, "StoredChange").size).toBe(13);
    expect(fields(GATEWAY, "SuggestionsStored").size).toBe(11);
    expect(fields(WEB, "SuggestionChange").size).toBe(13);
    expect(fields(WEB, "Suggestions").size).toBe(11);
  });
});

describe("the closed sets the card has a sentence for", () => {
  it.each([
    ["the rules, mildest first", webUnion("SuggestionRule"), gatewayList(GATEWAY_INTERFACE, "SUGGESTION_RULES")],
    ["the proofs", webUnion("SuggestionProof"), gatewayList(GATEWAY_INTERFACE, "SUGGESTION_PROOFS")],
    ["the verdicts", webUnion("SuggestionVerdict"), gatewayList(GATEWAY_INTERFACE, "SUGGEST_VERDICTS")],
    ["the failures", webUnion("SuggestionsFailure"), gatewayList(GATEWAY, "SUGGESTION_FAILURES")],
  ])("%s are the gateway's, in its order", (_name, web, gateway) => {
    expect(web).toEqual(gateway);
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
    expect([...fields(WEB, "SuggestionChange").keys()].sort()).toEqual([...gatewayView.keys()].sort());
  });

  it.each([...gatewayView.keys()])("%s has the type the gateway declares", (field) => {
    expect(asWeb(fields(WEB, "SuggestionChange").get(field) ?? "(not a field)")).toBe(asWeb(gatewayView.get(field)!));
  });
});

describe("the fields of the answer", () => {
  const gateway = fields(GATEWAY, "SuggestionsStored");

  it("says the gateway's view is the stored value with its changes made views (so that this reads the right interface)", () => {
    expect(GATEWAY).toMatch(/export type SuggestionsView = Omit<SuggestionsStored, 'changes'> & \{ changes: SuggestionChangeView\[\] \};/);
  });

  it("has the gateway's names, and no other", () => {
    expect([...fields(WEB, "Suggestions").keys()].sort()).toEqual([...gateway.keys()].sort());
  });

  it.each([...gateway.keys()])("%s has the type the gateway declares", (field) => {
    expect(asWeb(fields(WEB, "Suggestions").get(field) ?? "(not a field)")).toBe(asWeb(gateway.get(field)!));
  });
});
