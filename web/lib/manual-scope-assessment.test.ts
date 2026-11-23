import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import sv from "@/messages/sv.json";

/*
 * The user manual's paragraphs on Rektorns bedömning och undantag (4.3) hold against the app they describe:
 *   - the label they name is the card's own title;
 *   - they say what the teacher is shown of the assessment, the note included (Min tjänst's card draws the note as it draws the level
 *     and the exception), so that the one who writes the note knows who reads it;
 *   - they name only what says "undantag registrerat": the card. The matrix's mark and the page's warning say that a teacher is over,
 *     and the samverkansfil of Rapporter has no column for the scope at all, so "matrisen och rapporten" would promise a place that is not there.
 */
const ROOT = join(__dirname, "..", "..");
const MANUAL = readFileSync(join(ROOT, "docs", "manual", "anvandarmanual.html"), "utf8");
const EXPORTS = readFileSync(join(__dirname, "staffing-exports.ts"), "utf8");
const start = MANUAL.indexOf("<strong>Rektorns bedömning och undantag.</strong>");
const end = MANUAL.indexOf('<div class="note">', start);
const text = MANUAL.slice(start, end).replace(/<[^>]+>/g, "").replace(/\s+/g, " ");

describe("anvandarmanual 4.3: Rektorns bedömning och undantag", () => {
  it("is found", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
  });

  it("names the card by its title in the app", () => {
    expect(text).toContain(sv.staffing.scopeAssessment.title);
  });

  it("says that the teacher sees the note, with the level and the exception", () => {
    expect(text).toMatch(/läraren ser sin egen nivå, sitt undantag och anteckningen under Min tjänst/);
  });

  it("says that the card and the mark in the matrix say a teacher is over, and that the card is where the exception is said", () => {
    expect(text).toContain("kortet och markeringen i matrisen säger det, kortet med undantag registrerat bredvid");
    expect(text).not.toMatch(/matrisen och rapporten/);
  });

  it("names no report as saying it while the samverkansfil carries nothing of the scope", () => {
    expect(EXPORTS).not.toMatch(/ordinanceHighestHours|OVER_MAX|OVER_OWN|exceptionKind|assignment-scope/);
  });
});
