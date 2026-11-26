import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import en from "../messages/en.json";
import sv from "../messages/sv.json";

/*
 * THE STEPS OF A SOLVE THE CARD HAS WORDS FOR (G6b, g460-L-1). The gateway lists the steps of the engine's account it passes on
 * (src/optimization/timeout-report.ts TIMEOUT_STAGES), and the page says each of them in a school's words in two places: the list under
 * "Så gick tiden" (`generate.timeoutAccount.stage`) and the sentence of a run the API stopped waiting for (`ENGINE_TIMED_OUT_AT`).
 * A step the gateway passes on that either text lacks reads "Ett steg" / "a step": START and YEARS were that for a night, since the engine
 * added them before the page had words. This holds the gateway's list to the two texts, in both languages, so that the next one is not.
 */

const GATEWAY = readFileSync(join(__dirname, "..", "..", "src", "optimization", "timeout-report.ts"), "utf8");

const gatewayStages = (): string[] => {
  const body = /export const TIMEOUT_STAGES = \[([\s\S]*?)\] as const;/.exec(GATEWAY)?.[1] ?? "";
  return [...body.matchAll(/'([A-Z_]+)'/g)].map((found) => found[1]!);
};

const selectNames = (text: string): string[] => [...text.matchAll(/\b([A-Z][A-Z_]+) \{/g)].map((found) => found[1]!);

type Messages = {
  generate: { timeoutAccount: { stage: string } };
  candidates?: unknown;
  [key: string]: unknown;
};

/** `ENGINE_TIMED_OUT_AT` is a message of the run's errors, wherever the file keeps them: found by name. */
const timedOutAt = (messages: unknown): string => {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "ENGINE_TIMED_OUT_AT" && typeof child === "string") found.push(child);
      else walk(child);
    }
  };
  walk(messages);
  expect(found, "ENGINE_TIMED_OUT_AT is one message").toHaveLength(1);
  return found[0]!;
};

describe("the steps the gateway passes on, and the words the page has for them", () => {
  it("reads the gateway's list (a parse that finds nothing would pass everything below)", () => {
    expect(gatewayStages()).toEqual(["PRECHECKS", "START", "BUILD", "SITES", "SEARCH_CLEAN", "YEARS", "SEARCH_CLONE", "PROBE"]);
  });

  it.each([
    ["the list under 'Så gick tiden', in Swedish", (sv as unknown as Messages).generate.timeoutAccount.stage],
    ["the list under 'Så gick tiden', in English", (en as unknown as Messages).generate.timeoutAccount.stage],
    ["the run the API stopped waiting for, in Swedish", timedOutAt(sv)],
    ["the run the API stopped waiting for, in English", timedOutAt(en)],
  ])("has a sentence for every step in %s", (_where, text) => {
    const said = selectNames(text.slice(text.indexOf("select,")));
    for (const stage of gatewayStages()) expect(said, `${stage} has no words`).toContain(stage);
  });
});
