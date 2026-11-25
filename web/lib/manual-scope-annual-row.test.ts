import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * The manual's paragraph on how the omfattning's hours are counted says they can differ from the annual card's row. The card's note names that
 * row by the words both of its labels have ("the row for teaching per school year", scope-card.annual-wording.test.ts), because the row is
 * "Undervisning per läsår" under the percentage model and "Räknad undervisning per läsår (faktor)" under the factor model. The manual quoted the
 * first label as the row's name, the sentence the card's note was changed from: a school on the factor model looks for a label that is not there.
 */
const MANUAL = readFileSync(join(__dirname, "..", "..", "docs", "manual", "anvandarmanual.html"), "utf8");
const start = MANUAL.indexOf("Timmarna kan också skilja sig från");
const end = MANUAL.indexOf("</p>", start);
const paragraph = MANUAL.slice(start, end);
const text = paragraph.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

describe("anvandarmanual 4.3: the sentence about the annual card's row", () => {
  it("is found, once", () => {
    expect(start).toBeGreaterThan(0);
    expect(MANUAL.split("Timmarna kan också skilja sig från")).toHaveLength(2);
  });

  it("names the row by the words both load models' labels have, and quotes neither label as its name", () => {
    expect(text).toContain("raden för undervisning per läsår på kortet Årsarbetstid");
    expect(paragraph).not.toMatch(/class="ui">\s*Undervisning per läsår\s*</);
    expect(paragraph).not.toMatch(/class="ui">\s*Räknad undervisning per läsår/);
  });

  it("still says what the figures are and that both count school days", () => {
    expect(text).toContain("räknas med procent och faktor: den här siffran är lektionernas egen tid");
    expect(text).toContain("Båda räknar skoldagarna");
  });
});
