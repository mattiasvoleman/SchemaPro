"use client";

import { useTranslations } from "next-intl";
import { ClassBrowser } from "@/components/absence-stats/class-browser";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";

/**
 * /teacher/absence-stats — Frånvarostatistik över tid, the mentor's page: the
 * classes the teacher is mentor for, each month by month over three läsår
 * with the rapporteringsgrad beside it, its patterns (weekday, pass, subject),
 * its pupils and the pupil's card for a development talk.
 *
 * The same components as the administrator's tab on /admin/reports
 * (components/absence-stats/class-browser.tsx); the database's row security
 * decides which classes and pupils a teacher gets (their own mentees only),
 * and a teacher who mentors nobody gets an empty state, said kindly. No menu
 * row of its own: it is reached from Frånvarobevakning
 * (/teacher/absence-watch). The school-wide months are the administrators'
 * and are not asked for here.
 */
export default function TeacherAbsenceStatsPage() {
  const t = useTranslations("absenceStats");
  return (
    <Page>
      <PageHeader
        title={t("title")}
        subtitle={t("teacherSubtitle")}
        back={{ href: "/teacher/absence-watch", label: t("backToWatch") }}
      />
      <ClassBrowser audience="mentor" />
    </Page>
  );
}
