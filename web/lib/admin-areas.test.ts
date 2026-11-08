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

  it("gates Frånvarobevakning by Drift, as the attendance it counts: the läsare reads it, the narrower profiles write it", () => {
    expect(PAGE_GATES["/admin/absence-watch"]).toBe("DRIFT");
    expect(gateOfPath("/sv/admin/absence-watch")).toBe("DRIFT");
    expect(profileOpens("EXPEDITION", "DRIFT")).toBe(true);
    expect(profileOpens("SCHEMALAGGARE", "DRIFT")).toBe(true);
    expect(closedPages("LASARE").map((page) => page.path)).not.toContain("/admin/absence-watch");
    expect(readOnlyPages("LASARE").find((page) => page.path === "/admin/absence-watch")?.areas).toEqual(["DRIFT"]);
  });

  it("gates Krisläge by Drift: starting, ending and marking an alarm are Drift's, the läsare reads it, and the settings are asked of the profile on the page", () => {
    expect(PAGE_GATES["/admin/crisis"]).toBe("DRIFT");
    expect(gateOfPath("/en/admin/crisis")).toBe("DRIFT");
    expect(profileOpens("EXPEDITION", "DRIFT")).toBe(true);
    expect(profileOpens("SCHEMALAGGARE", "DRIFT")).toBe(true);
    expect(closedPages("LASARE").map((page) => page.path)).not.toContain("/admin/crisis");
    expect(readOnlyPages("LASARE").find((page) => page.path === "/admin/crisis")?.areas).toEqual(["DRIFT"]);
  });

  it("gates Rapporteringsgrad by Drift, as the attendance whose registers it counts: the läsare reads the figures and changes no switch", () => {
    expect(PAGE_GATES["/admin/reporting-rate"]).toBe("DRIFT");
    expect(gateOfPath("/sv/admin/reporting-rate")).toBe("DRIFT");
    expect(profileOpens("EXPEDITION", "DRIFT")).toBe(true);
    expect(closedPages("LASARE").map((page) => page.path)).not.toContain("/admin/reporting-rate");
    expect(readOnlyPages("LASARE").find((page) => page.path === "/admin/reporting-rate")?.areas).toEqual(["DRIFT"]);
  });

  it("opens Analys och planering to every administrator: it reads only, the gateway gives each profile what it may have, and the settings ask the profile themselves", () => {
    expect(PAGE_GATES["/admin/analysis"]).toBeNull();
    expect(gateOfPath("/sv/admin/analysis")).toBeNull();
    for (const profile of ["FULL", "REKTOR", "SCHEMALAGGARE", "EXPEDITION", "LASARE"] as const) {
      expect(closedPages(profile).map((page) => page.path)).not.toContain("/admin/analysis");
      expect(readOnlyPages(profile).map((page) => page.path)).not.toContain("/admin/analysis");
    }
  });

  it("gates Måltidskollen by Drift: every administrator reads the portions, those who write Drift change the cut-off and the letter", () => {
    expect(PAGE_GATES["/admin/meals"]).toBe("DRIFT");
    expect(gateOfPath("/sv/admin/meals")).toBe("DRIFT");
    expect(profileOpens("EXPEDITION", "DRIFT")).toBe(true);
    expect(profileOpens("SCHEMALAGGARE", "DRIFT")).toBe(true);
    expect(closedPages("LASARE").map((page) => page.path)).not.toContain("/admin/meals");
    expect(readOnlyPages("LASARE").find((page) => page.path === "/admin/meals")?.areas).toEqual(["DRIFT"]);
  });

  it("opens Skolans dag to every administrator: it reads only, so the läsare has it whole, and no area gates it", () => {
    expect(PAGE_GATES["/admin/school-day"]).toBeNull();
    expect(gateOfPath("/sv/admin/school-day")).toBeNull();
    for (const profile of ["FULL", "REKTOR", "SCHEMALAGGARE", "EXPEDITION", "LASARE"] as const) {
      expect(closedPages(profile).map((page) => page.path)).not.toContain("/admin/school-day");
      // A page with no gate is not read-only for anybody: its one write asks the profile itself.
      expect(readOnlyPages(profile).map((page) => page.path)).not.toContain("/admin/school-day");
    }
  });

  it("gates Kvittens by Drift, as the notices it sends: the läsare reads the requests and the switch and makes no request, every other profile writes", () => {
    expect(PAGE_GATES["/admin/acknowledgements"]).toBe("DRIFT");
    expect(gateOfPath("/sv/admin/acknowledgements")).toBe("DRIFT");
    expect(profileOpens("EXPEDITION", "DRIFT")).toBe(true);
    expect(profileOpens("LASARE", "DRIFT")).toBe(false);
    expect(closedPages("LASARE").map((page) => page.path)).not.toContain("/admin/acknowledgements");
    expect(readOnlyPages("LASARE").find((page) => page.path === "/admin/acknowledgements")?.areas).toEqual(["DRIFT"]);
  });

  it("gates Checklistor by Drift, as the pupils' day it records: the läsare reads the templates, the ticks and the lists and writes none, every other profile writes", () => {
    expect(PAGE_GATES["/admin/checklists"]).toBe("DRIFT");
    expect(gateOfPath("/sv/admin/checklists")).toBe("DRIFT");
    expect(profileOpens("EXPEDITION", "DRIFT")).toBe(true);
    expect(profileOpens("LASARE", "DRIFT")).toBe(false);
    expect(closedPages("LASARE").map((page) => page.path)).not.toContain("/admin/checklists");
    expect(readOnlyPages("LASARE").find((page) => page.path === "/admin/checklists")?.areas).toEqual(["DRIFT"]);
  });

  it("gates Resurser by Planering, as the lokaler it sits beside: a planner writes the kinds and the resources, the läsare reads both, the expedition has no page", () => {
    expect(PAGE_GATES["/admin/resources"]).toBe("PLANERING");
    expect(gateOfPath("/sv/admin/resources")).toBe("PLANERING");
    expect(profileOpens("SCHEMALAGGARE", "PLANERING")).toBe(true);
    expect(closedPages("EXPEDITION").map((page) => page.path)).toContain("/admin/resources");
    expect(closedPages("LASARE").map((page) => page.path)).not.toContain("/admin/resources");
    expect(readOnlyPages("LASARE").find((page) => page.path === "/admin/resources")?.areas).toEqual(["PLANERING"]);
  });

  it("gates Externa bokningar by Drift, as the lokalbokningar its days stand among: the expedition registers, the läsare reads the series and registers none", () => {
    expect(PAGE_GATES["/admin/external-bookings"]).toBe("DRIFT");
    expect(gateOfPath("/en/admin/external-bookings")).toBe("DRIFT");
    expect(profileOpens("EXPEDITION", "DRIFT")).toBe(true);
    expect(profileOpens("SCHEMALAGGARE", "DRIFT")).toBe(true);
    expect(closedPages("EXPEDITION").map((page) => page.path)).not.toContain("/admin/external-bookings");
    expect(closedPages("LASARE").map((page) => page.path)).not.toContain("/admin/external-bookings");
    expect(readOnlyPages("LASARE").find((page) => page.path === "/admin/external-bookings")?.areas).toEqual(["DRIFT"]);
  });

  it("opens Utnyttjande to every administrator: it reads only and names no person, so no area gates it and nobody has it read-only", () => {
    expect(PAGE_GATES["/admin/utilisation"]).toBeNull();
    expect(gateOfPath("/sv/admin/utilisation")).toBeNull();
    for (const profile of ["FULL", "REKTOR", "SCHEMALAGGARE", "EXPEDITION", "LASARE"] as const) {
      expect(closedPages(profile).map((page) => page.path)).not.toContain("/admin/utilisation");
      expect(readOnlyPages(profile).map((page) => page.path)).not.toContain("/admin/utilisation");
    }
  });

  it("gates Schemavisaren by Publicering, as the publication it shows: a planner writes it, the läsare reads it, the expedition has no page", () => {
    expect(PAGE_GATES["/admin/schemavisaren"]).toBe(PAGE_GATES["/admin/publishing"]);
    expect(gateOfPath("/en/admin/schemavisaren")).toBe("PUBLICERING");
    expect(profileOpens("SCHEMALAGGARE", "PUBLICERING")).toBe(true);
    expect(closedPages("EXPEDITION").map((page) => page.path)).toContain("/admin/schemavisaren");
    expect(closedPages("LASARE").map((page) => page.path)).not.toContain("/admin/schemavisaren");
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
      .filter(([path, gate]) => gate !== "DECIDES" && (gate !== null || path === "/admin/people" || path === "/admin/class-teachers"))
      .map(([path]) => path)
      .sort();
    expect(pages.map((page) => page.path).sort()).toEqual(expected);
    // Personer: the register, and each teacher's arbetstid, behörigheter and uppdrag.
    expect(pages.find((page) => page.path === "/admin/people")?.areas).toEqual(["PERSONAL", "PLANERING"]);
    // Klasslärare: the appointments and open hours are Schemaläggning's, the option and the publishing Publicering's.
    expect(pages.find((page) => page.path === "/admin/class-teachers")?.areas).toEqual(["SCHEMALAGGNING", "PUBLICERING"]);
    expect(pages.find((page) => page.path === "/admin/timetable")?.areas).toEqual(["SCHEMALAGGNING"]);
    expect(pages.find((page) => page.path === "/admin/calendar-feeds")?.areas).toEqual(["PUBLICERING"]);
    expect(pages.find((page) => page.path === "/admin/schemavisaren")?.areas).toEqual(["PUBLICERING"]);
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
