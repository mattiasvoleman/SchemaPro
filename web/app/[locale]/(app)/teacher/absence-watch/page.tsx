"use client";

import { useTranslations } from "next-intl";
import { FindingsSection } from "@/components/absence-watch/findings-section";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";

/**
 * /teacher/absence-watch — Frånvarobevakning, the mentor's list: the pupils in
 * the classes the teacher holds MENTORSKAP for today who have passed a limit
 * the school set for mentors, and since when.
 *
 * The same list as the administrator's and the guardian's
 * (components/absence-watch/findings-section.tsx); the database's row security
 * decides which findings a teacher gets, and a teacher who mentors nobody, or
 * a school with the watch off, gets an empty list, which is normal. The page
 * is in the menu always for that reason. Bundle: core tier, like the teacher's
 * other pages; nothing here is lazy.
 *
 * A link leads on to Frånvarostatistik över tid (/teacher/absence-stats), the
 * same classes month by month; that page has no menu row of its own.
 */
export default function TeacherAbsenceWatchPage() {
  const t = useTranslations("absenceWatch");
  const tStats = useTranslations("absenceStats");
  return (
    <Page width="wide">
      <PageHeader
        title={t("title")}
        subtitle={t("teacherSubtitle")}
        actions={
          <Button variant="outline" size="sm" asChild>
            <Link href="/teacher/absence-stats">{tStats("link")}</Link>
          </Button>
        }
      />
      <FindingsSection audience="mentor" />
    </Page>
  );
}
