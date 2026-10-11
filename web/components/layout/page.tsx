import { cn } from "@/lib/utils";

/**
 * The three page widths of the app. Work and data pages (tables, matrices,
 * boards) take the whole column; wizards and settings pages are held to
 * max-w-5xl; personal reading pages and print documents to max-w-3xl.
 *
 * A capped page keeps to the left edge of the column, not centred: centring
 * moved the h1 sideways from page to page as the nav went from Timplan (full)
 * to Läsår (wide), so the eye had to find the title again on every click. Left
 * aligned, every h1 starts at the same x as on the full-width pages, and the
 * cap only shortens the line.
 */
export type PageWidth = "full" | "wide" | "narrow";

const WIDTH_CLASS: Record<PageWidth, string> = {
  full: "",
  wide: "max-w-5xl",
  narrow: "max-w-3xl",
};

export interface PageProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Defaults to full. Render the loading, empty and error branches inside the same width. */
  width?: PageWidth;
}

/**
 * The root of every in-app page: one vertical rhythm (space-y-4) for the
 * header, tabs, filter bar and sections under it, so no block carries a top or
 * bottom margin of its own. Server-safe: no hooks, no "use client".
 */
export function Page({ width = "full", className, ...props }: PageProps) {
  return <div className={cn("space-y-4", WIDTH_CLASS[width], className)} {...props} />;
}
