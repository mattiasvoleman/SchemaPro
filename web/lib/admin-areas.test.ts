import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PAGE_GATES,
  closedPages,
  gateOfPath,
  profileOpens,
  profileReadsHr,
  profileReadsPage,
  readOnlyPages,
} from "./admin-areas";

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

describe("the läsare (Läsbehörighet)", () => {
  it("opens no page by writing, and may be given HR-läs", () => {
    for (const gate of ["PLANERING", "SCHEMALAGGNING", "PUBLICERING", "DRIFT", "PERSONAL", "INTEGRATIONER", "DECIDES"] as const) {
      expect(profileOpens("LASARE", gate)).toBe(false);
    }
    expect(profileReadsHr("LASARE", false)).toBe(false);
    expect(profileReadsHr("LASARE", true)).toBe(true);
  });

  it("closes only the decision pages to it: dataskydd holds the läslogg, which those who decide read", () => {
    expect(closedPages("LASARE")).toEqual([{ path: "/admin/dataskydd", gate: "DECIDES" }]);
  });

  it("opens every other admin page read-only, each named by its area, Personer by the register and planering", () => {
    const pages = readOnlyPages("LASARE");
    const expected = Object.entries(PAGE_GATES)
      .filter(([path, gate]) => gate !== "DECIDES" && (gate !== null || path === "/admin/people"))
      .map(([path]) => path)
      .sort();
    expect(pages.map((page) => page.path).sort()).toEqual(expected);
    // Personer: the register, and each teacher's arbetstid, behörigheter and uppdrag.
    expect(pages.find((page) => page.path === "/admin/people")?.areas).toEqual(["PERSONAL", "PLANERING"]);
    expect(pages.find((page) => page.path === "/admin/timetable")?.areas).toEqual(["SCHEMALAGGNING"]);
    expect(pages.find((page) => page.path === "/admin/calendar-feeds")?.areas).toEqual(["PUBLICERING"]);
    expect(pages.some((page) => page.path === "/admin")).toBe(false);
    expect(profileReadsPage("LASARE", "DRIFT")).toBe(true);
    expect(profileReadsPage("LASARE", "DECIDES")).toBe(false);
  });

  it("leaves the narrower profiles their closed pages, and opens nothing read-only to them or to a writer", () => {
    for (const profile of ["FULL", "REKTOR", "SCHEMALAGGARE", "EXPEDITION"] as const) {
      expect(readOnlyPages(profile)).toEqual([]);
      expect(profileReadsPage(profile, "INTEGRATIONER")).toBe(false);
    }
    expect(closedPages("SCHEMALAGGARE").map((page) => page.path)).toContain("/admin/integrations");
    expect(readOnlyPages(null)).toEqual([]);
  });
});
