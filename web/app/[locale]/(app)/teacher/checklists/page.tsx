"use client";

import { useTranslations } from "next-intl";
import { Checklists } from "@/components/checklists/checklists";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";

/**
 * /teacher/checklists — Checklistor, the teacher's side: tick the pupils of your
 * own groups and lessons who have had an instruction, and keep the consent lists
 * of the classes you mentor.
 *
 * The same views as the administrator's (components/checklists/checklists.tsx);
 * the database's row security decides which pupils a teacher may see, tick and
 * write for, and the answers say it per row. The templates are the
 * administrators': a teacher ticks in them and does not make them.
 * Bundle: core tier; the dialogs and the printed sheet are fetched on the first
 * click.
 */
export default function TeacherChecklistsPage() {
  const t = useTranslations("checklists");

  return (
    <Page width="wide">
      <PageHeader title={t("title")} subtitle={t("teacherSubtitle")} />
      <Checklists audience="teacher" />
    </Page>
  );
}
