import { ClassBookPage } from "@/components/lesson-log/class-book-page";
import { classBookPeriod } from "@/lib/lesson-log";

/**
 * /teacher/klassbok?group=&from=&to=: a class's lessons over a period with
 * their topic and homework, for every teacher (components/lesson-log/
 * class-book-page.tsx). A server component only to hand the query down
 * without useSearchParams, as the uppdragsbeskrivning does.
 */
export default async function TeacherClassBookPage({
  searchParams,
}: {
  searchParams: Promise<{ group?: string | string[]; from?: string | string[]; to?: string | string[] }>;
}) {
  const { group, from, to } = await searchParams;
  const one = (value: string | string[] | undefined) => (typeof value === "string" && value !== "" ? value : null);
  const period = classBookPeriod(one(from), one(to));
  return <ClassBookPage audience="teacher" initialGroupId={one(group)} initialFrom={period.from} initialTo={period.to} />;
}
