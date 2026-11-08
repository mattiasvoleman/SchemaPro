"use client";

import { useTranslations } from "next-intl";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { ResourceTypesCard } from "./resource-types-card";
import { ResourcesCard } from "./resources-card";

/**
 * Resurser (20270131091000): what the school lends out that is not a lokal,
 * the kinds it has named and the resources themselves. A teacher books them on
 * /teacher/resources, Drift decides the ones that need it on Lokalbokningar,
 * and an association can hire one by a series on Externa bokningar.
 *
 * The kinds and the resources are Planering's, as the lokaler are; a läsare
 * (Läsbehörighet) reads both and changes neither.
 */
export default function ResourcesPage() {
  const t = useTranslations("adminResources");

  return (
    <Page>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <ResourceTypesCard />
      <ResourcesCard />
    </Page>
  );
}
