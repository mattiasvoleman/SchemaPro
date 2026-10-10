import { CoverBoard } from "./cover-board";

/**
 * /admin/cover?date=YYYY-MM-DD&view=day|week — Vikarietavla.
 *
 * A server component for the reason /admin/reports gives: it reads the query
 * off the request and hands it down, so the client board never calls
 * useSearchParams (which under Next 16 needs a Suspense boundary of its own to
 * prerender). The register's "Vikarietavlan" link opens an absence's day here.
 */
export default async function CoverBoardPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string | string[]; view?: string | string[] }>;
}) {
  const { date, view } = await searchParams;
  const initialDate = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  return <CoverBoard initialDate={initialDate} initialView={view === "week" ? "week" : "day"} />;
}
