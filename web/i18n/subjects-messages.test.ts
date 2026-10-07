import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/**
 * The Ämnen dialog's national-code suggestion, as the reader sees it.
 *
 * The page test echoes keys, so it proves WHICH code is offered (SV and SVA
 * both offer SV_SVA, the one national subject Svenska/SvA) but not what the
 * sentence then claims. Rendered here with the real messages.
 */
describe.each([
  ["sv", sv],
  ["en", en],
] as const)("the %s national-code suggestion", (locale, messages) => {
  const t = createTranslator({ locale, messages, namespace: "subjects" });

  it("never calls the national code the school's own code when the two differ", () => {
    // A school writes SV; the offer is SV_SVA. "Skolans kod SV_SVA är också
    // den nationella koden …" stated something false about the school's data.
    const text = t("nationalCodeSuggestion", {
      code: "SV_SVA",
      name: "Svenska eller svenska som andraspråk",
    });
    expect(text).toContain("SV_SVA");
    expect(text).not.toMatch(/(Skolans kod|school code) SV_SVA/i);
  });
});
