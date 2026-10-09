import { AdminUppdragsbeskrivning } from "./admin-uppdragsbeskrivning";

/**
 * /admin/staffing/uppdragsbeskrivning?teacher=<id>&year=<id>: one teacher's
 * printable uppdragsbeskrivning, opened from the staffing drawer.
 *
 * A server component for the reason /admin/years/rollover is one: it reads
 * the two parameters off the request and hands them down, so the client page
 * never calls useSearchParams — which would need a Suspense boundary of its
 * own to prerender (C19). Admin-only by its place: /admin's layout lets no
 * other role in, and the gateway answers the load and the uppdrag of the
 * whole school only to an admin.
 */
export default async function AdminUppdragsbeskrivningPage({
  searchParams,
}: {
  searchParams: Promise<{ teacher?: string | string[]; year?: string | string[] }>;
}) {
  const { teacher, year } = await searchParams;
  const one = (value: string | string[] | undefined) =>
    typeof value === "string" && value !== "" ? value : null;
  return <AdminUppdragsbeskrivning teacherId={one(teacher)} yearId={one(year)} />;
}
