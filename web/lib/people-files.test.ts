import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { DOWNLOADS, PEOPLE_FILES, PEOPLE_KINDS } from "@/lib/people-files";

/**
 * Skyddad identitet: no file leaves the web undecided. Every source that
 * downloads is in PEOPLE_FILES with what it does with a marked person, and
 * the sources that hold the marked out, or keep them and say so, read the
 * marks. A new export fails here until it is decided.
 */

const WEB = join(__dirname, "..");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" || name === "__fixtures__" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const all = ["app", "components", "lib"].flatMap((dir) => sources(join(WEB, dir)));
const text = (path: string) => readFileSync(join(WEB, path), "utf8");
const relativeOf = (path: string) => relative(WEB, path).split("\\").join("/");

describe("every file the web hands out is decided for a protected identity", () => {
  it("lists every source that downloads, and nothing that does not", () => {
    const downloading = all.filter((path) => DOWNLOADS.test(readFileSync(path, "utf8"))).map(relativeOf).sort();
    expect(downloading).toEqual(Object.keys(PEOPLE_FILES).sort());
  });

  it("reads the marks wherever a file holds the marked out or keeps them and says so", () => {
    for (const [path, entry] of Object.entries(PEOPLE_FILES)) {
      const source = text(path);
      if (entry.rule === "HOLDS_OUT") expect(source, path).toMatch(/readMarks|withoutMarked|HeldOutFile/);
      if (entry.rule === "KEEPS_AND_SAYS") expect(source, path).toMatch(/markedAmong|protectedInFile/);
    }
  });

  it("builds every export-button entry that names people from the unmarked", () => {
    const pages = all.filter((path) => readFileSync(path, "utf8").includes("<CsvExportButton"));
    expect(pages.length).toBeGreaterThan(0);
    for (const path of pages) {
      const source = readFileSync(path, "utf8");
      const kinds = [...source.matchAll(/kind: "(\w+)"/g)].map((match) => match[1]);
      const people = kinds.filter((kind) => (PEOPLE_KINDS as readonly string[]).includes(kind!));
      if (people.length === 0) continue;
      expect(source, `${relativeOf(path)} exports ${people.join(", ")}`).toMatch(
        /withoutMarked|unmarked\(|requirementsCsvWithoutMarked|guardiansCsvFor/,
      );
    }
  });

  it("would catch a download nobody decided (the scan is not vacuous)", () => {
    expect(DOWNLOADS.test('downloadCsv("ny.csv", file)')).toBe(true);
    expect(DOWNLOADS.test("const url = URL.createObjectURL(blob);")).toBe(true);
    expect(DOWNLOADS.test("doc.save(name)")).toBe(true);
    expect(DOWNLOADS.test("const downloads = 3;")).toBe(false);
    // The review's two that got past the first scan (#263, L4), and paper.
    expect(DOWNLOADS.test('window.open("data:text/csv;charset=utf-8," + encodeURIComponent(file))')).toBe(true);
    expect(DOWNLOADS.test("anchor.download = 'elever.csv';")).toBe(true);
    expect(DOWNLOADS.test("const blob = new Blob([file]);")).toBe(true);
    expect(DOWNLOADS.test("onClick={() => window.print()}")).toBe(true);
  });
});
