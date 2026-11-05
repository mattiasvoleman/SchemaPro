"use client";

import { useTranslations } from "next-intl";
import { FindingsSection } from "@/components/absence-watch/findings-section";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";

/**
 * /guardian/absence-watch — Frånvarobevakning, the guardian's list: the
 * guardian's own children who have passed a limit the school set for
 * guardians, and since when.
 *
 * The same list as the administrator's and the mentor's
 * (components/absence-watch/findings-section.tsx); the database's row
 * security hands a guardian the GUARDIAN-group findings of their own child
 * and nothing else, and a school that sets no limit for guardians (or has the
 * watch off) gives an empty list, which is normal and said kindly. Bundle:
 * core tier; nothing here is lazy.
 */
export default function GuardianAbsenceWatchPage() {
  const t = useTranslations("absenceWatch");
  return (
    <Page width="wide">
      <PageHeader title={t("title")} subtitle={t("guardianSubtitle")} />
      <FindingsSection audience="guardian" />
    </Page>
  );
}
