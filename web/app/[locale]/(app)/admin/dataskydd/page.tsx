"use client";

// Dataskydd och gallring: how long the school keeps each kind of data, what
// each period would take, and the nights that have run.
//
// THE DEFAULT REMOVES NOTHING. Every kind starts at "Ej beslutat", and a kind
// nobody has decided is never touched (PRODUCT.md principle 6: the school's
// rules are the school's, under its huvudman's dokumenthanteringsplan). A
// decision is recorded here and applied by the nightly job from 03:00; one
// that removes more than the one before it waits a day, so a wrong choice can
// be changed back before anything goes. What goes cannot be restored in
// SchemaPro, and the page says so above everything else.

import { useTranslations } from "next-intl";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { HistoryCard } from "./history-card";
import { KindsCard } from "./kinds-card";
import { RunsCard } from "./runs-card";
import { useRetentionOverview } from "./use-retention";

export default function DataProtectionPage() {
  const t = useTranslations("dataProtection");
  const tCommon = useTranslations("common");
  const overview = useRetentionOverview();
  const data = overview.data;

  return (
    <Page width="wide">
      <PageHeader title={t("title")} subtitle={t("subtitle")} intro={t("intro")} />

      <Notice tone="warning" title={t("irreversibleTitle")}>
        {t("irreversibleBody")}
      </Notice>

      {overview.isError && data ? (
        <LoadError variant="inline" title={t("loadFailed")} hint={tCommon("refetchFailedHint")} />
      ) : null}

      {overview.isLoading ? (
        <div aria-busy="true" className="space-y-4">
          <Skeleton className="h-96 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : overview.isError && !data ? (
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      ) : data ? (
        <>
          <KindsCard kinds={data.kinds} timeZone={data.timezone} />
          <RunsCard runs={data.runs} timeZone={data.timezone} />
          <HistoryCard history={data.history} timeZone={data.timezone} />
        </>
      ) : null}
    </Page>
  );
}
