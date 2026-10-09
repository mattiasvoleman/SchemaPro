import { MyUppdragsbeskrivning } from "./my-uppdragsbeskrivning";

/**
 * /teacher/tjanst/uppdragsbeskrivning?year=<id>: the teacher's OWN printable
 * uppdragsbeskrivning, from Min tjänst.
 *
 * It takes a year and never a person: whose tjänst it prints is the session's
 * (the gateway answers a TEACHER's load and uppdrag with their own rows only,
 * and RLS holds the same line), so there is no parameter to change to read a
 * colleague's. A server component only to hand `year` down without
 * useSearchParams (see the admin route).
 */
export default async function MyUppdragsbeskrivningPage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string | string[] }>;
}) {
  const { year } = await searchParams;
  return <MyUppdragsbeskrivning yearId={typeof year === "string" && year !== "" ? year : null} />;
}
