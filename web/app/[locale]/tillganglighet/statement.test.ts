import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DIGG_REPORT_URL, INTRO, SECTIONS, toMarkdown } from "./statement";

/**
 * The statement is published twice, as the page and as
 * docs/tillganglighetsredogorelse.md, and the two must be one text: a
 * huvudman reading the file has to be reading what visitors see.
 */

const DOC = path.resolve(__dirname, "../../../../docs/tillganglighetsredogorelse.md");

describe("tillgänglighetsredogörelsen", () => {
  it("is the same text in docs/ as on the page", () => {
    if (process.env.UPDATE_STATEMENT) writeFileSync(DOC, toMarkdown());
    expect(readFileSync(DOC, "utf8")).toBe(toMarkdown());
  });

  it("has every section of Digg's model, in its order", () => {
    expect(SECTIONS.map((section) => section.heading)).toEqual([
      "Hur tillgänglig är tjänsten?",
      "Vad kan du göra om du inte kan använda delar av tjänsten?",
      "Rapportera brister i tjänstens tillgänglighet",
      "Tillsyn",
      "Teknisk information om tjänstens tillgänglighet",
      "Innehåll som inte är tillgängligt",
      "Bristande förenlighet med lagkraven",
      "Innehåll som inte omfattas av lagen",
      "Hur vi har testat tjänsten",
    ]);
  });

  it("sends a complaint to Digg's own form", () => {
    expect(toMarkdown()).toContain(`](${DIGG_REPORT_URL})`);
    expect(new URL(DIGG_REPORT_URL).hostname).toBe("www.digg.se");
  });

  it("leaves the huvudman's contact details as placeholders rather than inventing any", () => {
    const text = toMarkdown();
    expect(text).toContain("{Huvudmannens namn}");
    expect(text).toContain("{e-postadress}");
    expect(text).toContain("{telefonnummer}");
    expect(text).not.toMatch(/[\w.-]+@[\w-]+\.\w+/);
    expect(text).not.toMatch(/\b0\d{1,3}[- ]\d/);
  });

  it("says what is not done yet: the recorded screen-reader test, and the app", () => {
    const text = [...INTRO, ...SECTIONS.flatMap((section) => section.blocks)]
      .map((block) => JSON.stringify(block))
      .join("\n");
    expect(text).toContain("inte testats av en person som använder skärmläsare");
    expect(text).toContain("ännu inte finns i App Store eller Google Play");
  });
});
