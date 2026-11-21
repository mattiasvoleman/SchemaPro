import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import en from "@/messages/en.json";
import sv from "@/messages/sv.json";
import PseudonymiseraPage, { generateMetadata } from "./page";

/**
 * /pseudonymisera, rendered as the server renders it (Pseudonymiseraren, X1): in either language, a public page with the promise stated and the
 * tool beneath it, plain links that make no request of their own, and not offered to a search engine.
 */

const state = vi.hoisted(() => ({ locale: "sv" as "sv" | "en" }));

vi.mock("next-intl/server", async () => {
  const messages = { sv: (await import("@/messages/sv.json")).default, en: (await import("@/messages/en.json")).default };
  return {
    getLocale: async () => state.locale,
    getMessages: async () => messages[state.locale],
    getTranslations: async (namespace: string) => {
      const ns = (messages[state.locale] as unknown as Record<string, Record<string, string>>)[namespace]!;
      return (key: string) => ns[key] ?? key;
    },
  };
});

afterEach(cleanup);

async function renderPage(locale: "sv" | "en") {
  state.locale = locale;
  render(await PseudonymiseraPage());
}

describe("the page", () => {
  it("says in Swedish what it does and what it promises, and has one heading", async () => {
    await renderPage("sv");
    expect(screen.getByRole("heading", { level: 1, name: sv.pseudonymiserare.title })).toBeInTheDocument();
    const promise = screen.getByRole("region", { name: sv.pseudonymiserare.promise.heading });
    expect(promise).toHaveTextContent("Filen skickas inte till Rastra");
    expect(promise).toHaveTextContent("connect-src 'none'");
    expect(promise).toHaveTextContent("Ingenting om din fil sparas");
    // The one cookie the page may set is said, not hidden.
    expect(promise).toHaveTextContent("kaka för vilket språk du valt");
    // The promise says what it cannot do too.
    expect(promise).toHaveTextContent("Det kan inte avgöra allt");
  });

  it("says it in English in English, with the other language one link away", async () => {
    await renderPage("en");
    expect(screen.getByRole("heading", { level: 1, name: en.pseudonymiserare.title })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: en.pseudonymiserare.promise.heading })).toHaveTextContent("is not sent to Rastra or anyone else");
    expect(screen.getByRole("link", { name: "Svenska" })).toHaveAttribute("href", "/sv/pseudonymisera");
  });

  it("has the tool on it, ready for a file", async () => {
    await renderPage("sv");
    expect(screen.getByLabelText(sv.pseudonymiserare.tool.chooseFiles)).toBeInTheDocument();
    expect(screen.getByLabelText(sv.pseudonymiserare.tool.pasteLabel)).toBeInTheDocument();
  });

  it("links with plain addresses in the visitor's language, which leave through a click and not through a router's prefetch", async () => {
    await renderPage("sv");
    const hrefs = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual(expect.arrayContaining(["/sv", "/sv/tillganglighet", "/en/pseudonymisera"]));
    for (const href of hrefs) expect(href, "an address on this site").toMatch(/^\//);
    // The main landmark holds the content, the footer the way out.
    const main = screen.getByRole("main");
    expect(within(main).queryAllByRole("link")).toEqual([]);
  });
});

describe("the page's metadata", () => {
  it("has a title and a description in the visitor's language, and asks not to be indexed: a tool for schools in touch with us, not a landing page", async () => {
    state.locale = "sv";
    const metadata = await generateMetadata();
    expect(metadata.title).toBe(sv.pseudonymiserare.metaTitle);
    expect(metadata.description).toBe(sv.pseudonymiserare.metaDescription);
    expect(metadata.robots).toEqual({ index: false, follow: false });
    state.locale = "en";
    expect((await generateMetadata()).title).toBe(en.pseudonymiserare.metaTitle);
  });
});
