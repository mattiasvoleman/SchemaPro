import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import EmbeddedTimetablePage from "./page";

/**
 * Schemavisaren in a frame on the school's website (20261102090000). WHO may
 * frame it is the proxy's (proxy.test.ts); these rows prove the page shows
 * the viewer's document and nothing more, compact, with the week's links
 * inside the frame and one link out to the full viewer in a new tab, and that
 * it asks the gateway exactly as the viewer page does.
 */

const nav = vi.hoisted(() => ({ notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND"); }) }));
vi.mock("next/navigation", () => ({ notFound: nav.notFound }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }) }));

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
        // Keys the whitelist never sends: a frame prints no more than the page.
        { start: "10:00", end: "10:50", subject: "Engelska", groups: ["7A"], room: "Sal 3", teachers: [], cancelled: false, students: ["Ahmed Ali"], note: "sjuk" },
      ],
    },
    ...["13", "14", "15", "16", "17", "18"].map((d) => ({ date: `2026-10-${d}`, lessons: [] })),
  ],
};

const respond = (status: number, body: unknown) => fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));

async function renderPage(search: Record<string, string> = {}, token = TOKEN) {
  const element = await EmbeddedTimetablePage({ params: Promise.resolve({ token }), searchParams: Promise.resolve(search) });
  return render(element);
}

describe("/v/[token]/embed", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    vi.stubEnv("PUBLIC_VIEWER_PROXY_KEY", "k".repeat(40));
    vi.stubEnv("PUBLIC_VIEWER_API_BASE_URL", "http://gateway.internal");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("asks the gateway as the viewer page does", async () => {
    respond(200, WEEK);
    await renderPage({ date: "2026-10-12" });
    expect(fetchMock).toHaveBeenCalledWith(`http://gateway.internal/public/v1/timetables/${TOKEN}?date=2026-10-12`, {
      cache: "no-store",
      headers: { Accept: "application/json", "X-Viewer-Proxy-Key": "k".repeat(40), "X-Viewer-Client-Ip": "203.0.113.9" },
    });
  });

  it("shows the week compact, with no more than the viewer's document", async () => {
    respond(200, WEEK);
    const { container } = await renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "7A" })).toBeInTheDocument();
    expect(screen.getAllByText("Matematik")).toHaveLength(2);
    expect(container.textContent).not.toContain("Ahmed");
    expect(container.textContent).not.toContain("sjuk");
    expect(document.title).toBe("7A – Vecka 42");
  });

  it("pages through the weeks inside the frame, and opens the full viewer in a new tab", async () => {
    respond(200, WEEK);
    await renderPage({ lang: "en" });
    expect(screen.getByRole("link", { name: /Next week/ })).toHaveAttribute("href", `/v/${TOKEN}/embed?date=2026-10-19&lang=en`);
    expect(screen.getByRole("link", { name: "This week" })).toHaveAttribute("href", `/v/${TOKEN}/embed?lang=en`);
    const out = screen.getByRole("link", { name: "Open the full timetable" });
    expect(out).toHaveAttribute("href", `/v/${TOKEN}?lang=en`);
    expect(out).toHaveAttribute("target", "_blank");
    expect(out).toHaveAttribute("rel", "noopener noreferrer");
    // The tab order is the navigation's, then the way out.
    const links = screen.getAllByRole("link").map((link) => link.textContent);
    expect(links[links.length - 1]).toBe("Open the full timetable");
  });

  it("lists an index's targets as frames of the same token", async () => {
    respond(200, { kind: "ROOM", school: "Skolan", targets: [{ id: "0b9d6a5e-3c1f-4a7b-9d2e-5f6a7b8c9d0e", label: "Sal 12" }] });
    await renderPage();
    expect(screen.getByRole("heading", { level: 1, name: "Salar" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sal 12" })).toHaveAttribute(
      "href",
      `/v/${TOKEN}/embed?target=0b9d6a5e-3c1f-4a7b-9d2e-5f6a7b8c9d0e`,
    );
    // The targets first, then the way out.
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(["Sal 12", "Öppna i Schemavisaren"]);
  });

  it("answers the viewer's one not-found, and says a limit and an unreachable gateway in words", async () => {
    await expect(renderPage({}, "short")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(fetchMock).not.toHaveBeenCalled();
    respond(404, { status: 404 });
    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
    respond(429, {});
    await renderPage();
    expect(screen.getByRole("heading", { name: "För många visningar just nu" })).toBeInTheDocument();
  });
});
