import { describe, expect, it } from "vitest";
import { formatById } from "@/lib/skola24-formats";

/**
 * What a source page does NOT say is not written as DOKUMENTERAT. Each case is a claim checked against the page itself on 2026-11-21
 * (the review of PR 370): the label of a column is the page's own word only when the page prints it.
 */
describe("the Extens description", () => {
  const extens = formatById("skola24-extens-franvaro")!;

  it("does not say samordningsnummer: the page names TF-nummer and 'samtliga korrekta svenska personnummerformat'", () => {
    const text = extens.facts.map((fact) => fact.value).join("\n");
    expect(text).not.toMatch(/samordningsnummer/i);
    expect(text).toContain("TF-nummer");
  });

  it("calls the hours column's label our reading: the page's sentence about it is longer than the label", () => {
    const hours = extens.columns!.find((column) => column.id === "hours")!;
    expect(hours.label.source.status).toBe("TOLKAT");
    // The columns whose label IS the page's list item stay documented.
    expect(extens.columns!.find((column) => column.id === "unitId")!.label.source.status).toBe("DOKUMENTERAT");
  });
});
