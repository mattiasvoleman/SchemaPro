import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * The user manual lists the causes the card "Så gick tiden" can name (5.2). The list is the card's own: a cause the card can say and
 * the manual does not list is one a reader finds nowhere, so the probe that changes the week without lifting a rule stands beside the
 * rule that was lifted, as it does on the card (timeout-cause.ts, PROBE_CHANGED_WEEK).
 */
const MANUAL = readFileSync(join(__dirname, "..", "..", "docs", "manual", "anvandarmanual.html"), "utf8")
  .replace(/<[^>]+>/g, "")
  .replace(/\s+/g, " ");

describe("anvandarmanual: the causes of a run that ran out of time", () => {
  it("names a probe that changes the week beside the rule that was lifted, both as measured and not proved", () => {
    expect(MANUAL).toContain(
      "en regel som gjorde veckan lösbar när den lättades (mätt, inte bevisat), ett prov som ändrar veckan i stället för att lätta en regel, till exempel en egen lärare på varje delad grupp eller de förlagda lektionerna släppta (mätt, inte bevisat), en trång vecka",
    );
  });
});
