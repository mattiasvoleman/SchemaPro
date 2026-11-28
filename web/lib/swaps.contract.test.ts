import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * BYTEN OCH FLYTTAR, BYT PLATS OCH GÖR PLATS: the web's mirror of the gateway's types, held to the source (E5a).
 *
 * lib/swaps.ts says what the gateway sends of a suggestion, a pair and an apply (src/swaps). The routes' answers are `{ "type": "object" }` in
 * docs/api/openapi.json, so nothing but this binds the two: a field renamed or added on the gateway's side is found by a list that reads
 * `undefined`, or, as with `exemptionsEnded`, by a sentence nobody says. It reads the gateway's files as text (the web cannot import them, and CI
 * checks the whole repository out), as suggestion-types.contract.test.ts does.
 *
 * What is compared: the fields of each answer, by name and by whether they are optional, and the closed sets (the kinds of proposal, why a lesson
 * cannot move, why nothing could be offered). The request bodies the web sends are held to the gateway's DTOs by the same reading.
 */

const ROOT = join(__dirname, "..", "..");
const SERVICE = readFileSync(join(ROOT, "src", "swaps", "swaps.service.ts"), "utf8");
const TYPES = readFileSync(join(ROOT, "src", "swaps", "swap-types.ts"), "utf8");
const DTO = readFileSync(join(ROOT, "src", "swaps", "dto", "swaps.dto.ts"), "utf8");
const WEB = readFileSync(join(__dirname, "swaps.ts"), "utf8");

/** The top-level fields of `export interface NAME ... { ... }`, by name, with `?` kept: nested object types are skipped by their indentation. */
function fields(source: string, name: string): string[] {
  const body = new RegExp(`export interface ${name}(?: extends [^{]+)? \\{\\n([\\s\\S]*?)\\n\\}`).exec(source)?.[1] ?? "";
  return body
    .split("\n")
    .map((line) => /^ {2}(\w+\??):/.exec(line)?.[1] ?? "")
    .filter((field) => field !== "")
    .sort();
}

/** The quoted words of the declaration of one field: `immovable?: 'A' | 'B'`, however many lines, up to the next field at the same indent. */
function words(source: string, interfaceName: string, field: string): string[] {
  const body = new RegExp(`export interface ${interfaceName}(?: extends [^{]+)? \\{\\n([\\s\\S]*?)\\n\\}`).exec(source)?.[1] ?? "";
  const start = body.search(new RegExp(`^ {2}${field}\\??:`, "m"));
  if (start < 0) return [];
  const rest = body.slice(start).split("\n");
  const declaration = [rest[0]!];
  for (const line of rest.slice(1)) {
    if (/^ {2}\S/.test(line) && !line.startsWith("  }")) break;
    declaration.push(line);
  }
  return [...declaration.join("\n").matchAll(/['"]([A-Z_]+)['"]/g)].map((found) => found[1]!).sort();
}

/** The fields one level down in an object-typed field (`makeRoom?: { target: ...; blockers: ... }`): the lines indented four spaces until the block closes. */
function inside(source: string, interfaceName: string, field: string): string[] {
  const body = new RegExp(`export interface ${interfaceName}(?: extends [^{]+)? \\{\\n([\\s\\S]*?)\\n\\}`).exec(source)?.[1] ?? "";
  const lines = body.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^ {2}${field}\\??: \\{`).test(line));
  if (start < 0) return [];
  // Written on one line (`lay?: { lessonId: string | null; slot: SwapSlot };`): the names before each colon.
  const oneLine = /\{(.*)\};?$/.exec(lines[start]!)?.[1];
  if (oneLine !== undefined) return [...oneLine.matchAll(/(?:^|;)\s*(\w+\??):/g)].map((found) => found[1]!).sort();
  const found: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\}/.test(line)) break;
    const name = /^ {4}(\w+\??):/.exec(line)?.[1];
    if (name) found.push(name);
  }
  return found.sort();
}

const without = (list: string[], ...names: string[]) => list.filter((entry) => !names.includes(entry.replace("?", "")));

describe("what this test reads (a parse that finds nothing would pass everything below)", () => {
  it("finds the interfaces it compares", () => {
    expect(fields(SERVICE, "SwapSuggestion").length).toBeGreaterThanOrEqual(8);
    expect(fields(SERVICE, "SwapPair").length).toBe(6);
    expect(fields(SERVICE, "SwapApplyResult").length).toBeGreaterThan(7);
    expect(fields(TYPES, "SwapProposal").length).toBeGreaterThan(7);
    expect(fields(WEB, "SwapSuggestion").length).toBeGreaterThanOrEqual(8);
    expect(words(SERVICE, "SwapPair", "immovable").length).toBe(5);
  });
});

describe("the answers the web reads are the gateway's", () => {
  it("a suggestion has the fields the gateway's has", () => {
    expect(fields(WEB, "SwapSuggestion")).toEqual(fields(SERVICE, "SwapSuggestion"));
  });

  it("a proposal has the fields of the gateway's (its swap-types.ts proposal without the score, with what the view adds)", () => {
    const gateway = [...without(fields(TYPES, "SwapProposal"), "score"), ...fields(SERVICE, "SwapProposalView")].sort();
    expect(fields(WEB, "SwapProposal")).toEqual(gateway);
  });

  it("what Gör plats says of the asked time, and where it lays a lesson that stands nowhere, have the fields the gateway's have", () => {
    expect(inside(WEB, "SwapSuggestion", "makeRoom")).toEqual(inside(SERVICE, "SwapSuggestion", "makeRoom"));
    expect(inside(WEB, "SwapSuggestion", "makeRoom")).toHaveLength(5);
    expect(inside(WEB, "SwapProposal", "lay")).toEqual(inside(SERVICE, "SwapProposalView", "lay"));
    expect(inside(WEB, "SwapProposal", "lay")).toHaveLength(7);
  });

  it("a pair, a refusal and a lesson have the fields the gateway's have", () => {
    expect(fields(WEB, "SwapPair")).toEqual(fields(SERVICE, "SwapPair"));
    expect(fields(WEB, "SwapPairRefusal")).toEqual(fields(SERVICE, "SwapPairRefusal"));
    expect(fields(WEB, "SwapLessonView")).toEqual(fields(SERVICE, "SwapLessonView"));
  });

  it("an apply's answer has every field the page reads, and every one the gateway sends except the lessons it wrote", () => {
    // `lessons` (the written rows) is what the page reads again from the lists instead (the apply invalidates them). The web marks the fields an older
    // gateway does not send optional, so the names are compared without the `?`.
    const names = (list: string[]) => list.map((field) => field.replace("?", "")).sort();
    expect(names(fields(WEB, "SwapApplyResult"))).toEqual(names(without(fields(SERVICE, "SwapApplyResult"), "lessons")));
  });

  it("the closed sets are the same: why a lesson cannot move, why nothing was offered, what kind of proposal", () => {
    expect(words(WEB, "SwapSuggestion", "immovable")).toEqual(words(SERVICE, "SwapSuggestion", "immovable"));
    expect(words(WEB, "SwapPair", "immovable")).toEqual(words(SERVICE, "SwapPair", "immovable"));
    expect(words(WEB, "SwapProposal", "kind")).toEqual(words(TYPES, "SwapProposal", "kind"));
    const stuck = (source: string) => [...(/stuck\?: ([^;]+);/.exec(source)?.[1] ?? "").matchAll(/['"]([A-Z_]+)['"]/g)].map((found) => found[1]!).sort();
    expect(stuck(WEB)).toEqual(stuck(SERVICE));
    expect(stuck(WEB)).toHaveLength(3);
  });
});

describe("the bodies the web sends are the gateway's DTOs", () => {
  const dto = (name: string) => new RegExp(`export class ${name} \\{([\\s\\S]*?)\\n\\}`).exec(DTO)?.[1] ?? "";
  const dtoFields = (name: string) => [...dto(name).matchAll(/^ {2}(\w+)[?!]:/gm)].map((found) => found[1]!).sort();

  it("Gör plats: makeRoom has the day, the clock and a depth, and the day is a school day", () => {
    expect(dtoFields("MakeRoomDto")).toEqual(["dayOfWeek", "depth", "startTime"]);
    expect(/makeRoom\?: \{ dayOfWeek: number; startTime: string; depth\?: number \}/.test(WEB)).toBe(true);
    // The page offers Gör plats for days 1 to 5 only (placement-dialogs.tsx), because the gateway answers 400 for another.
    expect(/@Max\(5\)\n\s+dayOfWeek/.test(dto("MakeRoomDto"))).toBe(true);
  });

  it("Byt plats: the pair is two lessons named lessonId and otherLessonId", () => {
    expect(dtoFields("PairSwapDto")).toEqual(["lessonId", "otherLessonId"]);
    expect(WEB).toContain("{ lessonId: string; otherLessonId: string }");
  });

  it("the apply takes what applyBody writes, and nothing the web leaves out that it needs", () => {
    expect(dtoFields("ApplySwapDto")).toEqual(["alsoPicked", "forBrick", "lessonId", "moves", "propagate", "versionName"]);
    const body = /export const applyBody = \([\s\S]*?\n\}\);\n|export const applyBody = \([\s\S]*?\n\);\n/.exec(WEB)?.[0] ?? "";
    for (const sent of ["lessonId", "moves", "versionName", "alsoPicked", "forBrick"]) expect(body, sent).toContain(sent);
  });
});
