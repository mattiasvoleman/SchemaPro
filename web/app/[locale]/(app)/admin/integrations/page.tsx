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
// that only reads its sync history does not download the key editor. Once
// opened, the keys tab stays mounted (hidden while the other tab shows): a
// new key and a new signing secret are shown ONCE, from that tab's state, and
// a tab switch — or one during the request — must not throw them away.

import { Suspense, lazy, useState } from "react";
import { useTranslations } from "next-intl";
import type { MessageLookup } from "@/lib/engine-message";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProvisioningCard } from "./provisioning-card";
import { ScheduleCard } from "./schedule-card";
import { SourceCard } from "./source-card";
import { errorText } from "./ss12000-messages";
import { SyncCard } from "./sync-card";
import { useSs12000Source } from "./use-ss12000-source";

const KeysTab = lazy(() => import("./keys-tab").then((module) => ({ default: module.KeysTab })));
const SignInTab = lazy(() => import("./sign-in-tab").then((module) => ({ default: module.SignInTab })));

export default function IntegrationsPage() {
  const t = useTranslations("integrations");
  const tErrors = useTranslations("integrations.errors") as unknown as MessageLookup;
  const source = useSs12000Source();
  const [tab, setTab] = useState("source");
  const [keysOpened, setKeysOpened] = useState(false);

  // The gateway's reason in the reader's words when it gave one, and always
  // what did not happen: a failed read changes nothing in the school.
  const reason = source.isError ? errorText(tErrors, source.error, "") : "";

  return (
    <Page width="wide">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <Tabs
        value={tab}
        onValueChange={(value) => {
          setTab(value);
          if (value === "keys") setKeysOpened(true);
        }}
        className="space-y-4"
      >
        <TabsList aria-label={t("tabsLabel")}>
          <TabsTrigger value="source">{t("tabSource")}</TabsTrigger>
          <TabsTrigger value="keys">{t("tabKeys")}</TabsTrigger>
          <TabsTrigger value="sign-in">{t("tabSignIn")}</TabsTrigger>
        </TabsList>
        <TabsContent value="source" className="space-y-4">
          {source.isLoading ? (
            <div aria-busy="true">
              <Skeleton className="h-64 w-full" />
            </div>
          ) : null}
          {source.isError ? (
            <LoadError
              title={t("loadFailed")}
              hint={reason ? `${reason} ${t("loadFailedHint")}` : t("loadFailedHint")}
              headingLevel={2}
            />
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
        <TabsContent value="keys" forceMount={keysOpened ? true : undefined} hidden={tab !== "keys"}>
          <Suspense
            fallback={
              <div aria-busy="true">
                <Skeleton className="h-64 w-full" />
              </div>
            }
          >
            <KeysTab />
          </Suspense>
        </TabsContent>
        {/* Rendered only while chosen (radix unmounts an inactive tab), so its chunk is fetched on the first click. */}
        <TabsContent value="sign-in">
          <Suspense
            fallback={
              <div aria-busy="true">
                <Skeleton className="h-64 w-full" />
              </div>
            }
          >
            <SignInTab />
          </Suspense>
        </TabsContent>
      </Tabs>
    </Page>
  );
}
