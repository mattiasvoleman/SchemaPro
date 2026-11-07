"use client";

import { useTranslations } from "next-intl";
import { AckStaff } from "@/components/acknowledgements/ack-staff";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { SettingsCard } from "./settings-card";

/**
 * Kvittens (20270117091000): the school's switch and the one reminder, and the
 * requests staff have made for a guardian's confirmation, with who confirmed
 * and when.
 *
 * Off until an administrator turns it on. A request names pupils, and the
 * guardians of those pupils are asked to confirm a message with one tap in the
 * web or the app; the sender chooses whether one guardian is enough or each
 * must confirm. Who the pupils and guardians are is read behind the login, and
 * each reading is recorded in the läslogg. A teacher makes requests about the
 * pupils they mentor, on /teacher/acknowledgements, with the same list.
 *
 * The switch and the days are Drift's, as the leave and the notices they sit
 * beside; a läsare (Läsbehörighet) reads them all and changes none, and
 * cannot make a request.
 */
export default function AcknowledgementsPage() {
  const t = useTranslations("acknowledgements");

  return (
    <Page width="wide">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <SettingsCard />
      <AckStaff audience="admin" />
    </Page>
  );
}
