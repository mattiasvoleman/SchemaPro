import { ClassBookPage } from "@/components/lesson-log/class-book-page";
import { classBookPeriod } from "@/lib/lesson-log";

/**
 * /admin/klassbok?group=&from=&to=: the klassbok for every administrator,
 * with the removal of a log for the one who writes drift
 * (components/lesson-log/class-book-page.tsx). A server component only to
 * hand the query down without useSearchParams.
 */
export default async function AdminClassBookPage({
  searchParams,
}: {
  searchParams: Promise<{ group?: string | string[]; from?: string | string[]; to?: string | string[] }>;
}) {
  const { group, from, to } = await searchParams;
  const one = (value: string | string[] | undefined) => (typeof value === "string" && value !== "" ? value : null);
  const period = classBookPeriod(one(from), one(to));
  return <ClassBookPage audience="admin" initialGroupId={one(group)} initialFrom={period.from} initialTo={period.to} />;
}
