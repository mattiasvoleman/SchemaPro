import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/*
 * What the rollover says of last year's schedule (Ett schema som start, M9): that the lessons are not copied as rows, that Generera can
 * start from them, under which class, and the label of the offer that follows the creation of the year.
 */

const years = (messages: unknown) => (messages as { years: Record<string, unknown> }).years;

describe("last year's schedule, as the rollover says it", () => {
  const say = (messages: unknown, locale: string, text: unknown, values: Record<string, unknown>) =>
    new IntlMessageFormat(text as string, locale).format(values) as string;

  it.each([
    [sv, "sv", /inte med som rader/, /efterträdare/],
    [en, "en", /not copied as rows/, /successor/],
  ] as const)("says in %s that the lessons are not copied and that Generera starts from them under the successor", (messages, locale, notCopied, successor) => {
    const sentence = (years(messages).skipped as Record<string, string>).MasterLesson!;
    const said = say(messages, locale, sentence, { count: 120 });

    expect(said).toContain("120");
    expect(said).toMatch(notCopied);
    expect(said).toMatch(successor);
    expect(said).not.toMatch(/[{}]/);
  });

  it("has the label of the offer in both languages", () => {
    expect((years(sv) as Record<string, string>).createdOfferSchedule).toBe("Lägg schemat från det här läsåret");
    expect((years(en) as Record<string, string>).createdOfferSchedule).toBe("Lay the schedule from this year");
  });
});
