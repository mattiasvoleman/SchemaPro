import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/*
 * A PART-TIMER'S DAYS ARE MERGED INTO ONE CHANGE, AND THE CARD MAY NOT SAY IT IS ONE POST (omgång 13, G6 del 3, granskning).
 * The gateway keeps a part-timer's days in the hidden form (no post, no teacher, no figure) and merges several of them into ONE change
 * (src/optimization/suggestions.ts: "Two part-timers' days say nothing the first did not"), whose `total` counts the merged list. The
 * engine's proof is for the list it checked: two posts that each needed a day are SOLVED_TOGETHER, stored as ONE change and a total of 1.
 * A card that then says "En deltidstjänst behöver ha en dag till" under "Löser veckan tillsammans" lets the school give ONE post a day and
 * expect the week to hold; the proof is for all of them. And a total of 1 under SOLVED_TOGETHER can only be that merge, so the intro says so.
 */

type Node = { [key: string]: string | Node };
const say = (messages: unknown, locale: string, path: string, values: Record<string, unknown> = {}): string => {
  let node: string | Node = (messages as { generate: { suggestions: Node } }).generate.suggestions;
  for (const key of path.split(".")) node = (node as Node)[key]!;
  return String(new IntlMessageFormat(node as string, locale).format(values));
};

describe("a part-timer's days under a proof that covers several posts", () => {
  it("is said as one or more posts, never as one", () => {
    expect(say(sv, "sv", "change.TEACHER_WORK_DAYS")).toMatch(/En eller flera deltidstjänster/);
    expect(say(en, "en", "change.TEACHER_WORK_DAYS")).toMatch(/One or more part-time posts/);
    expect(say(sv, "sv", "change.TEACHER_WORK_DAYS")).not.toMatch(/^En deltidstjänst /);
  });

  it("says in the intro, for a list of one change that is proved together, that the change covers several posts", () => {
    expect(say(sv, "sv", "intro.SOLVED_TOGETHER", { total: 1 })).toMatch(/den här ändringen, som gäller flera tjänster, tillsammans/);
    expect(say(en, "en", "intro.SOLVED_TOGETHER", { total: 1 })).toMatch(/this change, which covers several posts, together/);
  });

  it("is unchanged for a list of several, which is what the engine's own proof says", () => {
    expect(say(sv, "sv", "intro.SOLVED_TOGETHER", { total: 3 })).toMatch(/de 3 ändringarna tillsammans/);
    expect(say(sv, "sv", "intro.SOLVED_TOGETHER", { total: 3 })).not.toMatch(/flera tjänster/);
  });
});
