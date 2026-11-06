import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import CodeEntryPage from "./page";

/**
 * Where a code is typed (/v): a plain GET form, read on the server. A code in
 * any spelling is sent on to /v/<code>; anything else is answered with one
 * sentence about how a code is written and nothing about any code.
 */

const nav = vi.hoisted(() => ({
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));
vi.mock("next/navigation", () => ({ redirect: nav.redirect }));

async function renderPage(search: Record<string, string | string[]> = {}) {
  return render(await CodeEntryPage({ searchParams: Promise.resolve(search) }));
}

describe("/v", () => {
  beforeEach(() => {
    nav.redirect.mockClear();
  });

  it("asks for a code in a plain form that sends it back to the same page, with nothing to run in the browser", async () => {
    const { container } = await renderPage();
    const form = container.querySelector("form")!;
    expect(form).toHaveAttribute("method", "get");
    expect(form).toHaveAttribute("action", "/v");
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Öppna ett schema med kod" })).toBeInTheDocument();
    const field = screen.getByLabelText("Kod");
    expect(field).toHaveAttribute("name", "code");
    expect(field).toHaveAttribute("autocomplete", "off");
    expect(field).toBeRequired();
    expect(screen.getByRole("button", { name: "Öppna schemat" })).toBeInTheDocument();
    // Nothing said before anything is typed.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(nav.redirect).not.toHaveBeenCalled();
  });

  it.each([
    ["K7QM2-X9DRT-4V8WN-B5C3H", "/v/K7QM2-X9DRT-4V8WN-B5C3H"],
    ["k7qm2x9drt4v8wnb5c3h", "/v/K7QM2-X9DRT-4V8WN-B5C3H"],
    ["  k7qm2 x9drt 4v8wn b5c3h ", "/v/K7QM2-X9DRT-4V8WN-B5C3H"],
    // I and L are read as 1, O as 0, as the gateway reads them.
    ["KIQM2-X9DRT-4V8WN-B5C3L", "/v/K1QM2-X9DRT-4V8WN-B5C31"],
    ["T".repeat(43), `/v/${"T".repeat(43)}`],
  ])("sends %j on to its link", async (typed, to) => {
    await expect(renderPage({ code: typed })).rejects.toThrow(`NEXT_REDIRECT ${to}`);
  });

  it("keeps the language it was opened in through the redirect, and in the form", async () => {
    await expect(renderPage({ code: "K7QM2-X9DRT-4V8WN-B5C3H", lang: "en" })).rejects.toThrow(
      "NEXT_REDIRECT /v/K7QM2-X9DRT-4V8WN-B5C3H?lang=en",
    );
    const { container } = await renderPage({ lang: "en" });
    expect(screen.getByRole("heading", { level: 1, name: "Open a timetable with a code" })).toBeInTheDocument();
    expect(container.querySelector('input[type="hidden"][name="lang"]')).toHaveValue("en");
    expect(screen.getByRole("link", { name: "På svenska" })).toHaveAttribute("href", "/v");
  });

  it("answers what cannot be a code with one neutral sentence, returning what was typed to be mended", async () => {
    await renderPage({ code: "K7QM2-X9DRT-4V8WN" });
    expect(nav.redirect).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Koden ser inte rätt ut. Skriv av den så som den står: fyra grupper om fem tecken.");
    const field = screen.getByLabelText("Kod");
    expect(field).toHaveValue("K7QM2-X9DRT-4V8WN");
    expect(field).toBeInvalid();
    // Described by the hint and by the sentence.
    expect(field.getAttribute("aria-describedby")).toBe("code-hint code-error");
  });

  it("takes only the first of a repeated code and ignores an empty one", async () => {
    await expect(renderPage({ code: ["k7qm2x9drt4v8wnb5c3h", "x"] })).rejects.toThrow("NEXT_REDIRECT /v/K7QM2-X9DRT-4V8WN-B5C3H");
    await renderPage({ code: "   " });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("links the other language and the accessibility statement", async () => {
    await renderPage();
    expect(screen.getByRole("link", { name: "In English" })).toHaveAttribute("href", "/v?lang=en");
    expect(screen.getByRole("link", { name: "Tillgänglighetsredogörelse" })).toHaveAttribute("href", "/sv/tillganglighet");
  });
});
