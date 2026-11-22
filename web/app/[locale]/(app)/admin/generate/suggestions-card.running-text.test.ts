import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/*
 * THE CARD MAY NOT PROMISE WHAT THE PAGE DOES NOT KEEP (omgång 13, G6 del 3, granskning). "Senaste körning" is the run THIS PAGE started
 * (`jobId` in generate/page.tsx): after a reload, or after a switch of year, the page has no run and draws no card, so an answer the
 * gateway stored on the run is not reached until D9 (the page adopting the newest refused run) is built. The line shown while the engine
 * counts cannot say "you can leave the page" until then: a reader who does would come back to nothing and ask for the analysis again.
 */

const running = (messages: unknown): string => (messages as { generate: { suggestions: { running: string } } }).generate.suggestions.running;

describe("the line shown while the engine counts", () => {
  it("does not say that the page may be left, because the answer is not shown to a reader who comes back", () => {
    expect(running(sv)).not.toMatch(/kan lämna sidan/i);
    expect(running(en)).not.toMatch(/can leave the page/i);
  });

  it("says to stay on the page, and what happens if the reader does not", () => {
    expect(running(sv)).toMatch(/Stanna kvar på sidan/);
    expect(running(sv)).toMatch(/visas inte svaret när du kommer tillbaka/);
    expect(running(en)).toMatch(/Stay on the page/);
    expect(running(en)).toMatch(/not shown when you come back/);
  });
});
