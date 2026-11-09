"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { CalendarDays } from "lucide-react";
import { useAcademicYears } from "@/lib/queries";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { AppointmentsCard } from "./appointments-card";
import { DraftsCard } from "./drafts-card";
import { OpenTimesCard } from "./open-times-card";
import { SettingsCard } from "./settings-card";

/**
 * /admin/class-teachers — Klasslärarens schema (G5), the administrators' side:
 * who is klasslärare of which class, the hours open to them, whether they
 * publish for themselves, and the drafts waiting to be published.
 *
 * Every administrator opens it. The page writes more than one area (the
 * appointments and the hours are Schemaläggning's, the option and discarding a
 * draft are Publicering's, publishing a class's drafts takes Schemaläggning,
 * Drift and Publicering together), so no area gates it as a whole and each
 * control asks for its own (use-area-gate.ts); the gateway and the database
 * refuse the same writes by name.
 */
export default function ClassTeachersPage() {
  const t = useTranslations("classTeacherAdmin");
  const tCommon = useTranslations("common");
  const years = useAcademicYears();
  const [chosen, setChosen] = useState<string | null>(null);

  // The year the page is scoped to: the one chosen, else the active one, else the first.
  const list = years.data ?? [];
  const year = list.find((one) => one.id === chosen) ?? list.find((one) => one.isActive) ?? list[0] ?? null;

  return (
    <Page width="wide">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        intro={t("intro")}
        actions={
          list.length > 0 && year ? (
            <NativeSelect aria-label={tCommon("year")} className="w-44" value={year.id} onChange={(event) => setChosen(event.target.value)}>
              {list.map((one) => (
                <option key={one.id} value={one.id}>
                  {one.name}
                </option>
              ))}
            </NativeSelect>
          ) : undefined
        }
      />
      {years.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : years.isError ? (
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      ) : !year ? (
        <EmptyState icon={CalendarDays} headingLevel={2} title={t("noYear.title")} description={t("noYear.body")} />
      ) : (
        <>
          <AppointmentsCard yearId={year.id} />
          <OpenTimesCard yearId={year.id} />
          <SettingsCard />
          <DraftsCard />
        </>
      )}
    </Page>
  );
}
