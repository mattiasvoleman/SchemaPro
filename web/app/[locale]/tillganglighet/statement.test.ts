import { readdirSync, readFileSync, writeFileSync } from "node:fs";
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
    expect(text).toContain("Rastra Schema är skolans tjänst");
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
    expect(text).toContain("Exempelkommunen står bakom Rastra Schema");
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

  describe("the public page Pseudonymisera en fil (/pseudonymisera)", () => {
    const WEB = path.resolve(__dirname, "../../..");
    const testing = sections.find((section) => section.heading === "Hur vi har testat tjänsten")!;
    const bullets = testing.blocks.flatMap((block) => (block.kind === "ul" ? block.items.map((item) => item.map((part) => (typeof part === "string" ? part : part.text)).join("")) : []));
    const mentions = (text: string) => text.includes("Pseudonymisera en fil");

    it("is in the scope: it is public, and the scope sentence says so", () => {
      const scope = intro.map((block) => JSON.stringify(block)).find((text) => text.includes("Redogörelsen gäller"))!;
      expect(mentions(scope)).toBe(true);
      expect(scope).toContain("utan inloggning");
    });

    it("is said to be checked with axe only while the page has an axe spec that runs in the accessibility project", () => {
      // The statement says the page is scanned with axe, empty, with a file and with a result, in both languages: that holds while this spec does.
      const spec = readFileSync(path.join(WEB, "e2e/pseudonymiserare.a11y.spec.ts"), "utf8");
      expect(spec).toContain("/sv/pseudonymisera");
      expect(spec).toContain("/en/pseudonymisera");
      expect(readFileSync(path.join(WEB, "playwright.config.ts"), "utf8")).toContain("(a11y|a11y-app|aria)");
      const axe = bullets.find((bullet) => bullet.startsWith("Automatisk granskning med verktyget axe"))!;
      expect(mentions(axe)).toBe(true);
    });

    it("is said to have no saved comparison of what assistive technology is told, and has none", () => {
      // The statement says so while no accessibility-tree baseline is kept for it: a baseline added later makes the sentence untrue, and this fails.
      const baselines = readdirSync(path.join(WEB, "e2e/aria-baselines"));
      expect(baselines.filter((name) => /pseudonym/i.test(name))).toEqual([]);
      expect(readFileSync(path.join(WEB, "e2e/aria.spec.ts"), "utf8")).not.toMatch(/pseudonymisera/i);
      const aria = bullets.find((bullet) => bullet.startsWith("Granskning av vad hjälpmedel får veta"))!;
      expect(aria).toMatch(/Pseudonymisera en fil har ingen sådan sparad jämförelse/);
    });
  });

  it("says what is not done yet: the recorded screen-reader test, and the app", () => {
    const text = [...intro, ...sections.flatMap((section) => section.blocks)]
      .map((block) => JSON.stringify(block))
      .join("\n");
    expect(text).toContain("inte testats av en person som använder skärmläsare");
    expect(text).toContain("ännu inte finns i App Store eller Google Play");
  });
});
