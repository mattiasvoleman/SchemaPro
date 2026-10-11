/**
 * The tabs of /admin/reports, in a module without "use client".
 *
 * page.tsx is a server component and reads ?tab= with reportTabOf; a function
 * exported from the client module reports-tabs.tsx reaches the server as a
 * client reference, and calling it there threw "Attempted to call
 * reportTabOf() from the server" — a 500 on every load of Rapporter.
 */

export type ReportTab = "attendance" | "staffing" | "cover";

/** A `?tab=` value as a tab; anything unknown is Närvaro. */
export function reportTabOf(value: string | null | undefined): ReportTab {
  return value === "staffing" || value === "cover" ? value : "attendance";
}
