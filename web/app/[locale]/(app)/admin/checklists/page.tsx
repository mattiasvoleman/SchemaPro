"use client";

import { useTranslations } from "next-intl";
import { Checklists } from "@/components/checklists/checklists";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";

/**
 * Checklistor (20270129090000, 20270129091000): instruction proofs
 * (instruktionsbevis) and consent lists per class (samtyckeslistor).
 *
 * An instruction proof says that a pupil has had an instruction (slöjdens
 * maskiner, laborationssäkerhet, idrottens moment) on a day, from a person. The
 * school makes its templates here; anyone who teaches ticks the pupils. A tick
 * made in error is voided with a reason and stays on the pupil's card. A consent
 * list is a class's list of who has consented to something (fotografering,
 * publicering, en utflykt): written down from a paper, a call or a meeting, or
 * asked of the guardians in the app through Kvittens.
 *
 * Both are Drift's: an administrator under Drift writes anything, and a läsare
 * (Läsbehörighet) reads it all and writes nothing. A teacher has the same
 * screens on /teacher/checklists, for their own groups and their mentees.
 * Opening a roster, a list or a pupil's card is recorded in the läslogg, and a
 * printed sheet holds out a pupil with a protected identity.
 */
export default function ChecklistsPage() {
  const t = useTranslations("checklists");

  return (
    <Page width="wide">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <Checklists audience="admin" />
    </Page>
  );
}
