import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import sv from "@/messages/sv.json";
import { EXCHANGE_FORMATS, MAX_UPLOAD_BYTES } from "@/lib/schedule-exchange";
import { unfillableFields } from "@/lib/skola24-format";
import { SKOLA24_FORMATS } from "@/lib/skola24-formats";

/*
 * P1 Pilotkit: the user manual's 3.7 (Första veckan på en ny skola) and 3.8 (Flytta från Skola24, Untis, aSc eller
 * Excel) hold against the code they describe.
 *
 * A guide for a school that moves is read by someone who will do exactly what it says. It must not say that a file is read
 * when no reader exists, nor name a menu row that is not in the menu, nor a button that has another name. The structure of
 * the manual is src/manual-structure.spec.ts's; what the two sections SAY about the program is this test's:
 *
 *   - every `Grunddata › Kom igång` in them is a group and a row of the admin menu, in that group;
 *   - every label (`<span class="ui">`) is a text the app has, as a whole or as the start of one that carries a number;
 *   - the Skola24 table has one row for each description in lib/skola24-formats.ts and none more, and a row says what the
 *     description says: columns and a kind of import (read), a field the import needs that the file has no column for
 *     (does not go in as it is, and which field), columns and no import (named), no columns (not read);
 *   - the four formats of the schedule exchange are the four the guide names, the size and lesson limits are the code's.
 *
 * The check is a function over the manual's text, and the last describe proves it on copies with one fault each, so that
 * a check that stops looking turns this red.
 */

const ROOT = join(__dirname, "..", "..");
const MANUAL = readFileSync(join(ROOT, "docs", "manual", "anvandarmanual.html"), "utf8");
const ADMIN_NAV = readFileSync(join(__dirname, "..", "components", "layout", "admin-nav.ts"), "utf8");
const EXCHANGE_MODEL = readFileSync(join(ROOT, "src", "schedule-exchange", "exchange-model.ts"), "utf8");
const UNTIS_READER = readFileSync(join(ROOT, "src", "schedule-exchange", "untis-gpu.ts"), "utf8");
const INTAKE = readFileSync(join(ROOT, "src", "intake", "intake.ts"), "utf8");

/** Every gap Vad kom in has and its level, as src/intake/intake.ts defines them: one line each, so that this can read them. */
const INTAKE_GAPS = [...INTAKE.matchAll(/\{ code: '([A-Z_]+)', area: '[A-Z_]+', level: '(HARD|SOFT|INFO)' \}/g)].map((match) => ({
  code: match[1]!,
  level: match[2]! as "HARD" | "SOFT" | "INFO",
}));

const decode = (text: string): string => text.replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const flat = (markup: string): string => decode(markup.replace(/<[^>]+>/g, " "));

/** An ICU message as the words a person reads: arguments and plural branches, which hold the numbers, left out. */
function readable(message: string): string {
  let text = message;
  for (;;) {
    const next = text.replace(/\{[^{}]*\}/g, "");
    if (next === text) break;
    text = next;
  }
  return decode(text).toLowerCase();
}

/**
 * What a button says before its number: "Skriv in" in "Skriv in # lektioner". The label in a manual is the part that does not change,
 * so it is accepted when a plural branch of a message starts with it and goes on with the count.
 */
function numberedStarts(message: string): string[] {
  return [...message.matchAll(/\{([^{}]*) #[^{}]*\}/g)].map((match) => decode(match[1]!).toLowerCase());
}

function messageTexts(node: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof node === "string") {
    into.add(readable(node));
    for (const start of numberedStarts(node)) into.add(start);
  } else if (node !== null && typeof node === "object") {
    for (const value of Object.values(node)) messageTexts(value, into);
  }
  return into;
}

const APP_TEXTS = messageTexts(sv);

/** The admin menu as `group label › row label`, read from the file that holds it (it is server-only and imports icons). */
function adminMenuPaths(): Set<string> {
  const nav = sv.nav as Record<string, string>;
  const paths = new Set<string>();
  let group: string | null = null;
  for (const line of ADMIN_NAV.split("\n")) {
    const heading = /^ {4}labelKey: (?:"(\w+)"|null),$/.exec(line);
    if (heading !== null) {
      group = heading[1] ?? null;
      continue;
    }
    const row = /^\s+\{ labelKey: "(\w+)", href: "[^"]+"/.exec(line);
    if (row !== null && group !== null) paths.add(`${nav[group]} › ${nav[row[1]!]}`);
  }
  return paths;
}

const MENU = adminMenuPaths();

/** The two sections: from 3.7's heading to the end of the chapter. */
function pilotkitOf(manual: string): string {
  const start = manual.indexOf('<h3 id="s37"');
  if (start < 0) return "";
  const end = manual.indexOf("</section>", start);
  return manual.slice(start, end < 0 ? undefined : end);
}

const spans = (markup: string, kind: "path" | "ui"): string[] =>
  [...markup.matchAll(new RegExp(`<span class="${kind}">([^<]*)</span>`, "g"))].map((match) => decode(match[1]!));

const thousands = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");

/** How the code reads a Skola24 description, in the words of the guide's `data-reads`. */
function readsOf(format: (typeof SKOLA24_FORMATS)[number]): "reads" | "incomplete" | "named" | "unknown" {
  if (format.columns === null) return "unknown";
  if (format.kind === null) return "named";
  return unfillableFields(format).length > 0 ? "incomplete" : "reads";
}

/** What a row of the guide has to say about a field the import needs and the file never has. */
const MISSING_FIELD_WORDS: Readonly<Record<string, string>> = {
  email: "e-postadress",
  studentEmail: "elevens e-postadress",
};

/** The text of a row's cell, counted from 0: the second, "Så läses den", is where a file's reading is said. */
function cellOf(row: string, index: number): string {
  return [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)][index]?.[1] ?? "";
}

/** What is wrong with the guide, as sentences; empty when nothing is. */
function problemsOf(manual: string): string[] {
  const problems: string[] = [];
  const section = pilotkitOf(manual);
  if (section === "") return ["the manual has no section 3.7 (id s37)"];
  if (!section.includes('<h3 id="s38"')) problems.push("the manual has no section 3.8 (id s38)");

  for (const path of spans(section, "path")) {
    if (!MENU.has(path)) problems.push(`the path "${path}" is not a row of the admin menu`);
  }
  for (const label of spans(section, "ui")) {
    if (!APP_TEXTS.has(label.toLowerCase())) problems.push(`the label "${label}" is not a text of the app`);
  }

  const rows = (attribute: string): Map<string, string> => {
    const found = new Map<string, string>();
    for (const match of section.matchAll(new RegExp(`<tr ${attribute}="([^"]+)"[^>]*>([\\s\\S]*?)</tr>`, "g"))) {
      if (found.has(match[1]!)) problems.push(`${attribute} "${match[1]}" has two rows`);
      found.set(match[1]!, match[0]!);
    }
    return found;
  };

  const skola24 = rows("data-source");
  for (const id of skola24.keys()) {
    if (!SKOLA24_FORMATS.some((format) => format.id === id)) problems.push(`a row for "${id}", which is no description of Skola24's files`);
  }
  for (const format of SKOLA24_FORMATS) {
    const row = skola24.get(format.id);
    if (row === undefined) {
      problems.push(`no row for the Skola24 file "${format.id}"`);
      continue;
    }
    const reads = readsOf(format);
    if (!row.includes(`data-reads="${reads}"`)) problems.push(`the row for "${format.id}" does not say "${reads}", which is what the description gives`);
    if (reads === "incomplete") {
      for (const field of unfillableFields(format)) {
        const words = MISSING_FIELD_WORDS[field];
        if (words === undefined) problems.push(`the field "${field}", which "${format.id}" cannot give, has no words in this test`);
        else if (!flat(cellOf(row, 1)).includes(words)) problems.push(`the row for "${format.id}" does not say, in how the file is read, that it lacks "${words}"`);
      }
    }
  }

  const exchange = rows("data-exchange");
  for (const id of exchange.keys()) {
    if (!(EXCHANGE_FORMATS as readonly string[]).includes(id)) problems.push(`a row for the format "${id}", which the schedule exchange does not have`);
  }
  for (const id of EXCHANGE_FORMATS) {
    if (!exchange.has(id)) problems.push(`no row for the schedule exchange's format "${id}"`);
  }

  // Vad kom in: one row for each gap the gateway counts, at the level the gateway gives it, in the words the page gives that level.
  const gapRows = rows("data-gap");
  for (const code of gapRows.keys()) {
    if (!INTAKE_GAPS.some((entry) => entry.code === code)) problems.push(`a row for the gap "${code}", which Vad kom in does not count`);
  }
  for (const { code, level } of INTAKE_GAPS) {
    const row = gapRows.get(code);
    if (row === undefined) {
      problems.push(`no row for the gap "${code}", which Vad kom in counts`);
      continue;
    }
    if (!row.includes(`data-level="${level}"`)) problems.push(`the row for "${code}" does not say "${level}", which is the gateway's level for it`);
    const words = (sv.intake.levels as Record<string, string>)[level];
    if (flat(cellOf(row, 1)) !== words) problems.push(`the row for "${code}" does not name its level "${words}" in words`);
  }

  const text = flat(section);
  const kilobytes = MAX_UPLOAD_BYTES / 1024;
  if (!text.includes(`högst ${kilobytes} kB`)) problems.push(`the guide does not say that a file may be at most ${kilobytes} kB`);
  const lessons = Number(/MAX_EXCHANGE_LESSONS\s*=\s*([\d_]+)/.exec(EXCHANGE_MODEL)?.[1]?.replace(/_/g, ""));
  if (!text.includes(`högst ${thousands(lessons)} lektioner`)) problems.push(`the guide does not say that an import is at most ${thousands(lessons)} lessons`);

  const hint = (sv.scheduleExchange as { import: { periodsHint: string } }).import.periodsHint;
  const example = /1 \d\d:\d\d-\d\d:\d\d/.exec(hint)?.[0];
  if (example === undefined || !text.includes(example)) problems.push(`the guide does not show the period example the page shows ("${example}")`);

  for (const marker of ["A-vecka", "B-vecka"]) {
    if (!UNTIS_READER.includes(marker)) problems.push(`the Untis reader no longer knows "${marker}", which the guide names`);
    if (!text.includes(marker)) problems.push(`the guide does not name "${marker}"`);
  }
  if (!UNTIS_READER.includes("GPU_TOO_MANY_TEACHERS")) problems.push("the Untis reader no longer refuses a third teacher, which the guide says");
  return problems;
}

describe("the first week and the move (3.7, 3.8) say what the program does", () => {
  it("holds against the menu, the labels, the Skola24 descriptions, the exchange and Vad kom in", () => {
    expect(problemsOf(MANUAL)).toEqual([]);
  });

  it("reads the gateway's gaps (a parse that finds none would pass the table below by having none to check)", () => {
    expect(INTAKE_GAPS.length).toBeGreaterThan(15);
    expect(INTAKE_GAPS.filter((entry) => entry.level === "HARD").length).toBeGreaterThan(3);
  });

  it("has the menu it reads", () => {
    // A parse that finds nothing would pass every path above by having none to check.
    expect(MENU.has("Grunddata › Kom igång")).toBe(true);
    expect(MENU.has("Planering › Ramtider")).toBe(true);
    expect(MENU.has("Schemaläggning › Schema som fil")).toBe(true);
    expect(MENU.size).toBeGreaterThan(30);
  });
});

describe("the check finds what it is for", () => {
  /** A fault made in the two sections only, and the same text may stand in 7.7: a replace over the whole manual would hit that one. */
  const inSection =
    (change: (section: string) => string) =>
    (manual: string): string => {
      const section = pilotkitOf(manual);
      return manual.replace(section, change(section));
    };
  const faults: Array<[string, (manual: string) => string]> = [
    ["a path that is not a menu row", inSection((x) => x.replace("Planering › Ramtider", "Planering › Ramtid"))],
    ["a label the app does not have", inSection((x) => x.replace('<span class="ui">Kontrollera veckan</span>', '<span class="ui">Kolla veckan</span>'))],
    ["a file read that the description does not read", (m) => m.replace('data-source="skola24-textfil" data-reads="unknown"', 'data-source="skola24-textfil" data-reads="reads"')],
    ["a pupils' file said to go in as it is", (m) => m.replace('data-source="skola24-elever-klass" data-reads="incomplete"', 'data-source="skola24-elever-klass" data-reads="reads"')],
    ["a pupils' file that no longer names what it lacks", inSection((x) => x.replace("filen har ingen e-postadress", "filen har ingen mobil"))],
    ["a description with no row", (m) => m.replace(/<tr data-source="skola24-mdb-extens"[\s\S]*?<\/tr>/, "")],
    ["a row for a file that is not described", (m) => m.replace('data-source="skola24-barn-csv"', 'data-source="skola24-hittepa"')],
    ["a format with no row", (m) => m.replace(/<tr data-exchange="ASC_XML"[\s\S]*?<\/tr>/, "")],
    ["a size that is not the code's", inSection((x) => x.replace(/högst 700\s+kB/, "högst 500 kB"))],
    ["a lesson limit that is not the code's", inSection((x) => x.replace(/högst 5 000\s+lektioner/, "högst 8 000 lektioner"))],
    ["a Untis week marker the reader does not use", inSection((x) => x.replace(/B-vecka/g, "Vecka B"))],
    ["a section that is gone", (m) => m.replace('<h3 id="s37"', '<h3 id="s37x"')],
    ["a gap at another level than the gateway gives it", inSection((x) => x.replace('data-gap="NO_ROOMS" data-level="HARD"', 'data-gap="NO_ROOMS" data-level="SOFT"'))],
    ["a gap whose level is not said in words", inSection((x) => x.replace('<td class="k">Inga salar</td><td>Stoppar Generera</td>', '<td class="k">Inga salar</td><td>Allvarligt</td>'))],
    ["a gap the gateway counts that has no row", inSection((x) => x.replace(/<tr data-gap="NO_TEACHERS"[\s\S]*?<\/tr>/, ""))],
    ["a row for a gap the gateway does not count", inSection((x) => x.replace('data-gap="NO_RASTS"', 'data-gap="NO_BREAKS"'))],
  ];
  for (const [name, mutate] of faults) {
    it(`finds ${name}`, () => {
      const mutated = mutate(MANUAL);
      expect(mutated).not.toBe(MANUAL);
      expect(problemsOf(mutated)).not.toEqual([]);
    });
  }
});
