import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/*
 * THE NOTE UNDER THE OMFATTNING CARD THAT SAYS ITS HOURS CAN DIFFER FROM THE ANNUAL CARD'S (the review of #397, U-1).
 *
 * It sent the reader to "Undervisning per läsår" under Årsarbetstid. Under the factor model that row is called "Räknad undervisning per
 * läsår (faktor)", so a school on it looked for a label that is not there. The card cannot know the model (it is lazy and is given the scope
 * alone), so the note names the row by the words both of its labels have, and quotes neither label. The real Swedish and English are
 * formatted here, because a word a school reads is not what the component test's echo says.
 */

const staffing = (messages: unknown) =>
  (messages as { staffing: { scope: { notAnnual: string }; annual: { teachingHours: string; teachingHoursFactor: string } } }).staffing;
const note = (messages: unknown, locale: string): string => String(new IntlMessageFormat(staffing(messages).scope.notAnnual, locale).format({}));

describe.each([
  [sv, "sv", "undervisning per läsår", "Årsarbetstid"],
  [en, "en", "teaching per school year", "Annual working time"],
] as const)("the note in %#", (messages, locale, shared, card) => {
  const labels = [staffing(messages).annual.teachingHours, staffing(messages).annual.teachingHoursFactor];

  it("names the row by words that stand in the label of both load models", () => {
    for (const label of labels) expect(label.toLowerCase(), label).toContain(shared);
    expect(note(messages, locale).toLowerCase()).toContain(shared);
  });

  it("quotes neither label as the row's name: each is the label of one load model only", () => {
    for (const label of labels) expect(note(messages, locale), label).not.toContain(label);
  });

  it("says where the row is, and that the two figures are not the same measure", () => {
    expect(note(messages, locale)).toContain(card);
    expect(note(messages, locale)).toMatch(locale === "sv" ? /oviktad/ : /unweighted/);
  });
});
