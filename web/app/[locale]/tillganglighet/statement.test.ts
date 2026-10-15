import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { contactFromEnv, DIGG_REPORT_URL, statement, TEMPLATE, toMarkdown } from "./statement";

const { intro, sections } = statement(TEMPLATE);

/**
 * The statement is published twice, as the page and as
 * docs/tillganglighetsredogorelse.md, and the two must be one text: a
 * huvudman reading the file has to be reading what visitors see.
 */

const DOC = path.resolve(__dirname, "../../../../docs/tillganglighetsredogorelse.md");

describe("tillgänglighetsredogörelsen", () => {
  it("is the same text in docs/ as on the page", () => {
    if (process.env.UPDATE_STATEMENT) writeFileSync(DOC, toMarkdown(TEMPLATE));
    expect(readFileSync(DOC, "utf8")).toBe(toMarkdown(TEMPLATE));
  });

  it("has every section of Digg's model, in its order", () => {
    expect(sections.map((section) => section.heading)).toEqual([
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

  it("keeps Digg's placeholders in the template, and invents no details", () => {
    const text = toMarkdown(TEMPLATE);
    expect(text).toContain("{Huvudmannens namn}");
    expect(text).toContain("{e-postadress}");
    expect(text).toContain("{telefonnummer}");
    expect(text).not.toMatch(/[\w.-]+@[\w-]+\.\w+/);
    expect(text).not.toMatch(/\b0\d{1,3}[- ]\d/);
  });

  it("never shows a placeholder to the public: without configuration it says the details are missing", () => {
    const text = toMarkdown(contactFromEnv({}));
    expect(text).not.toMatch(/[{}]/);
    expect(text).toContain("Kontaktuppgifterna för tillgänglighetsfrågor är inte inlagda ännu.");
    expect(text).toContain("SchemaPro är skolans tjänst");
    // Still Digg's route, which needs no configuration.
    expect(text).toContain(`](${DIGG_REPORT_URL})`);
  });

  it("names the deployment's huvudman and contact details when they are configured", () => {
    const text = toMarkdown(
      contactFromEnv({
        ACCESSIBILITY_ORGANISATION: " Exempelkommunen ",
        ACCESSIBILITY_EMAIL: "tillganglighet@kommun.example",
        ACCESSIBILITY_PHONE: "000-00 00 00",
        ACCESSIBILITY_RESPONSE_DAYS: "5",
      }),
    );
    expect(text).toContain("Exempelkommunen står bakom SchemaPro");
    expect(text).toContain("- E-post: [tillganglighet@kommun.example](mailto:tillganglighet@kommun.example)");
    expect(text).toContain("- Telefon: 000-00 00 00");
    expect(text).toContain("Vi svarar normalt inom 5 arbetsdagar.");
    expect(text).not.toContain("inte inlagda");
  });

  // DEPLOYMENT.md §6 accepts a phone without an e-mail: the page then gives
  // the phone in both places and never also says the details are missing.
  it("with only a phone, reports to that phone and does not say the details are missing", () => {
    const text = toMarkdown(contactFromEnv({ ACCESSIBILITY_PHONE: "000-00 00 00" }));
    expect(text).toContain("- Telefon: 000-00 00 00");
    expect(text).toContain("meddela oss så att vi får veta att problemet finns: ring 000-00 00 00.");
    expect(text).not.toContain("inte inlagda");
  });

  it("names Schemavisaren in its scope", () => {
    expect(JSON.stringify(intro)).toContain("Schemavisaren");
  });

  it("says what is not done yet: the recorded screen-reader test, and the app", () => {
    const text = [...intro, ...sections.flatMap((section) => section.blocks)]
      .map((block) => JSON.stringify(block))
      .join("\n");
    expect(text).toContain("inte testats av en person som använder skärmläsare");
    expect(text).toContain("ännu inte finns i App Store eller Google Play");
  });
});
