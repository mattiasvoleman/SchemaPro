import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROBLEM_CODES } from "@/lib/problem-codes";

/**
 * The list of codes (lib/problem-codes.ts) against the gateway that sends them. problem-codes.test.ts holds the list equal to the
 * catalogue and says each sentence from a hand-written `SENT`; nothing there reads src/, so a code the gateway renames or drops, or a
 * param it renames, leaves every test green and gives the reader the thrower's `detail` again: the English "The server is busy right
 * now" for DATABASE_BUSY on a Swedish page, which is what the list was written to end. This reads the gateway's sources as text, as
 * api-error-text.contract.test.ts does for the filter's own sentences.
 */
const gateway = join(__dirname, "..", "..", "src");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "__fixtures__" ? [] : sources(path);
    return /\.ts$/.test(entry.name) && !/\.(?:spec|e2e-spec)\.ts$/.test(entry.name) ? [path] : [];
  });
}

interface Site {
  file: string;
  /** The line and the lines about it, where the params a thrower sends beside the code stand. */
  near: string;
}

/** An upper-case name or a quoted one: a code, or the constant that holds it. */
const NAME = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
const QUOTED = /['"`]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)['"`]/g;
const DEFINITION = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\s*(?::[^=]+)?=\s*['"]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)['"]/;

/** Where the gateway says a code: by its literal, or through the constant that holds it, other than at the constant's definition. */
const SITES = (() => {
  const byLiteral = new Map<string, Site[]>();
  const byName = new Map<string, Site[]>();
  const holds = new Map<string, Set<string>>();
  const add = (map: Map<string, Site[]>, key: string, site: Site) => map.set(key, [...(map.get(key) ?? []), site]);
  for (const path of sources(gateway)) {
    // The import lists and the comments are blanked: a code named there is not a code sent.
    const text = readFileSync(path, "utf8").replace(/\b(?:import|export)\s+(?:type\s+)?\{[^}]*\}\s*from\s*['"][^'"]+['"]\s*;?/g, (match) => match.replace(/[^\n]/g, " "));
    const lines = text.split("\n").map((line) => (/^\s*(?:\*|\/\/|\/\*)/.test(line) ? "" : line));
    lines.forEach((line, index) => {
      if (line === "") return;
      const site = { file: path, near: lines.slice(Math.max(0, index - 8), index + 9).join("\n") };
      const definition = DEFINITION.exec(line);
      if (definition) {
        // `export const NAME = 'CODE'`: NAME stands for CODE from here on, and the line itself sends nothing.
        holds.set(definition[2]!, (holds.get(definition[2]!) ?? new Set()).add(definition[1]!));
        return;
      }
      for (const match of line.matchAll(QUOTED)) add(byLiteral, match[1]!, site);
      for (const match of line.matchAll(NAME)) add(byName, match[0], site);
    });
  }
  return (code: string): Site[] => [...(byLiteral.get(code) ?? []), ...[...(holds.get(code) ?? [])].flatMap((name) => byName.get(name) ?? [])];
})();

/** Whether an object literal near a site names `param` as a key (`{ date: lastDate }`, `{ field, max }`): what the thrower sends beside the code. */
const sendsParam = (site: Site, param: string): boolean => new RegExp(String.raw`\{[^{}]*(?:^|[\s{,])${param}\s*(?::|,|\})`).test(site.near);

const CODES = Object.keys(PROBLEM_CODES);

describe("the codes the web has a sentence for, against the gateway's sources", () => {
  it.each(CODES)("%s is a code the gateway still sends", (code) => {
    // A code that is gone from src/ (or renamed there) is a dead entry that gives the reader the thrower's English again.
    expect(SITES(code).length).toBeGreaterThan(0);
  });

  it.each(CODES.filter((code) => PROBLEM_CODES[code]!.length > 0))("%s: the gateway sends the params its sentence takes", (code) => {
    for (const param of PROBLEM_CODES[code]!) {
      // A sentence whose argument the gateway no longer sends is never filled: it falls back to `detail`, silently.
      expect(SITES(code).some((site) => sendsParam(site, param))).toBe(true);
    }
  });
});
