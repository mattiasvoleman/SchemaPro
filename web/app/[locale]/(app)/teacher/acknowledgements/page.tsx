"use client";

import { useTranslations } from "next-intl";
import { AckStaff } from "@/components/acknowledgements/ack-staff";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";

/**
 * /teacher/acknowledgements — Kvittens, the teacher's requests: ask the
 * guardians of the pupils the teacher mentors to confirm a message, and see who
 * has.
 *
 * The same views as the administrator's (components/acknowledgements/ack-staff.tsx);
 * the database's row security decides which pupils a teacher may ask about (the
 * mentees) and which requests they see, and a teacher who mentors nobody gets
 * an empty list of pupils, said kindly. The switch is the administrators', so a
 * school that has not turned Kvittens on says so here and offers no button.
 * Bundle: core tier; nothing here is lazy.
 */
export default function TeacherAcknowledgementsPage() {
  const t = useTranslations("acknowledgements");

  return (
    <Page width="wide">
      <PageHeader title={t("title")} subtitle={t("teacherSubtitle")} />
      <AckStaff audience="teacher" />
    </Page>
  );
}
