import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import claims from "../../src/schedule-exchange/__fixtures__/manual-pilotkit-claims.json";

/*
 * P1 Pilotkit: what the user manual's 3.8 says about the Untis and aSc readers is said in the words the gateway's spec holds.
 *
 * src/schedule-exchange/manual-pilotkit-claims.spec.ts proves each claim on the readers (a third teacher is skipped, a week
 * written A-vecka is an odd week, a rotation of three weeks is not read, GPU002 alone is refused, ...). Here each claim's phrase must
 * stand in 3.8 as written, so that the guide cannot drop or reword a sentence the readers are held to, and the other way round.
 */

const MANUAL = readFileSync(join(__dirname, "..", "..", "docs", "manual", "anvandarmanual.html"), "utf8");
const decode = (text: string): string => text.replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const flat = (markup: string): string => decode(markup.replace(/<[^>]+>/g, " "));

/** 3.8 as text. */
const SECTION = (() => {
  const start = MANUAL.indexOf('<h3 id="s38"');
  const end = MANUAL.indexOf("</section>", start);
  return start < 0 ? "" : flat(MANUAL.slice(start, end < 0 ? undefined : end));
})();

describe("3.8 says what the Untis and aSc readers do, in the words the gateway holds", () => {
  it("has the section", () => {
    expect(SECTION).toContain("Flytta från Skola24, Untis, aSc eller Excel");
  });

  it.each(claims.claims.map((claim): [string, string] => [claim.id, claim.phrase]))("%s: \"%s\"", (_id, phrase) => {
    expect(SECTION).toContain(phrase);
  });
});
