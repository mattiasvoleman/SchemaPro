import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * The user manual's paragraph on SS12000 under 3.8 (Från Skola24) promises that the register is the source and that the files above are not
 * needed. The guide gives Untis and aSc a reservation that it has not been tried in the real program ("Inte prövat"), and the fetch has not
 * been run against a supplier's real register either (the roadmap lists "SS12000 skarp körning" as waiting). A promise without it is read as
 * a thing that has been done, so the paragraph says it (the review of #401, L-1; decided by the coordinator).
 */
const MANUAL = readFileSync(join(__dirname, "..", "..", "docs", "manual", "anvandarmanual.html"), "utf8");
const start = MANUAL.indexOf("Följer skolans eller kommunens elevregister SS12000 2.1");
const end = MANUAL.indexOf("</p>", start);
const paragraph = MANUAL.slice(start, end).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

describe("anvandarmanual 3.8: the SS12000 paragraph", () => {
  it("is found, once", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(MANUAL.split("Följer skolans eller kommunens elevregister SS12000 2.1")).toHaveLength(2);
  });

  it("says that the fetch has not been run against a supplier's real register, and to try it with one school first", () => {
    expect(paragraph).toContain("Hämtningen följer standarden men har inte körts mot en leverantörs riktiga register: prova den med en skola först.");
  });

  it("says it after the promise it qualifies, in the same paragraph, and not before it", () => {
    const promise = paragraph.indexOf("filerna ovan behövs inte");
    const reservation = paragraph.indexOf("Hämtningen följer standarden");
    expect(promise).toBeGreaterThan(0);
    expect(reservation).toBeGreaterThan(promise);
  });

  it("keeps the promise's own words, so that the reservation qualifies it and does not replace it", () => {
    expect(paragraph).toContain("Registret är då källan, och filerna ovan behövs inte för dem.");
  });
});
