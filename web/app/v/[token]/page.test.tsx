import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sv from "@/messages/sv.json";
import PublicTimetablePage from "./page";

/**
 * Schemavisaren's page, rendered from what the gateway answers.
 *
 * The gateway's whitelist (app.public_timetable) decides what a document can
 * hold, and its e2e and RLS rows prove the payload; these rows prove the
 * PAGE adds nothing to it and loses nothing of it: it renders only the
 * fields it knows — a key the document should never carry (a pupil, a note)
 * is never printed — a group too small to name reads "Grupp", a room's
 * lesson for named pupils reads "Upptagen", a teacher's week has no
 * "Inställd", and the request carries no cookie and no cache.
 */

const nav = vi.hoisted(() => ({ notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }) }));
vi.mock("next/navigation", () => ({ notFound: nav.notFound }));
const forwarded = vi.hoisted(() => ({ value: "6.6.6.6, 203.0.113.9" as string | null }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(forwarded.value ? { "x-forwarded-for": forwarded.value } : {}),
}));

const TOKEN = "Tok_en-".padEnd(43, "x");
const fetchMock = vi.fn();

const WEEK = {
  kind: "GROUP",
  title: "7A",
  school: "Skolan i Exempelby",
  week: { from: "2026-10-12", to: "2026-10-18", isoWeek: "2026-W42" },
  days: [
    {
      date: "2026-10-12",
      lessons: [
        { start: "08:00", end: "08:50", subject: "Matematik", groups: ["7A"], room: "Sal 12", teachers: ["AB"], cancelled: false },
        // Samläsning with a group too small to name, and a lesson cancelled for a friluftsdag.
        { start: "09:00", end: "09:50", subject: "Svenska", groups: ["7A", null], room: null, teachers: [], cancelled: true },
        // A key the whitelist never sends; the page must not print it either.
        { start: "10:00", end: "10:50", subject: "Engelska", groups: ["7A"], room: "Sal 3", teachers: [], cancelled: false, students: ["Ahmed Ali"], note: "Inställd: sjuk" },
      ],
      meals: [{ start: "11:00", end: "11:30" }],
    },
    ...["13", "14", "15", "16", "17", "18"].map((d) => ({ date: `2026-10-${d}`, lessons: [] })),
  ],
};

const respond = (status: number, body: unknown) =>
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));

async function renderPage(search: Record<string, string> = {}, token = TOKEN) {
  const element = await PublicTimetablePage({
    params: Promise.resolve({ token }),
    searchParams: Promise.resolve(search),
  });
  return render(element);
}

describe("/v/[token]", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    nav.notFound.mockClear();
    forwarded.value = "6.6.6.6, 203.0.113.9";
    vi.stubEnv("PUBLIC_VIEWER_PROXY_KEY", "k".repeat(40));
    vi.stubEnv("PUBLIC_VIEWER_API_BASE_URL", "http://gateway.internal");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("asks the gateway with no cache, forwarding only the edge's address beside the proxy key", async () => {
    respond(200, WEEK);
    await renderPage({ date: "2026-10-12", target: "not-a-uuid" });
    expect(fetchMock).toHaveBeenCalledWith(`http://gateway.internal/public/v1/timetables/${TOKEN}?date=2026-10-12`, {
      cache: "no-store",
      headers: { Accept: "application/json", "X-Viewer-Proxy-Key": "k".repeat(40), "X-Viewer-Client-Ip": "203.0.113.9" },
    });
  });

  it("prints the week from the fields it knows, and nothing the document should not have held", async () => {
    respond(200, WEEK);
    const { container } = await renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "7A" })).toBeInTheDocument();
    expect(screen.getByText("Vecka 42 · 12 okt. – 18 okt.", { exact: false })).toBeInTheDocument();
    // Twice each: the phone's list and the wide screen's (and paper's) grid.
    expect(screen.getAllByText("Matematik")).toHaveLength(2);
    expect(screen.getAllByText("7A · Sal 12 · AB")).toHaveLength(2);
    // The small group is "Grupp"; the cancelled lesson says so, struck through.
    expect(screen.getAllByText("7A, Grupp")).toHaveLength(2);
    expect(screen.getAllByText("· Inställd", { exact: false })).toHaveLength(2);
    for (const svenska of screen.getAllByText("Svenska")) expect(svenska).toHaveClass("line-through");
    expect(screen.getByText("Lunch 11:00–11:30")).toBeInTheDocument();
    // Only Monday to Friday, in both: the weekend is empty.
    const weekdays = ["Måndag 12 okt.", "Tisdag 13 okt.", "Onsdag 14 okt.", "Torsdag 15 okt.", "Fredag 16 okt."];
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([...weekdays, ...weekdays]);
    expect(container.textContent).not.toContain("Ahmed");
    expect(container.textContent).not.toContain("sjuk");
    // The week moves by Monday, and the language by a link.
    expect(screen.getByRole("link", { name: /Nästa vecka/ })).toHaveAttribute("href", `/v/${TOKEN}?date=2026-10-19`);
    expect(screen.getByRole("link", { name: "In English" })).toHaveAttribute("href", `/v/${TOKEN}?lang=en`);
  });

  it("shows a room's lesson for named pupils as busy, and a teacher's week without cancellations", async () => {
    respond(200, {
      ...WEEK,
      kind: "ROOM",
      title: "Sal 12",
      days: [{ date: "2026-10-12", lessons: [{ start: "13:00", end: "13:40", busy: true }] }, ...WEEK.days.slice(1)],
    });
    await renderPage();
    expect(screen.getAllByText("Upptagen")).toHaveLength(2);

    respond(200, {
      ...WEEK,
      kind: "TEACHER",
      title: "AB",
      days: [{ date: "2026-10-12", lessons: [{ start: "08:00", end: "08:50", subject: "Matematik", groups: ["7A"], room: "Sal 12", teachers: ["AB"] }] }, ...WEEK.days.slice(1)],
    });
    const { container } = await renderPage();
    expect(container.textContent).not.toContain("Inställd");
  });

  it("lists an index's classes as links on the same token, in English when asked", async () => {
    respond(200, { kind: "GROUP", school: "Skolan", targets: [{ id: "0b9d6a5e-3c1f-4a7b-9d2e-5f6a7b8c9d0e", label: "7A" }] });
    await renderPage({ lang: "en" });
    expect(screen.getByRole("heading", { name: "Classes and groups" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "7A" })).toHaveAttribute(
      "href",
      `/v/${TOKEN}?target=0b9d6a5e-3c1f-4a7b-9d2e-5f6a7b8c9d0e&lang=en`,
    );
  });

  it("answers one not-found for a malformed token without asking, and for the gateway's 404", async () => {
    await expect(renderPage({}, "short")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(fetchMock).not.toHaveBeenCalled();
    respond(404, { status: 404 });
    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("says a rate limit and an unreachable gateway in words", async () => {
    respond(429, {});
    await renderPage();
    expect(screen.getByRole("heading", { name: sv.publicViewer.busyTitle })).toBeInTheDocument();
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await renderPage();
    expect(screen.getByRole("heading", { name: sv.publicViewer.unavailableTitle })).toBeInTheDocument();
  });
});
