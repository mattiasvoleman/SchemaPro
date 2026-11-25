import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/*
 * WORDS THE CARD MAY NOT USE FOR WHAT IT CANNOT SAY (omgång 13, M2, granskningen av #378).
 *
 * `totalSeconds` is counted from where the engine's solve begins: the gateway's own work before it (building the request, the
 * transfer) is not in it, so the card calls it the solver's work and never "the whole run". And the card's last resort for a run it
 * found no cause for does not send a school to Bästa möjliga schema, which most schools have switched off and which the page already
 * offers, under the card, to the schools that have it on (`offersBestEffort`): a dead end for the others.
 */

const say = (messages: unknown, locale: string, path: string[], values: Record<string, unknown> = {}): string => {
  let node: unknown = (messages as { generate: { timeoutAccount: unknown } }).generate.timeoutAccount;
  for (const key of path) node = (node as Record<string, unknown>)[key];
  return String(new IntlMessageFormat(node as string, locale).format(values));
};

describe("the card's words", () => {
  it("calls the total the solver's work and not the whole run", () => {
    expect(say(sv, "sv", ["total"], { seconds: 212 })).toBe("Lösarens arbete tog 212 s.");
    expect(say(en, "en", ["total"], { seconds: 212 })).toBe("The solver's work took 212 s.");
    expect(say(sv, "sv", ["total"], { seconds: 212 })).not.toMatch(/hela körningen/i);
    expect(say(en, "en", ["total"], { seconds: 212 })).not.toMatch(/whole run/i);
  });

  it("says of steps it has no name for that it has none, and that a search may be among them", () => {
    expect(say(sv, "sv", ["otherSteps"], { seconds: 90 })).toBe("Steg som den här sidan inte har ord för: 90 s");
    expect(say(en, "en", ["otherSteps"], { seconds: 90 })).toBe("Steps this page has no words for: 90 s");
    expect(say(sv, "sv", ["searchOther"], { seconds: 90 })).toMatch(/en sökning kan ingå/);
    expect(say(en, "en", ["searchOther"], { seconds: 90 })).toMatch(/a search may be among them/);
  });

  it("does not send a school with no cause to find to a feature it may not have", () => {
    expect(say(sv, "sv", ["next", "NOTHING_FOUND"])).not.toMatch(/bästa möjliga/i);
    expect(say(en, "en", ["next", "NOTHING_FOUND"])).not.toMatch(/best possible/i);
    expect(say(sv, "sv", ["next", "NOTHING_FOUND"])).toMatch(/^Kör igen\./);
  });
});
