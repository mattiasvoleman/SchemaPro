import { cookies } from "next/headers";
import { getLocale, getTranslations } from "next-intl/server";
import { ArrowRight, CalendarDays, GraduationCap, Sparkles, Target } from "lucide-react";
import { createClient } from "@/utils/supabase/server";
import { getSession } from "@/lib/auth";
import { serverApiGet } from "@/lib/server-api";
import { toDateString } from "@/lib/utils";
import { Link } from "@/i18n/navigation";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { KpiStrip, KpiTile } from "@/components/ui/kpi";
import { LoadError } from "@/components/ui/load-error";

export const dynamic = "force-dynamic";

/** GET /api/v1/users/counts: every Users row of the school, active or not. */
interface UserCounts {
  byRole: Record<"STUDENT" | "TEACHER" | "GUARDIAN" | "SCHOOL_ADMIN", number>;
}

/** GET /api/v1/attendance/summary: records since a day; present is PRESENT or LATE. */
interface AttendanceSummary {
  recorded: number;
  present: number;
}

export default async function AdminDashboardPage() {
  const t = await getTranslations("dashboard");
  const locale = await getLocale();
  const session = await getSession();
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);

  const today = toDateString(new Date());
  const weekAgo = toDateString(new Date(Date.now() - 7 * 86_400_000));

  // People and attendance are counted by the gateway, not PostgREST: since
  // the läslogg an admin's PostgREST reads no other person's Users or
  // AttendanceRecords row, and a count is all the dashboard needs of them.
  // The tables the läslogg does not cover are still counted here.
  const accessToken = (await supabase.auth.getSession()).data.session?.access_token;

  const head = { count: "exact" as const, head: true };
  const [
    people,
    groups,
    rooms,
    lessonsToday,
    masterLessons,
    requirements,
    attendance,
  ] = await Promise.all([
    serverApiGet<UserCounts>("/api/v1/users/counts", accessToken),
    supabase.from("StudentGroups").select("id", head),
    supabase.from("Rooms").select("id", head),
    supabase.from("CalendarLessons").select("id", head).eq("date", today),
    supabase.from("MasterLessons").select("id", head),
    supabase.from("TeachingRequirements").select("id", head),
    serverApiGet<AttendanceSummary>(
      `/api/v1/attendance/summary?since=${encodeURIComponent(weekAgo)}`,
      accessToken,
    ),
  ]);

  // A count that failed is no figure at all, never a 0: "0 elever" on a
  // school of 400 reads as data that is gone, and the admin acts on it. The
  // tile then shows "—" and the notice above the strip says why.
  const number = new Intl.NumberFormat(locale);
  const countOf = (result: { count: number | null; error: unknown }) =>
    result.error || result.count === null ? null : number.format(result.count);
  // An answer without the role's figure is as much a failure as no answer.
  const byRole = "data" in people ? people.data?.byRole : undefined;
  const roleCount = (role: keyof UserCounts["byRole"]) => {
    const count = byRole?.[role];
    return typeof count === "number" ? number.format(count) : null;
  };
  const students = roleCount("STUDENT");
  const teachers = roleCount("TEACHER");

  // No records in the week is no rate, but no failure either; an answer
  // without its two figures is one.
  const summary = "data" in attendance ? attendance.data : null;
  const recorded = summary?.recorded;
  const present = summary?.present;
  const attendanceFailed = typeof recorded !== "number" || typeof present !== "number";
  const attendanceRate =
    !attendanceFailed && recorded > 0
      ? new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(
          present / recorded,
        )
      : null;

  const kpis = [
    { label: t("students"), value: students },
    { label: t("teachers"), value: teachers },
    { label: t("groups"), value: countOf(groups) },
    { label: t("rooms"), value: countOf(rooms) },
    { label: t("lessonsToday"), value: countOf(lessonsToday) },
    { label: t("attendanceRate"), value: attendanceRate },
    { label: t("requirements"), value: countOf(requirements) },
    { label: t("masterLessons"), value: countOf(masterLessons) },
  ];
  const anyFailed =
    students === null ||
    teachers === null ||
    attendanceFailed ||
    [groups, rooms, lessonsToday, masterLessons, requirements].some((result) => result.error);

  // The manual's chain in the nav's order: Kom igång, the timplan, the
  // generator, and the review that publishes.
  const actions = [
    {
      title: t("actionSetup"),
      hint: t("actionSetupHint"),
      href: "/admin/setup",
      icon: GraduationCap,
    },
    {
      title: t("actionTimplan"),
      hint: t("actionTimplanHint"),
      href: "/admin/timplan",
      icon: Target,
    },
    {
      title: t("actionGenerate"),
      hint: t("actionGenerateHint"),
      href: "/admin/generate",
      icon: Sparkles,
    },
    {
      title: t("actionPublish"),
      hint: t("actionPublishHint"),
      href: "/admin/timetable",
      icon: CalendarDays,
    },
  ];

  return (
    <Page>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle", { school: session?.school?.name ?? "" })}
      />

      {anyFailed ? (
        <LoadError variant="inline" title={t("loadFailed")} hint={t("loadFailedHint")} />
      ) : null}

      <KpiStrip>
        {kpis.map((kpi) => (
          <KpiTile key={kpi.label} label={kpi.label} value={kpi.value} />
        ))}
      </KpiStrip>

      <section aria-labelledby="dashboard-quick-actions" className="space-y-3">
        <h2 id="dashboard-quick-actions" className="text-base font-semibold">
          {t("quickActions")}
        </h2>
        {/* An ordered list: the four are the steps of one chain, and a screen
            reader hears the position the tile's number draws. */}
        <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {actions.map((action, index) => (
            <li key={action.href}>
              <Link
                href={action.href}
                className="group block h-full rounded-lg ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                {/* Link tiles are the one place the Card family stays (the brief's
                    card dialect): the whole tile is the link, not a section. */}
                <Card className="h-full transition-colors group-hover:border-primary/50">
                  <CardContent className="p-5">
                    <div className="flex items-center justify-between">
                      <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10">
                        <action.icon className="size-5 text-primary" aria-hidden="true" />
                      </div>
                      <span
                        className="text-xs font-semibold tabular-nums text-muted-foreground"
                        aria-hidden="true"
                      >
                        {index + 1}
                      </span>
                    </div>
                    <div className="mt-3 flex items-center gap-1.5 font-medium">
                      {action.title}
                      <ArrowRight
                        className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
                        aria-hidden="true"
                      />
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{action.hint}</p>
                  </CardContent>
                </Card>
              </Link>
            </li>
          ))}
        </ol>
      </section>
    </Page>
  );
}
