import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BOARD_FILL_STALE, FILL_LEFT_REASONS } from "./board-fill";
import sv from "../messages/sv.json";
import en from "../messages/en.json";

/*
 * LÄGG DET SOM GÅR: the web's mirror of the gateway's answer, held to the source (E7a, granskaren g519).
 *
 * lib/board-fill.ts says what src/board-fill/ answers, "ids only, the page finds the names": written by hand, and bound to the gateway by nothing. The
 * reasons a brick is left for are the part that is allowed to grow (NO_ROOM, the room that ran out and not the time, is decided), and a reason the dialog
 * has no sentence for was dropped from its list. The gateway's files are read as text, as suggestion-types.contract.test.ts reads its own: the web cannot
 * import them, and CI checks the whole repository out.
 *
 * What is compared: the reasons (the gateway's three and the two the service adds, against the web's list and the sentences of both languages), the
 * scopes the page asks for, the code of a stale proposal, and the fields of a brick, a laid brick and the proposal, each by name.
 */

const ROOT = join(__dirname, "..", "..");
const PLAN = readFileSync(join(ROOT, "src", "board-fill", "fill-plan.ts"), "utf8");
const SERVICE = readFileSync(join(ROOT, "src", "board-fill", "board-fill.service.ts"), "utf8");
const DTO = readFileSync(join(ROOT, "src", "board-fill", "dto", "fill.dto.ts"), "utf8");
const WEB = readFileSync(join(__dirname, "board-fill.ts"), "utf8");

/** The quoted names of a declaration, from `start` to the next semicolon: comments between the members are skipped. */
function quoted(source: string, start: RegExp): string[] {
  const from = source.search(start);
  if (from < 0) return [];
  const body = source.slice(from).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  return [...body.slice(0, body.indexOf(";")).matchAll(/'([A-Z_]+)'/g)].map((found) => found[1]!);
}

/** The fields of `export interface NAME ... { ... }`, by name (one line each; comments between are skipped). */
function fieldsOf(source: string, name: string): string[] {
  const body = new RegExp(`export interface ${name}(?: extends \\w+)? \\{\\n([\\s\\S]*?)\\n\\}`).exec(source)?.[1] ?? "";
  return body.split("\n").flatMap((line) => {
    const field = /^ {2}(\w+)\??: /.exec(line);
    return field ? [field[1]!] : [];
  });
}

const sorted = (names: readonly string[]) => [...names].sort();

describe("what the gateway leaves a brick for", () => {
  const gateway = [...quoted(PLAN, /export type FillLeftReason =/), ...quoted(SERVICE, /export type FillLeftViewReason =/)];

  it("is read from the gateway's two declarations (the plan's three, and the service's two more)", () => {
    expect(gateway).toEqual(expect.arrayContaining(["BLOCK", "JUDGE", "NO_FREE_START", "NO_TEACHER", "TIME"]));
  });

  it("is the web's list, each with a sentence in both languages: a reason the gateway adds is a sentence added here", () => {
    const missing = gateway.filter((reason) => !(FILL_LEFT_REASONS as readonly string[]).includes(reason));
    expect(missing, `the gateway has ${missing.join(", ")} that web/lib/board-fill.ts (FILL_LEFT_REASONS) lacks: add it there, and give fillDialog.reasons a sentence for it in sv.json and en.json`).toEqual([]);
    expect(sorted(FILL_LEFT_REASONS)).toEqual(sorted(gateway));
    for (const messages of [sv, en]) {
      const sentences = Object.keys(messages.fillDialog.reasons);
      for (const reason of [...FILL_LEFT_REASONS, "OTHER"]) expect(sentences, `fillDialog.reasons.${reason}`).toContain(reason);
    }
  });
});

describe("what the page asks for and is answered", () => {
  it("asks only for scopes the gateway takes", () => {
    const gatewayScopes = [...DTO.matchAll(/export const FILL_SCOPES = \[([^\]]*)\]/g)].flatMap((found) => [...found[1]!.matchAll(/'([A-Z]+)'/g)].map((name) => name[1]!));
    const web = [...(/export type FillScope = ([^;]*);/.exec(WEB)?.[1] ?? "").matchAll(/"([A-Z]+)"/g)].map((name) => name[1]!);
    expect(web.length).toBeGreaterThan(0);
    expect(gatewayScopes).toEqual(expect.arrayContaining(web));
  });

  it("knows the code of a stale proposal by the gateway's own", () => {
    expect(SERVICE).toContain(`export const BOARD_FILL_STALE = '${BOARD_FILL_STALE}';`);
  });

  it("reads fields the gateway sends, with the names it sends them by", () => {
    for (const [web, gateway] of [["FillBrickView", "FillBrickView"], ["FillPlaced", "FillPlacedView"], ["FillLeft", "FillLeftView"], ["FillProposal", "FillProposal"], ["FillApplied", "FillApplyResult"]] as const) {
      const theirs = [...fieldsOf(SERVICE, gateway), ...(gateway === "FillPlacedView" || gateway === "FillLeftView" ? fieldsOf(SERVICE, "FillBrickView") : [])];
      const ours = fieldsOf(WEB, web);
      expect(ours.length, web).toBeGreaterThan(0);
      expect(theirs, `${web}: the page reads ${ours.filter((name) => !theirs.includes(name)).join(", ")} that ${gateway} does not send`).toEqual(expect.arrayContaining(ours));
    }
  });
});
