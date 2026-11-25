import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTranslator } from "use-intl";
import { describe, expect, it } from "vitest";
import sv from "@/messages/sv.json";

/*
 * The user manual quotes the sentences Kontrollera veckan says ("Åk 9 ligger på minst 97 % av ramtiden", "Åk 7 är minst 94 % full. Kör
 * ändå?"), in the places that describe the button (4.x Förlägg i veckan and 5.2 Generera). A quotation that is not the app's own sentence
 * is a sentence a reader looks for and does not find, so each is held against the Swedish catalogue as the reader gets it.
 */
const MANUAL = readFileSync(join(__dirname, "..", "..", "docs", "manual", "anvandarmanual.html"), "utf8")
  .replace(/<[^>]+>/g, "")
  .replace(/\s+/g, " ");

const swedish = createTranslator({ locale: "sv", messages: sv, namespace: "weekCheck" });
const withoutFinalStop = (sentence: string) => sentence.replace(/\.$/, "");

describe("anvandarmanual: the sentences of Kontrollera veckan", () => {
  it("quotes the line under the answer as the app says it, in both places that quote it", () => {
    const line = withoutFinalStop(swedish("yearTight", { grades: "9", percent: 97 }));
    expect(line).toBe("Åk 9 ligger på minst 97 % av ramtiden");
    expect(MANUAL.split(`”${line}”`)).toHaveLength(3);
  });

  it("quotes the question before a run as the app asks it", () => {
    expect(MANUAL).toContain(`”${swedish("ask.titleTight", { grades: "7", percent: 94 })}”`);
  });

  it("says that the percent is a lower bound, where it first names the answer's line", () => {
    expect(MANUAL).toMatch(/Procenten är en nedre gräns: årskursens vecka behöver minst så stor del av ramtiden, och kan behöva mer\./);
  });
});
