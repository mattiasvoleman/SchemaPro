import type { Metadata } from "next";
import { headers } from "next/headers";
import "../globals.css";

/*
 * Schemavisaren's own root layout: no Providers, no theme, no session, no
 * script of ours. The page under it is a server component that prints a
 * week; everything the browser downloads is Next's runtime.
 *
 * Kept out of app/[locale] on purpose: that tree's proxy refreshes the
 * Supabase session (cookies) and redirects anyone without one to /login.
 * proxy.ts returns before both for /v/.
 *
 * noindex, nofollow and no-referrer here as meta tags, and as headers from
 * proxy.ts: a share link is unguessable only while it is not in a search
 * engine, or in the Referer of a link someone follows off the page. There is
 * deliberately no robots.txt Disallow for /v/ — a crawler that is told not to
 * fetch the page never sees the noindex either.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

/*
 * The page's title is the page's own (<title> in app/v/[token]: "7A – Vecka
 * 42"), hoisted by React; a layout title would sit beside it. The document's
 * language is the one ?lang= asked for: proxy.ts passes it as x-viewer-lang,
 * since a layout is not given the search params.
 */
export default async function ViewerLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const lang = (await headers()).get("x-viewer-lang") === "en" ? "en" : "sv";
  return (
    <html lang={lang}>
      <body className="min-h-screen bg-white font-sans text-neutral-900 antialiased">{children}</body>
    </html>
  );
}
