import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTranslator } from "use-intl";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/**
 * The warning at the top of /admin/staffing (scopeNotice*) says what the school can do about a teacher over the ordinance's
 * highest level. The page's own tests echo keys and so prove which sentence is said, not whether it is true: a sentence that
 * sends the school to a setting under Inställningar is true only when the policy form carries that setting
 * (StaffingPolicy.assignmentScopeMode has a column since the reference-data PR, and a policy form field only when the
 * write check lands). Until then the manual (4.3) says the opposite: no assignment is warned about when it is saved.
 */
const forms = readFileSync(join(__dirname, "..", "lib", "staffing-forms.ts"), "utf8");
const formHasTheSetting = forms.includes("assignmentScopeMode");

const swedish = createTranslator({ locale: "sv", messages: sv, namespace: "staffing" });
const english = createTranslator({ locale: "en", messages: en, namespace: "staffing" });

describe("the warning about teachers over the ordinance", () => {
  it.each([
    ["sv", swedish("scopeNoticeBody"), /Inställningar/],
    ["en", english("scopeNoticeBody"), /Settings/],
  ])("%s: sends the school to a setting only when the policy form has one", (_locale, body, settings) => {
    if (settings.test(body)) expect(formHasTheSetting).toBe(true);
  });

  it("names the ordinance by its own title, which covers preschool teachers too", () => {
    expect(swedish("scopeNoticeBody")).toContain("lärares och förskollärares undervisningsuppdrag");
    expect(english("scopeNoticeBody")).toContain("preschool teachers'");
  });
});
