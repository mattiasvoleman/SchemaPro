"use client";

import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { SchoolDayBody } from "@/components/school-day/school-day-view";
import { useSchoolDayText } from "@/components/school-day/use-school-day-text";
import { MoveNoticeCard } from "./move-notice-card";
import { SettingsCard } from "./settings-card";

/**
 * Skolans dag i ett svep (20270116090000): the day and the week of the whole
 * school as classes, teachers or rooms, and who and what is free over an
 * interval. For rektor and the expedition, on one screen.
 *
 * Every administrator opens it, whatever the profile: the page writes nothing
 * of an area's (PAGE_GATES: no gate), so the läsare (Läsbehörighet) reads it
 * like the rest. The one write is the school's decision about its teachers'
 * share, a card at the bottom that only a decider can save. What the day
 * contains is the calendar's own (src/school-day/school-day.service.ts), so it
 * agrees with /admin/lessons and the Vikarietavla.
 */
export default function SchoolDayPage() {
  const { t } = useSchoolDayText();
  return (
    <Page className="school-day-sheet">
      <PageHeader title={t("title")} subtitle={t("subtitle")} intro={t("intro.admin")} />
      <SchoolDayBody />
      <SettingsCard />
      <MoveNoticeCard />
    </Page>
  );
}
