import type { Metadata } from "next";
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
  title: "Schema",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function ViewerLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="sv">
      <body className="min-h-screen bg-white font-sans text-neutral-900 antialiased">{children}</body>
    </html>
  );
}
