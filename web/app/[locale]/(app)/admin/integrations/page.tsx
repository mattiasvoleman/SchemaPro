"use client";

// Integrationer: SS12000 both ways.
//
// "Elevregister" is the consumer: the school's register (IST, Edlevo or any
// other SS12000 2.1 provider) as the source of its pupils, staff, guardians
// and classes. The source and its write-only credentials, "Testa
// anslutning" and the choice of skolenhet, the nightly schedule, Synka nu
// and the history of every run, the dry run's diff and its apply, and the
// people a sync added who have no login yet. NOTHING CHANGES IN THE SCHOOL
// UNTIL AN ADMIN APPLIES A DIFF here, or a night the admin explicitly let
// apply the safe part does; nothing is ever deleted, only deactivated.
//
// "API-nycklar" is the provider: the keys other systems read SchemaPro with,
// each with its scopes, its webhook signing secret and the subscriptions its
// system registered. The house-shaped /ss12000/v1 keeps working for every
// key that existed; SS12000 2.1 is under /ss12000/v2.0 (docs/integration-api.md).
//
// The keys tab and the diff review are fetched when they are first opened
// (React's lazy(), not next/dynamic — see admin/people for why), so a school
// that only reads its sync history does not download the key editor.

import { Suspense, lazy } from "react";
import { useTranslations } from "next-intl";
import type { MessageLookup } from "@/lib/engine-message";
import { PageHeader } from "@/components/layout/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProvisioningCard } from "./provisioning-card";
import { ScheduleCard } from "./schedule-card";
import { SourceCard } from "./source-card";
import { errorText } from "./ss12000-messages";
import { SyncCard } from "./sync-card";
import { useSs12000Source } from "./use-ss12000-source";

const KeysTab = lazy(() => import("./keys-tab").then((module) => ({ default: module.KeysTab })));

export default function IntegrationsPage() {
  const t = useTranslations("integrations");
  const tErrors = useTranslations("integrations.errors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const source = useSs12000Source();

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <Tabs defaultValue="source">
        <TabsList>
          <TabsTrigger value="source">{t("tabSource")}</TabsTrigger>
          <TabsTrigger value="keys">{t("tabKeys")}</TabsTrigger>
        </TabsList>
        <TabsContent value="source" className="space-y-4">
          {source.isLoading ? <Skeleton className="h-64 w-full" /> : null}
          {source.isError ? (
            <p role="alert" className="text-sm">
              {errorText(tErrors, source.error, tCommon("error"))}
            </p>
          ) : null}
          {source.isSuccess ? (
            <>
              <SourceCard key={source.data?.id ?? "new"} source={source.data} />
              {source.data ? (
                <>
                  <SyncCard source={source.data} />
                  <ScheduleCard key={`${source.data.scheduleHourLocal}-${source.data.fullEveryDays}`} source={source.data} />
                  <ProvisioningCard />
                </>
              ) : null}
            </>
          ) : null}
        </TabsContent>
        <TabsContent value="keys">
          <Suspense fallback={<Skeleton className="h-64 w-full" />}>
            <KeysTab />
          </Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
}
