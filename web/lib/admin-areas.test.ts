import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PAGE_GATES, gateOfPath, profileOpens, profileReadsHr } from "./admin-areas";

describe("admin areas (Roller i skolan)", () => {
  it("gives every admin page a gate, so a new page is a decision and not a default", () => {
    const pages = readdirSync(join(__dirname, "..", "app", "[locale]", "(app)", "admin"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `/admin/${entry.name}`)
      .sort();
    expect(pages.filter((page) => !(page in PAGE_GATES))).toEqual([]);
  });

  it("reads a page's gate through the locale prefix and from its sub-pages", () => {
    expect(gateOfPath("/sv/admin/rooms")).toBe("PLANERING");
    // Personer has two areas' buttons, and gates each control instead.
    expect(gateOfPath("/sv/admin/people")).toBeNull();
    expect(gateOfPath("/en/admin/staffing/uppdragsbeskrivning/x")).toBe("PLANERING");
    expect(gateOfPath("/admin")).toBeNull();
    expect(gateOfPath("/sv/admin")).toBeNull();
    // A path that only starts like a page is not that page.
    expect(gateOfPath("/admin/roomsx")).toBeNull();
    expect(gateOfPath("/admin/dataskydd")).toBe("DECIDES");
  });

  it("opens a page to the profiles that write its area, and the decisions to rektor and full", () => {
    expect(profileOpens("EXPEDITION", "PERSONAL")).toBe(true);
    expect(profileOpens("SCHEMALAGGARE", "PERSONAL")).toBe(false);
    expect(profileOpens("SCHEMALAGGARE", "PUBLICERING")).toBe(true);
    expect(profileOpens("EXPEDITION", "DECIDES")).toBe(false);
    expect(profileOpens("REKTOR", "DECIDES")).toBe(true);
    expect(profileOpens(null, "DRIFT")).toBe(false);
    expect(profileOpens(null, null)).toBe(true);
  });

  it("lets HR-läs read tjänst % only for the narrow profiles that hold it", () => {
    expect(profileReadsHr("SCHEMALAGGARE", true)).toBe(true);
    expect(profileReadsHr("SCHEMALAGGARE", false)).toBe(false);
    expect(profileReadsHr("REKTOR", false)).toBe(true);
  });
});
