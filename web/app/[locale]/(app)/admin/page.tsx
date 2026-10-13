import { cookies } from "next/headers";
import { getLocale, getTranslations } from "next-intl/server";
import {
  ArrowRight,
  CalendarClock,
  CalendarDays,
  ClipboardCheck,
  GraduationCap,
  Sparkles,
  Target,
  UserCheck,
  UserX,
} from "lucide-react";
import { createClient } from "@/utils/supabase/server";
import { getSession } from "@/lib/auth";
import { gateOfPath, profileOpens } from "@/lib/admin-areas";
import { toDateString } from "@/lib/utils";
import { Link } from "@/i18n/navigation";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { DashboardKpis } from "./dashboard-kpis";

export const dynamic = "force-dynamic";

export default async function AdminDashboardPage() {
  const t = await getTranslations("dashboard");
  const locale = await getLocale();
  const session = await getSession();
  const cookieStore = await cookies();
  const supabase = createClient(cookieStore);

  const today = toDateString(new Date());
  const weekAgo = toDateString(new Date(Date.now() - 7 * 86_400_000));

  // Pupils, teachers and the week's attendance are the gateway's, asked from
  // the browser (DashboardKpis says why). The tables the läslogg does not
  // cover are counted here.
  const head = { count: "exact" as const, head: true };
  const [groups, rooms, lessonsToday, masterLessons, requirements] = await Promise.all([
    supabase.from("StudentGroups").select("id", head),
    supabase.from("Rooms").select("id", head),
    supabase.from("CalendarLessons").select("id", head).eq("date", today),
    supabase.from("MasterLessons").select("id", head),
    supabase.from("TeachingRequirements").select("id", head),
  ]);

  // A count that failed is no figure at all, never a 0: "0 elever" on a
  // school of 400 reads as data that is gone, and the admin acts on it. The
  // tile then shows "—" and the notice above the strip says why.
  const number = new Intl.NumberFormat(locale);
  const countOf = (result: { count: number | null; error: unknown }) =>
    result.error || result.count === null ? null : number.format(result.count);
  const server = {
    groups: countOf(groups),
    rooms: countOf(rooms),
    lessonsToday: countOf(lessonsToday),
    requirements: countOf(requirements),
    masterLessons: countOf(masterLessons),
  };
  const serverFailed = [groups, rooms, lessonsToday, masterLessons, requirements].some((result) => result.error);

  // The manual's chain in the nav's order: Kom igång, the timplan, the
  // generator, and the review that publishes.
  const chain = [
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
  // The school day's, for a profile none of the chain is open to (Roller i
  // skolan: the expedition): absence, cover, leave and the register.
  const day = [
    { title: t("actionAbsence"), hint: t("actionAbsenceHint"), href: "/admin/teacher-absence", icon: UserX },
    { title: t("actionCover"), hint: t("actionCoverHint"), href: "/admin/cover", icon: CalendarClock },
    { title: t("actionLeave"), hint: t("actionLeaveHint"), href: "/admin/leave", icon: ClipboardCheck },
    { title: t("actionPeople"), hint: t("actionPeopleHint"), href: "/admin/people", icon: UserCheck },
  ];
  // Only the pages this profile uses: a tile to a closed page would lead to
  // the page that says so, whose way out is this overview.
  const profile = session?.profile?.adminProfile === undefined ? "FULL" : session.profile.adminProfile;
  const opens = (action: { href: string }) => profileOpens(profile, gateOfPath(action.href));
  const inChain = chain.some(opens);
  const actions = inChain ? chain.filter(opens) : day.filter(opens);
  const Tiles = inChain ? "ol" : "ul";

  return (
    <Page>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle", { school: session?.school?.name ?? "" })}
      />

      <DashboardKpis server={server} serverFailed={serverFailed} since={weekAgo} />

      <section aria-labelledby="dashboard-quick-actions" className="space-y-3">
        <h2 id="dashboard-quick-actions" className="text-base font-semibold">
          {t("quickActions")}
        </h2>
        {/* The chain's tiles are an ordered list: they are the steps of one
            chain, and a screen reader hears the position the tile's number
            draws. The school day's are not steps, and are not numbered. */}
        <Tiles className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
                      {inChain && (
                        <span
                          className="text-xs font-semibold tabular-nums text-muted-foreground"
                          aria-hidden="true"
                        >
                          {index + 1}
                        </span>
                      )}
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
        </Tiles>
      </section>
    </Page>
  );
}
