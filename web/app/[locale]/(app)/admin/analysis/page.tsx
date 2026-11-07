"use client";

import { useState } from "react";
import { CalendarOff } from "lucide-react";
import { useAnalysisText } from "@/components/analysis/use-analysis-text";
import { CostBasisPanel } from "@/components/analysis/cost-basis-panel";
import { KeyFiguresPanel } from "@/components/analysis/key-figures-panel";
import { PayrollPanel } from "@/components/analysis/payroll-panel";
import { SettingsPanel } from "@/components/analysis/settings-panel";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { YearSelect, useYearScope } from "@/components/schedule/year-select";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar } from "@/components/ui/filter-bar";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const TABS = ["keyFigures", "cost", "payroll", "settings"] as const;
type TabKey = (typeof TABS)[number];

/**
 * Analys och planering: nyckeltal per skola och lärare, kostnadsunderlag per
 * elev och löneunderlag med konton, and under the last tab the two things the
 * school states for them, its skoldelar and the cost of an hour per
 * personalkategori.
 *
 * Everything is counted when a tab is opened, from the tjänstefördelning, the
 * rosters and the lessons held, and nothing is kept but what the school states.
 * No individual salary is stored: a cost is hours times a rate for a category.
 * The tab is the page's state, not the address, and only the open tab asks the
 * gateway anything (the payroll not until it is given a period).
 *
 * Each tab says calmly when the reader is not given it: tjänstgöringsgrad is
 * left out for a reader without HR-läs, the cost basis is the school's economy,
 * the payroll is HR data, and the huvudman's reader reads the school's figures
 * and no teacher's row.
 */
export default function AnalysisPage() {
  const { t } = useAnalysisText();
  const scope = useYearScope();
  const [tab, setTab] = useState<TabKey>("keyFigures");

  return (
    <Page>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        intro={t("intro")}
        actions={<YearSelect value={scope.yearId} onValueChange={scope.setYearId} years={scope.years} />}
      />

      <FilterBar>
        <Tabs value={tab} onValueChange={(value) => setTab(value as TabKey)}>
          <TabsList aria-label={t("tabs.label")}>
            {TABS.map((one) => (
              <TabsTrigger key={one} value={one}>
                {t(`tabs.${one}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </FilterBar>

      {scope.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : scope.isError ? (
        <LoadError title={t("years.loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      ) : tab === "settings" ? (
        <SettingsPanel />
      ) : scope.year === null ? (
        <EmptyState icon={CalendarOff} headingLevel={2} title={t("years.noneTitle")} description={t("years.noneBody")} />
      ) : tab === "keyFigures" ? (
        <KeyFiguresPanel yearId={scope.year.id} />
      ) : tab === "cost" ? (
        <CostBasisPanel yearId={scope.year.id} yearName={scope.year.name} />
      ) : (
        <PayrollPanel yearId={scope.year.id} />
      )}
    </Page>
  );
}
