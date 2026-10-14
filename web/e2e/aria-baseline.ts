import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Locator } from "@playwright/test";

/**
 * The accessibility tree of a screen, compared with a committed baseline in
 * e2e/aria-baselines/<name>.yml.
 *
 * Playwright's own toMatchAriaSnapshot would pin every date, and the fixture
 * school's dates move with the calendar (e2e/stub/fixtures/calendar.ts): the
 * week shown is always this one. So the tree is taken as text, every date,
 * week number and year is replaced by a placeholder, and the rest — roles,
 * names, headings and their levels, states — must match exactly.
 *
 * A missing baseline is written (never on CI, where it fails instead), and
 * `--update-snapshots` rewrites them all; review the diff like code.
 */

const DIR = path.join(__dirname, "aria-baselines");

const MONTHS = "jan|feb|mar|apr|maj|jun|jul|aug|sep|okt|nov|dec|may|oct";

export function normalize(tree: string): string {
  return (
    tree
      // 2026-10-13, 2026-10-13T08:10:00.000Z
      .replace(/\b\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?\b/g, "<datum>")
      // 13 okt 2026, 13 oktober, 13 okt.
      .replace(new RegExp(`\\b\\d{1,2}\\s(?:${MONTHS})[a-zé]*\\.?(?:\\s\\d{4})?`, "gi"), "<datum>")
      // 13/10, 13/10/2026
      .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, "<datum>")
      // vecka 42, v. 42, v42, week 42
      .replace(/\b(vecka|veckan|v\.|v|week)\s?\d{1,2}\b/gi, "$1 <n>")
      // läsår 2026/27, 2026–2027
      .replace(/\b20\d{2}\s?[/–-]\s?(20)?\d{2}\b/g, "<läsår>")
      .replace(/\b20\d{2}\b/g, "<år>")
      // A day range in any shape formatRange gives it: "21–25 okt." (one
      // month, the first day bare), "28 okt.–1 nov." and "28 dec. – 1 jan."
      // all read <datum>–<datum>, so the shape cannot change with the week.
      .replace(/(?:\b\d{1,2}|<datum>)\s?[–-]\s?<datum>/g, "<datum>–<datum>")
  );
}

/** `locator` may match several elements (a heading and a section); their trees are joined in order. */
export async function expectAriaBaseline(locator: Locator, name: string) {
  const parts: string[] = [];
  for (const element of await locator.all()) parts.push(await element.ariaSnapshot());
  if (parts.length === 0) throw new Error(`Nothing on the page matches the scope of ${name}.`);
  const actual = normalize(parts.join("\n"));
  const file = path.join(DIR, `${name}.yml`);
  const update = test.info().config.updateSnapshots;
  const isCI = !!process.env.CI;

  if (!existsSync(file) || update === "all" || update === "changed") {
    if (isCI && !existsSync(file)) {
      throw new Error(`No accessibility-tree baseline e2e/aria-baselines/${name}.yml — record it locally and commit it.`);
    }
    if (!isCI) {
      mkdirSync(DIR, { recursive: true });
      writeFileSync(file, `${actual}\n`);
      return;
    }
  }
  expect(actual, `the accessibility tree of ${name} changed (e2e/aria-baselines/${name}.yml)`).toBe(
    readFileSync(file, "utf8").replace(/\n$/, ""),
  );
}
