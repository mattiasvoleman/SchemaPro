import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import {
  BookOpen,
  CalendarDays,
  ClipboardCheck,
  Grid3x3,
  MapPin,
  Sparkles,
  Users,
  UserCheck,
  GraduationCap,
  ArrowRight,
} from "lucide-react";
import { createClient } from "@/utils/supabase/server";
import { getSession } from "@/lib/auth";
import { toDateString } from "@/lib/utils";
import { Link } from "@/i18n/navigation";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function AdminDashboardPage() {
  const t = await getTranslations("dashboard");
  const session = await getSession();
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);

  const today = toDateString(new Date());
  const weekAgo = toDateString(new Date(Date.now() - 7 * 86_400_000));

  const head = { count: "exact" as const, head: true };
  const [
    { count: students },
    { count: teachers },
    { count: groups },
    { count: rooms },
    { count: lessonsToday },
    { count: masterLessons },
    { count: requirements },
    attendance,
  ] = await Promise.all([
    supabase.from("Users").select("id", head).eq("role", "STUDENT"),
    supabase.from("Users").select("id", head).eq("role", "TEACHER"),
    supabase.from("StudentGroups").select("id", head),
    supabase.from("Rooms").select("id", head),
    supabase.from("CalendarLessons").select("id", head).eq("date", today),
    supabase.from("MasterLessons").select("id", head),
    supabase.from("TeachingRequirements").select("id", head),
    supabase
      .from("AttendanceRecords")
      .select("status")
      .gte("recordedAt", `${weekAgo}T00:00:00Z`)
      .limit(5000),
  ]);

  const attendanceRows = (attendance.data ?? []) as Array<{ status: string }>;
  const present = attendanceRows.filter(
    (row) => row.status === "PRESENT" || row.status === "LATE",
  ).length;
  const attendanceRate =
    attendanceRows.length > 0 ? Math.round((present / attendanceRows.length) * 100) : null;

  const kpis = [
    { label: t("students"), value: students ?? 0, icon: Users },
    { label: t("teachers"), value: teachers ?? 0, icon: UserCheck },
    { label: t("groups"), value: groups ?? 0, icon: GraduationCap },
    { label: t("rooms"), value: rooms ?? 0, icon: MapPin },
    { label: t("lessonsToday"), value: lessonsToday ?? 0, icon: CalendarDays },
    {
      label: t("attendanceRate"),
      value: attendanceRate !== null ? `${attendanceRate}%` : "—",
      icon: ClipboardCheck,
    },
    { label: t("requirements"), value: requirements ?? 0, icon: Grid3x3 },
    { label: t("masterLessons"), value: masterLessons ?? 0, icon: BookOpen },
  ];

  const actions = [
    {
      title: t("actionSetup"),
      hint: t("actionSetupHint"),
      href: "/admin/setup",
      icon: GraduationCap,
    },
    {
      title: t("actionRequirements"),
      hint: t("actionRequirementsHint"),
      href: "/admin/requirements",
      icon: Grid3x3,
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
    <div>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle", { school: session?.school?.name ?? "" })}
      />

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {kpis.map((kpi) => (
          <Card key={kpi.label}>
            <CardContent className="flex items-center gap-3 p-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                <kpi.icon className="h-5 w-5 text-primary" />
              </div>
              <div className="min-w-0">
                <div className="truncate text-xs text-muted-foreground">{kpi.label}</div>
                <div className="text-xl font-semibold tabular-nums">{kpi.value}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <h2 className="mb-3 mt-8 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        {t("quickActions")}
      </h2>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {actions.map((action, index) => (
          <Link key={action.href} href={action.href} className="group">
            <Card className="h-full transition-colors group-hover:border-primary/50">
              <CardContent className="p-5">
                <div className="flex items-center justify-between">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
                    <action.icon className="h-5 w-5 text-primary" />
                  </div>
                  <span className="text-xs font-semibold text-muted-foreground">
                    {index + 1}
                  </span>
                </div>
                <div className="mt-3 flex items-center gap-1.5 font-medium">
                  {action.title}
                  <ArrowRight className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100" />
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{action.hint}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
