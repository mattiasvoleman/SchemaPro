"use client";

import { useEffect } from "react";

/**
 * The brand half of every tab title, per language: the product's names since
 * 2026-10-17. The same as the messages' common.appName (a test keeps them
 * equal), which [locale]/layout.tsx's metadata template reads.
 */
export const APP_TITLES = { sv: "Rastra Schema", en: "Rastra timetable" } as const;

/** The app's name for the page's language, <html lang> as [locale]/layout.tsx sets it. */
export function appTitleFor(lang: string | null | undefined): string {
  return lang === "en" ? APP_TITLES.en : APP_TITLES.sv;
}

/** "Timplan · Rastra Schema": the page's own name first, so a row of tabs tells them apart. */
export function documentTitleOf(title: string, appTitle: string = APP_TITLES.sv): string {
  const trimmed = title.trim();
  return trimmed ? `${trimmed} · ${appTitle}` : appTitle;
}

/**
 * Names the browser tab after the page (WCAG 2.4.2 Page Titled), in the
 * page's language. Every (app) route was titled with the app's name alone:
 * the root layout's template only
 * applies to a route that exports metadata, and most pages are client
 * components that cannot. PageHeader renders this beside its h1, so the tab
 * and the heading always say the same thing, and PageHeader itself stays a
 * server-safe component.
 *
 * On unmount the title goes back to what it was, so a route without a
 * PageHeader never keeps the previous page's name.
 */
export function DocumentTitle({ title }: { title: string }) {
  useEffect(() => {
    const previous = document.title;
    document.title = documentTitleOf(title, appTitleFor(document.documentElement.lang));
    return () => {
      document.title = previous;
    };
  }, [title]);
  return null;
}
