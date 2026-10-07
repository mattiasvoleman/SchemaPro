import { RolloverWizard } from "./rollover-wizard";

/**
 * /admin/years/rollover?from=<läsår>: the rollover wizard for one source year.
 *
 * A server component for one reason: it reads `from` off the request and
 * hands it down, so the wizard never calls useSearchParams — which would need
 * a Suspense boundary of its own to prerender, and gives nothing here a
 * prop does not. Everything else is the client wizard beside it.
 */
export default async function RolloverPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string | string[] }>;
}) {
  const { from } = await searchParams;
  return <RolloverWizard sourceYearId={typeof from === "string" && from !== "" ? from : null} />;
}
