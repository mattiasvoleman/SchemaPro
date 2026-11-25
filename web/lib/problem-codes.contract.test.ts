import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { apiErrorText, type ProblemLookup } from "@/lib/api-error-text";
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

/**
 * Whether the file that sends a code, or a module it imports, writes `param` as the key of an object: where a sentence that takes the name
 * only for some of its reasons (a name ending in `?` in the list) gets it from. A refusal that is built from a list of reasons (the judge
 * names the other lesson's class and clock, the refusal adds the code and the heaviest reason) puts the name in a module beside the one
 * that holds the code; the object that sends the code does not spell it out, so the lines about it cannot be asked as `sendsParam` asks.
 */
const buildsParam = (site: Site, param: string): boolean => {
  const key = new RegExp(String.raw`(?:^|[\s{,(])${param}\s*:`, "m");
  const code = (path: string): string =>
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line))
      .join("\n");
  const text = code(site.file);
  const imported = [...text.matchAll(/from\s+['"](\.[^'"]*)['"]/g)]
    .map((match) => resolve(dirname(site.file), `${match[1]}.ts`))
    .filter((path) => existsSync(path));
  return [text, ...imported.map(code)].some((source) => key.test(source));
};

const CODES = Object.keys(PROBLEM_CODES);

describe("the codes the web has a sentence for, against the gateway's sources", () => {
  it.each(CODES)("%s is a code the gateway still sends", (code) => {
    // A code that is gone from src/ (or renamed there) is a dead entry that gives the reader the thrower's English again.
    expect(SITES(code).length).toBeGreaterThan(0);
  });

  it.each(CODES.filter((code) => PROBLEM_CODES[code]!.length > 0))("%s: the gateway sends the params its sentence takes", (code) => {
    for (const declared of PROBLEM_CODES[code]!) {
      const optional = declared.endsWith("?");
      const param = optional ? declared.slice(0, -1) : declared;
      // A sentence whose argument the gateway no longer sends is never filled: it falls back to `detail`, silently. A name the sentence
      // takes for some of its reasons only is written where the refusal is built, which is not always beside the code.
      expect(SITES(code).some((site) => (optional ? buildsParam(site, param) : sendsParam(site, param)))).toBe(true);
    }
  });
});

/**
 * The other direction, for the codes the gateway's filter gives its own answers: the body parser's three (REQUEST_BODY_TOO_LARGE,
 * REQUEST_BODY_NOT_JSON, REQUEST_ENCODING_UNSUPPORTED) and the busy pool's (DATABASE_BUSY). The filter words each of them in more than one
 * way (a body "too large" and one with "too many fields"; an encoding and a character set it will not read), so the sentences are not
 * listed one by one: each code is said in the reader's language whatever `detail` it carries, either from the table or as a general
 * sentence (lib/api-error-text.ts FILTER_CODES). A code the filter starts to name that the web cannot say is a failing test here, not
 * the filter's English on a Swedish page.
 */
describe("the codes the gateway's filter gives its own answers, against the web", () => {
  const filter = join(gateway, "common", "filters", "http-exception.filter.ts");
  const poolWait = join(gateway, "database", "pool-wait.ts");
  const text = (path: string) =>
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line))
      .join("\n");
  const filterText = text(filter);
  /** `export const NAME = 'VALUE'`, in the filter or the pool's wait: the code a constant stands for. */
  const valueOf = (name: string): string => {
    const hit = /\bexport const NAME = ['"]([A-Z][A-Z0-9_]*)['"]/.source.replace("NAME", name);
    return new RegExp(hit).exec(`${filterText}\n${text(poolWait)}`)?.[1] ?? name;
  };
  // `code: REQUEST_BODY_TOO_LARGE,` and `code: DATABASE_BUSY,` (or the code as a literal): what the filter writes into its answer. A thrower's
  // code passes as `record.code`, and an area's as `area.code`.
  const CODE_LINE = /^\s*code:\s*(?:['"]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)['"]|([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)),?\s*$/gm;
  const named = [...new Set([...filterText.matchAll(CODE_LINE)].map((match) => match[1] ?? valueOf(match[2]!)))].sort();

  const DETAIL = "Gatewayens egen mening, i vilket språk den vill.";
  const apiError = (status: number, code: string): Error => Object.assign(new Error(DETAIL), { name: "ApiError", status, code });
  // A translator that says the key it was asked for: a sentence that is the filter's own words comes back as DETAIL.
  const echo: ProblemLookup = (key) => key;

  it("finds the codes the filter names", () => {
    // DATABASE_BUSY is sent by the filter from the pool's wait; that the line `code: DATABASE_BUSY` is still there is the point, as a
    // mention elsewhere in the filter (the log level) would keep the list above satisfied if the answer lost its code.
    expect(named).toContain("DATABASE_BUSY");
  });

  it.each(["400", "413", "415", "503"].map(Number))("says every code the filter names in the reader's language, for a %i", (status) => {
    const unsaid = named.filter((code) => apiErrorText(apiError(status, code), echo) === DETAIL);
    expect(unsaid).toEqual([]);
  });
});
