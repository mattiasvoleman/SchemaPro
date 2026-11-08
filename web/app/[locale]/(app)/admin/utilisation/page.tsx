"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { BarChart3, Download, Loader2, Printer } from "lucide-react";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar, FilterField } from "@/components/ui/filter-bar";
import { Input } from "@/components/ui/input";
import { LoadError } from "@/components/ui/load-error";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DEFAULT_OPEN_FROM,
  DEFAULT_OPEN_TO,
  LIMITS,
  UTILISATION_KINDS,
  termContaining,
  termPresets,
  utilisationErrors,
  type UtilisationKind,
  type UtilisationParams,
} from "@/lib/local";
import { downloadUtilisationCsv, useUtilisation } from "@/lib/local-queries";
import { toDateString } from "@/lib/utils";
import { rowKey, UtilisationTable } from "./utilisation-table";

/** The select's value when the dates are not a term's. */
const CUSTOM = "custom";

/**
 * Utnyttjande (20270204091000): how much of each room and each resource is
 * booked. For a period, the share of its school time (inside the ramtid on a
 * teaching day) and of its evenings and weekends (the open hours outside school
 * time) that something holds, for the whole period and week by week. A lesson, a
 * booking of a teacher and a day of an external hire all count.
 *
 * Every administrator reads it: it names no person and changes nothing. The
 * report is asked when "Visa" is pressed and not on each keystroke, since a term
 * across every room is a heavy read. It prints as it stands and goes to Excel
 * as a file, as Måltidskollen does.
 */
export default function UtilisationPage() {
  const t = useTranslations("adminUtilisation");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  // The reader's own day, not UTC's: before 02:00 in Sweden UTC is still yesterday.
  const today = toDateString(new Date());
  const presets = useMemo(() => termPresets(today), [today]);
  const [form, setForm] = useState<UtilisationParams>(() => {
    const term = termContaining(today);
    return { from: term.from, to: term.to, kind: "ALL", openFrom: DEFAULT_OPEN_FROM, openTo: DEFAULT_OPEN_TO };
  });
  // What the report on screen was asked for. The page opens on the term it is in.
  const [applied, setApplied] = useState<UtilisationParams>(form);
  const [tried, setTried] = useState(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [downloading, setDownloading] = useState(false);
  const report = useUtilisation(applied);

  const errors = utilisationErrors(form);
  const invalid = Object.keys(errors).length > 0;
  const chosen = presets.find((preset) => preset.from === form.from && preset.to === form.to)?.id ?? CUSTOM;
  const termLabel = (preset: (typeof presets)[number]) => t("termLabel", { term: preset.term, year: String(preset.year) });
  const data = report.data;

  const show = (event: React.FormEvent) => {
    event.preventDefault();
    setTried(true);
    if (invalid) return;
    setApplied(form);
    setOpen(new Set());
  };

  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      await downloadUtilisationCsv(applied);
    } catch {
      toast.error(t("csvFailed"));
    } finally {
      setDownloading(false);
    }
  };

  const toggle = (row: { kind: "ROOM" | "RESOURCE"; id: string }) =>
    setOpen((current) => {
      const next = new Set(current);
      const key = rowKey(row);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const allOpen = data !== undefined && data.rows.length > 0 && data.rows.every((row) => open.has(rowKey(row)));
  const toggleAll = () => setOpen(allOpen || !data ? new Set() : new Set(data.rows.map(rowKey)));

  const error = (field: keyof typeof errors) => {
    const code = errors[field];
    return tried && code ? t(`errors.${code}`, { max: String(LIMITS.reportDays) }) : undefined;
  };

  return (
    <Page>
      <PageHeader title={t("title")} subtitle={t("subtitle")} intro={t("intro")} />

      <form onSubmit={show} noValidate className="print:hidden">
        <FilterBar>
          <FilterField id="utilisation-term" label={t("period")}>
            <NativeSelect
              id="utilisation-term"
              value={chosen}
              onChange={(event) => {
                const preset = presets.find((one) => one.id === event.target.value);
                if (preset) setForm({ ...form, from: preset.from, to: preset.to });
              }}
            >
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {termLabel(preset)}
                </option>
              ))}
              <option value={CUSTOM}>{t("customDates")}</option>
            </NativeSelect>
          </FilterField>
          <FilterField id="utilisation-from" label={t("from")}>
            <DateField
              id="utilisation-from"
              label={t("from")}
              className="w-40"
              value={form.from}
              aria-describedby={error("from") ? "utilisation-from-error" : undefined}
              onChange={(value) => setForm({ ...form, from: value })}
            />
          </FilterField>
          <FilterField id="utilisation-to" label={t("to")}>
            <DateField
              id="utilisation-to"
              label={t("to")}
              className="w-40"
              value={form.to}
              min={form.from || undefined}
              aria-describedby={error("to") ? "utilisation-to-error" : undefined}
              onChange={(value) => setForm({ ...form, to: value })}
            />
          </FilterField>
          <FilterField id="utilisation-kind" label={tCommon("type")}>
            <NativeSelect
              id="utilisation-kind"
              value={form.kind}
              onChange={(event) => setForm({ ...form, kind: event.target.value as UtilisationKind })}
            >
              {UTILISATION_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`kind.${kind}`)}
                </option>
              ))}
            </NativeSelect>
          </FilterField>
          <FilterField id="utilisation-open-from" label={t("openFrom")}>
            <Input
              id="utilisation-open-from"
              type="time"
              className="w-32 tabular-nums"
              value={form.openFrom}
              aria-invalid={error("openFrom") ? true : undefined}
              aria-describedby={error("openFrom") ? "utilisation-open-from-error" : undefined}
              onChange={(event) => setForm({ ...form, openFrom: event.target.value })}
            />
          </FilterField>
          <FilterField id="utilisation-open-to" label={t("openTo")}>
            <Input
              id="utilisation-open-to"
              type="time"
              className="w-32 tabular-nums"
              value={form.openTo}
              aria-invalid={error("openTo") ? true : undefined}
              aria-describedby={error("openTo") ? "utilisation-open-to-error" : undefined}
              onChange={(event) => setForm({ ...form, openTo: event.target.value })}
            />
          </FilterField>
          <Button type="submit" disabled={report.isFetching}>
            {t("show")}
          </Button>
        </FilterBar>
        {tried && invalid ? (
          <ul role="alert" className="mt-2 space-y-0.5 text-sm text-destructive">
            {(["from", "to", "openFrom", "openTo"] as const).map((field) =>
              error(field) ? (
                <li key={field} id={`utilisation-${field === "openFrom" ? "open-from" : field === "openTo" ? "open-to" : field}-error`}>
                  {t(`field.${field}`)}: {error(field)}
                </li>
              ) : null,
            )}
          </ul>
        ) : null}
      </form>

      {/* Always mounted, so the result is announced when it arrives. */}
      <p role="status" className="sr-only">
        {data ? t("loadedStatus", { count: data.rows.length }) : ""}
      </p>
      <div>
        {report.isLoading ? (
          <div aria-busy="true" className="print:hidden">
            <Skeleton className="h-64 w-full" />
          </div>
        ) : report.isError || !data ? (
          <LoadError
            title={t("loadFailed")}
            hint={t("loadFailedHint")}
            headingLevel={2}
            className="print:hidden"
            action={
              <Button variant="outline" size="sm" onClick={() => void report.refetch()}>
                {tCommon("retry")}
              </Button>
            }
          />
        ) : (
          <div className="space-y-4">
            <h2 className="hidden text-lg font-semibold print:block">
              {t("print.school")} · {t("print.title", { from: data.from, to: data.to })}
            </h2>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-muted-foreground tabular-nums">
                {t("summary", { from: data.from, to: data.to, openFrom: data.openFrom, openTo: data.openTo })}
              </p>
              <div className="flex flex-wrap items-center gap-2 print:hidden">
                <Button variant="outline" size="sm" disabled={data.rows.length === 0} onClick={toggleAll}>
                  {t(allOpen ? "hideAllWeeks" : "showAllWeeks")}
                </Button>
                <Button variant="outline" size="sm" disabled={downloading} onClick={() => void download()}>
                  {downloading ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
                  {t("csv")}
                </Button>
                <Button variant="outline" size="sm" disabled={data.rows.length === 0} onClick={() => window.print()}>
                  <Printer aria-hidden="true" />
                  {t("print.button")}
                </Button>
              </div>
            </div>
            {data.framesMissing ? (
              <Notice tone="warning" title={t("framesMissingTitle")} className="print:border print:bg-transparent">
                {t("framesMissingBody")}
              </Notice>
            ) : null}
            {data.rows.length === 0 ? (
              <EmptyState icon={BarChart3} title={t("emptyTitle")} description={t("emptyHint")} headingLevel={2} />
            ) : (
              <UtilisationTable rows={data.rows} open={open} onToggle={toggle} />
            )}
            <Notice tone="neutral" title={t("notesTitle")} className="print:border print:bg-transparent">
              <ul className="list-disc space-y-1 pl-5">
                <li>{t("noteSchoolTime")}</li>
                <li>{t("noteOutside", { openFrom: data.openFrom, openTo: data.openTo })}</li>
                <li>{t("noteCounts")}</li>
                <li>{t("noteUnits")}</li>
              </ul>
            </Notice>
          </div>
        )}
      </div>
    </Page>
  );
}
