import { describe, expect, it } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";

/*
 * THE CARD MAY PROMISE WHAT THE PAGE KEEPS, AND NOT MORE (omgång 13, G6, granskningen av #388 M-1 and D9). "Senaste körning" was the run THIS
 * PAGE started (`jobId` in generate/page.tsx), so a reader who left the page while the engine counted came back to nothing, and the line
 * shown while it counts could not say "you can leave the page". D9 makes the page take up the year's NEWEST run when it is offered or holds an
 * analysis, so the line may say it again, and says the condition: the answer is on the run, and it is shown under "Senaste körning" for as
 * long as the run is the year's newest (another run of the year started meanwhile is the newest instead).
 */

const running = (messages: unknown): string => (messages as { generate: { suggestions: { running: string } } }).generate.suggestions.running;

describe("the line shown while the engine counts", () => {
  it("says that the page may be left, and where the answer is when the reader comes back", () => {
    expect(running(sv)).toMatch(/Du kan lämna sidan/);
    expect(running(sv)).toMatch(/visas under Senaste körning när du kommer tillbaka/);
    expect(running(en)).toMatch(/You can leave the page/);
    expect(running(en)).toMatch(/shown under Last run when you come back/);
  });

  it("says on what condition: only while the run is the year's newest", () => {
    expect(running(sv)).toMatch(/så länge körningen är årets senaste/);
    expect(running(en)).toMatch(/as long as the run is the year's newest/);
  });

  it("no longer says that the answer is lost, or asks the reader to stay", () => {
    expect(running(sv)).not.toMatch(/Stanna kvar på sidan|visas inte svaret/);
    expect(running(en)).not.toMatch(/Stay on the page|not shown when you come back/);
  });
});
