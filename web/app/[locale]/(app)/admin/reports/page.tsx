import { ReportsTabs, type ReportTab } from "./reports-tabs";

/**
 * /admin/reports?tab=närvaro|tjanstefordelning — Närvaro and, since staffing
 * Fas 3, Tjänstefördelning.
 *
 * A server component for one reason, the one /admin/years/rollover gives: it
 * reads `tab` off the request and hands it down, so the client shell never
 * calls useSearchParams — which under Next 16 needs a Suspense boundary of its
 * own to prerender, and a bailout without one fails the build (C19). The
 * shell keeps the choice in state and writes it back to the URL.
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const { tab } = await searchParams;
  const initial: ReportTab = tab === "staffing" ? "staffing" : "attendance";
  return <ReportsTabs initialTab={initial} />;
}
