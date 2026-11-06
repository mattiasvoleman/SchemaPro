import { CrisisPage } from "./crisis-page";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * /admin/crisis?alarm=<id> — Krisläge.
 *
 * A server component for the reason /admin/cover gives: it reads the query off
 * the request and hands it down, so the client page never calls
 * useSearchParams (which under Next 16 needs a Suspense boundary of its own to
 * prerender). `alarm` is the alarm the live view opens on: the link a refused
 * start (409 CRISIS_ALARM_OPEN) gives to the alarm that is already going.
 */
export default async function CrisisRoute({
  searchParams,
}: {
  searchParams: Promise<{ alarm?: string | string[] }>;
}) {
  const { alarm } = await searchParams;
  return <CrisisPage initialAlarmId={typeof alarm === "string" && UUID.test(alarm) ? alarm.toLowerCase() : null} />;
}
