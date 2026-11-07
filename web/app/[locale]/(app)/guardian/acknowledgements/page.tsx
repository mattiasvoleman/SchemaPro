"use client";

import { useTranslations } from "next-intl";
import { GuardianMessages } from "@/components/acknowledgements/guardian-messages";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";

/**
 * /guardian/acknowledgements — Kvittens, the guardian's list: the messages in
 * which the school asks them to confirm that they have taken part of it, and
 * the button that does.
 *
 * Only the guardian's own rows come back (GET /acknowledgements/mine under the
 * database's row security): their own children, their own confirmation and
 * nothing of the other guardian's. A school that has not turned Kvittens on, or
 * has asked nothing, gives an empty list, said kindly. Bundle: core tier;
 * nothing here is lazy.
 */
export default function GuardianAcknowledgementsPage() {
  const t = useTranslations("acknowledgements");

  return (
    <Page width="narrow">
      <PageHeader title={t("title")} subtitle={t("guardianSubtitle")} />
      <GuardianMessages />
    </Page>
  );
}
