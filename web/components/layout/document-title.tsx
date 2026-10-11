"use client";

import { useEffect } from "react";

/** The brand half of every tab title; the same template as [locale]/layout.tsx's metadata. */
export const APP_TITLE = "SchemaPro";

/** "Timplan · SchemaPro": the page's own name first, so a row of tabs tells them apart. */
export function documentTitleOf(title: string): string {
  const trimmed = title.trim();
  return trimmed ? `${trimmed} · ${APP_TITLE}` : APP_TITLE;
}

/**
 * Names the browser tab after the page (WCAG 2.4.2 Page Titled). Every
 * (app) route was titled "SchemaPro" alone: the root layout's template only
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
    document.title = documentTitleOf(title);
    return () => {
      document.title = previous;
    };
  }, [title]);
  return null;
}
