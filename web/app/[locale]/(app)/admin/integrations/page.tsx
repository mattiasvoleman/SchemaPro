"use client";

// Integrationer: the keys other systems read SchemaPro with, each with its
// scopes, its webhook signing secret and the subscriptions its system
// registered. The house-shaped /ss12000/v1 keeps working for every key that
// existed; SS12000 2.1 is under /ss12000/v2.0 (docs/integration-api.md).

import { useTranslations } from "next-intl";
import { PageHeader } from "@/components/layout/page-header";
import { KeysTab } from "./keys-tab";

export default function IntegrationsPage() {
  const t = useTranslations("integrations");
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <KeysTab />
    </div>
  );
}
