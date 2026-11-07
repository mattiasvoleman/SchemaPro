import { describe, expect, it } from "vitest";
import { layoutDay } from "@/lib/day-lanes";
import {
  clientIpOf,
  trustedHopsOf,
  isIndex,
  placement,
  readStaffViewerResponse,
  readViewerResponse,
  shiftWeek,
  shownDays,
  staffViewerFetchOf,
  timed,
  viewerAddressOf,
  viewerFetchOf,
  viewerHref,
  viewerQueryOf,
  weekSpan,
  canGoBack,
  type PublicDay,
} from "@/lib/public-timetable";

const TOKEN = "A".repeat(43);
const UUID = "0b9d6a5e-3c1f-4a7b-9d2e-5f6a7b8c9d0e";

describe("the viewer's request to the gateway", () => {
  it("forwards the address the platform's edge appended — the rightmost — never one the browser wrote", () => {
    expect(clientIpOf("6.6.6.6, 203.0.113.9")).toBe("203.0.113.9");
    expect(clientIpOf(" 198.51.100.4 ")).toBe("198.51.100.4");
    expect(clientIpOf("")).toBeNull();
    expect(clientIpOf(null)).toBeNull();
    expect(clientIpOf(`1.1.1.1, ${"x".repeat(65)}`)).toBeNull();
  });

  it("takes the visitor's own entry behind proxies that add their own address, as many as the deployment says", () => {
    // A CDN in front of the platform's edge: 1.1.1.1 the browser wrote, then the visitor, then the platform's edge, then the CDN.
    const chain = "1.1.1.1, 198.51.100.4, 203.0.113.9, 192.0.2.77";
    expect(clientIpOf(chain)).toBe("192.0.2.77");
    expect(clientIpOf(chain, 1)).toBe("203.0.113.9");
    expect(clientIpOf(chain, 2)).toBe("198.51.100.4");
    // Not that many entries: nobody, rather than a proxy's address for everyone.
    expect(clientIpOf("203.0.113.9", 1)).toBeNull();
    expect(clientIpOf(chain, -3)).toBe("192.0.2.77");
    expect(viewerFetchOf("http://api/", TOKEN, { target: null, date: null }, chain, "k".repeat(40), 2).headers["X-Viewer-Client-Ip"]).toBe("198.51.100.4");
  });

  it("reads PUBLIC_VIEWER_TRUSTED_HOPS as a whole number from 0 to 5 and anything else as none", () => {
    expect(trustedHopsOf(undefined)).toBe(0);
    expect(trustedHopsOf("")).toBe(0);
    expect(trustedHopsOf("2")).toBe(2);
    expect(trustedHopsOf("5")).toBe(5);
    for (const bad of ["6", "-1", "1.5", "two", "NaN", "1e3"]) expect(trustedHopsOf(bad)).toBe(0);
  });

  it("sends the address only beside the proxy key, and neither without both", () => {
    const query = { target: null, date: null };
    expect(viewerFetchOf("http://api/", TOKEN, query, "6.6.6.6, 203.0.113.9", "k".repeat(40)).headers).toEqual({
      Accept: "application/json",
      "X-Viewer-Proxy-Key": "k".repeat(40),
      "X-Viewer-Client-Ip": "203.0.113.9",
    });
    expect(viewerFetchOf("http://api", TOKEN, query, "203.0.113.9", undefined).headers).toEqual({ Accept: "application/json" });
    expect(viewerFetchOf("http://api", TOKEN, query, null, "k".repeat(40)).headers).toEqual({ Accept: "application/json" });
  });

  it("asks for the token's week, the target and the date, and nothing malformed", () => {
    expect(viewerFetchOf("http://api/", TOKEN, { target: UUID, date: "2026-10-12" }, null, undefined).url).toBe(
      `http://api/public/v1/timetables/${TOKEN}?target=${UUID}&date=2026-10-12`,
    );
    expect(viewerQueryOf({ target: "1 OR 1=1", date: "2026-13-45" })).toEqual({ target: null, date: null });
    // Days the engine rolls over, and a year nobody means: dropped, never sent.
    for (const date of ["2026-02-30", "2026-04-31", "0000-01-01"]) {
      expect(viewerQueryOf({ date }).date).toBeNull();
    }
    expect(viewerQueryOf({ date: "2028-02-29" }).date).toBe("2028-02-29");
    expect(viewerQueryOf({ target: [UUID.toUpperCase(), "x"], date: "2026-10-12" })).toEqual({ target: UUID, date: "2026-10-12" });
    expect(viewerFetchOf("http://api", TOKEN, { target: null, date: null }, null, undefined).url).toBe(
      `http://api/public/v1/timetables/${TOKEN}`,
    );
  });

  it("reads the gateway's answer: a document, the one not-found, a rate limit, or nothing usable", async () => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    const week = { kind: "GROUP", title: "7A", school: "S", week: { from: "2026-10-12", to: "2026-10-18", isoWeek: "2026-W42" }, days: [] };
    await expect(readViewerResponse(json(200, week))).resolves.toEqual({ kind: "document", document: week });
    await expect(readViewerResponse(json(404, { status: 404 }))).resolves.toEqual({ kind: "notFound" });
    await expect(readViewerResponse(json(429, {}))).resolves.toEqual({ kind: "busy" });
    await expect(readViewerResponse(json(500, {}))).resolves.toEqual({ kind: "unavailable" });
    await expect(readViewerResponse(new Response("<html>", { status: 200 }))).resolves.toEqual({ kind: "unavailable" });
    expect(isIndex({ kind: "ROOM", school: "S", targets: [] })).toBe(true);
  });
});

describe("the viewer's signed-in twin (a viewer for staff)", () => {
  const query = { target: UUID, date: "2026-10-12" };

  it("asks /api/v1/schemavisaren as the person, with the school they chose and no proxy key or client address", () => {
    const asked = staffViewerFetchOf("http://api/", TOKEN, query, "access.jwt", "7C9E6679-7425-40DE-944B-E07FC1F90AE7");
    expect(asked.url).toBe(`http://api/api/v1/schemavisaren/${TOKEN}?target=${UUID}&date=2026-10-12`);
    expect(asked.headers).toEqual({
      Accept: "application/json",
      Authorization: "Bearer access.jwt",
      "x-school-id": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    });
    // A login with one school names none; a malformed choice is not sent.
    expect(staffViewerFetchOf("http://api", TOKEN, { target: null, date: null }, "t", null)).toEqual({
      url: `http://api/api/v1/schemavisaren/${TOKEN}`,
      headers: { Accept: "application/json", Authorization: "Bearer t" },
    });
    expect(staffViewerFetchOf("http://api", TOKEN, { target: null, date: null }, "t", "not-an-id").headers).not.toHaveProperty("x-school-id");
  });

  it("asks for a code in its address spelling", () => {
    expect(staffViewerFetchOf("http://api", viewerAddressOf("k7qm2 x9drt 4v8wn b5c3h")!, { target: null, date: null }, "t", null).url).toBe(
      "http://api/api/v1/schemavisaren/K7QM2-X9DRT-4V8WN-B5C3H",
    );
  });

  it("answers one not-found for the 404 and for a session that is not staff's", async () => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    const week = { kind: "STUDENT", title: "", school: "S", week: { from: "2026-10-12", to: "2026-10-18", isoWeek: "2026-W42" }, days: [] };
    await expect(readStaffViewerResponse(json(200, week))).resolves.toEqual({ kind: "document", document: week });
    for (const status of [401, 403, 404]) {
      await expect(readStaffViewerResponse(json(status, { status }))).resolves.toEqual({ kind: "notFound" });
    }
    await expect(readStaffViewerResponse(json(429, {}))).resolves.toEqual({ kind: "busy" });
    await expect(readStaffViewerResponse(json(500, {}))).resolves.toEqual({ kind: "unavailable" });
  });
});

const day = (date: string, lessons: PublicDay["lessons"] = [], meals?: PublicDay["meals"]): PublicDay => ({
  date,
  lessons,
  ...(meals ? { meals } : {}),
});

describe("the printed week", () => {
  it("spans whole hours around the week's lessons and meals, never narrower than 08–16", () => {
    expect(weekSpan([])).toEqual({ start: 480, end: 960 });
    expect(weekSpan([day("2026-10-12", [{ start: "07:40", end: "08:30" }], [{ start: "11:00", end: "11:30" }]), day("2026-10-13", [{ start: "15:10", end: "16:20" }])])).toEqual({
      start: 420,
      end: 1020,
    });
  });

  it("draws Monday to Friday, and a weekend day only when something is on it", () => {
    const week = ["12", "13", "14", "15", "16", "17", "18"].map((d) => day(`2026-10-${d}`));
    expect(shownDays(week)).toHaveLength(5);
    week[5] = day("2026-10-17", [{ start: "09:00", end: "10:00" }]);
    expect(shownDays(week).map((d) => d.date)).toEqual(["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17"]);
  });

  it("places a lesson in percent of the span, and puts overlapping lessons side by side as the timetable does", () => {
    expect(placement({ start: "09:00", end: "10:00" }, { start: 480, end: 960 })).toEqual({ top: 12.5, height: 12.5 });
    const lanes = layoutDay(timed([{ start: "08:00", end: "09:00" }, { start: "08:30", end: "09:30" }, { start: "10:00", end: "11:00" }]));
    expect(lanes.map((lesson) => [lesson.start, lesson.lane, lesson.laneCount])).toEqual([
      ["08:00", 0, 2],
      ["08:30", 1, 2],
      ["10:00", 0, 2],
    ]);
  });

  it("links within the viewer by week, target and language, Swedish being the default", () => {
    expect(shiftWeek("2026-12-28", 1)).toBe("2027-01-04");
    expect(shiftWeek("2026-10-12", -1)).toBe("2026-10-05");
    expect(viewerHref(TOKEN, { target: UUID, date: "2026-10-19", lang: "sv" })).toBe(`/v/${TOKEN}?target=${UUID}&date=2026-10-19`);
    expect(viewerHref(TOKEN, { lang: "en" })).toBe(`/v/${TOKEN}?lang=en`);
  });
});

describe("the viewer's way back", () => {
  it("offers last week from this week, and nothing further back", () => {
    // Wednesday 14 October 2026: this week is the 12th, last week the 5th.
    expect(canGoBack("2026-10-12", "2026-10-14")).toBe(true);
    expect(canGoBack("2026-10-05", "2026-10-14")).toBe(false);
    expect(canGoBack("2026-10-19", "2026-10-14")).toBe(true);
    // On the Sunday and the Monday the week turns with them.
    expect(canGoBack("2026-10-12", "2026-10-18")).toBe(true);
    expect(canGoBack("2026-10-12", "2026-10-19")).toBe(false);
  });
});

