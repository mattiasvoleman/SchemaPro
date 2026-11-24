import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * The user manual's table of what Generera can say when a run gives no answer (5.x) holds the row for the API's own wait that ran out:
 * "Tjänsten väntade ett antal sekunder på schemamotorn och fick inget svar". It said the wait was "en inställning i tjänsten" and the
 * cause when the message names a higher figure for the engine. Since the gateway sends the engine its deadline (M1), a wait that still
 * ran out is as likely an engine or a network that hung, and the app's own sentence (scheduleCandidates.jobErrors.ENGINE_WAIT_EXPIRED_SHORT)
 * no longer says it was the setting. The row says no more than the sentence does.
 */
const MANUAL = readFileSync(join(__dirname, "..", "..", "docs", "manual", "anvandarmanual.html"), "utf8");
const KEY = "Tjänsten väntade ett antal sekunder på schemamotorn och fick inget svar";
const start = MANUAL.indexOf(`<td class="k">${KEY}</td>`);
const end = MANUAL.indexOf("</tr>", start);
const row = MANUAL.slice(start, end).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("anvandarmanual: the row for a wait that ran out", () => {
  it("is found", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(MANUAL.split(`<td class="k">${KEY}</td>`)).toHaveLength(2);
  });

  it("does not say that the length of the wait is the cause, or that it is a setting", () => {
    expect(row).not.toMatch(/inställning/);
    expect(row).not.toMatch(/är det väntetiden som är för kort/);
    expect(row).not.toMatch(/inget i schemat/);
  });

  it("says what it cannot tell from the message, and the three things it may be, as the app's sentence does", () => {
    expect(row).toContain("syns inte i meddelandet");
    expect(row).toContain("för kort för en äldre motor");
    expect(row).toContain("motorn eller nätet mellan tjänsten och motorn kan ha hängt sig");
  });

  it("gives the advice the app gives: wait, run again, and contact whoever runs the service", () => {
    expect(row).toMatch(/Vänta några minuter och kör om/);
    expect(row).toContain("hör av dig till den som driver tjänsten");
  });
});
