import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/*
 * THE CARD MAY NOT SAY THAT SOMEBODY SEES WHAT IT SHOWS TO NOBODY (omgång 13, G6 del 3, granskning). A part-timer's days are the hidden
 * form for EVERY reader: the gateway stores them with no post, no teacher, no figure and no weekday (src/optimization/suggestions.ts), so
 * a reader with HR-läs gets the same sentence as anyone. The text under the change said "Vilken tjänst det gäller visas bara för rektor,
 * en administratör med full behörighet och den med HR-läs", and the handbook said "det ser bara rektor ...": both tell a principal to look
 * for the post on the card, where it is not. They are the days the staffing page shows, so that is where the text sends them.
 */

const hidden = (messages: unknown): string => (messages as { generate: { suggestions: { hidden: string } } }).generate.suggestions.hidden;

describe("who is said to see a part-timer's days", () => {
  it("says the post is not shown on the card, to anyone, and where the readers of HR see the days", () => {
    expect(hidden(sv)).toMatch(/visas inte på det här kortet, för någon/);
    expect(hidden(sv)).toMatch(/Under Tjänstefördelning ser rektor, en administratör med full behörighet och den med HR-läs/);
    expect(hidden(en)).toMatch(/is not shown on this card, to anyone/);
    expect(hidden(en)).toMatch(/Under Staffing the principal, a full administrator and anyone with HR read access/);
  });

  it("does not say that the post is shown to the readers of HR", () => {
    expect(hidden(sv)).not.toMatch(/visas bara för/);
    expect(hidden(en)).not.toMatch(/shown only to/);
  });

  it("is said the same way in the handbook", () => {
    const manual = readFileSync(resolve(process.cwd(), "../docs/manual/anvandarmanual.html"), "utf8").replace(/\s+/g, " ");
    expect(manual).not.toMatch(/det ser bara rektor/);
    expect(manual).toMatch(/visas inte på kortet, för någon: varken vilken tjänst eller vilken siffra/);
  });
});
