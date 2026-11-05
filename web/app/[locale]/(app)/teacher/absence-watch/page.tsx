"use client";

import { useTranslations } from "next-intl";
import { FindingsSection } from "@/components/absence-watch/findings-section";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";

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
 */
export default function TeacherAbsenceWatchPage() {
  const t = useTranslations("absenceWatch");
  return (
    <Page width="wide">
      <PageHeader title={t("title")} subtitle={t("teacherSubtitle")} />
      <FindingsSection audience="mentor" />
    </Page>
  );
}
