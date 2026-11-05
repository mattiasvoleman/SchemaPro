"use client";

import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { FileDown, FileUp, Loader2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import {
  EXCHANGE_FORMATS,
  MAX_UPLOAD_BYTES,
  formatOfFileNames,
  saveBase64,
  toBase64,
  type ExchangeFormat,
  type ExchangeSummary,
  type ImportPlanDto,
  type ImportResultDto,
} from "@/lib/schedule-exchange";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { YearSelect, useYearScope } from "@/components/schedule/year-select";
import { Button } from "@/components/ui/button";
import { LoadError } from "@/components/ui/load-error";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { ImportPreview } from "./import-preview";

/**
 * Schemat som tabell och i öppna format: the grundschema out as a table (CSV,
 * Excel), Untis GPU files or aSc XML, and a file of those formats in as
 * locked lessons.
 *
 * THE PAGE READS NO FILE. A file goes to the gateway as it is, in base64, and
 * is parsed there (src/schedule-exchange): a spreadsheet and an XML reader in
 * the browser would be on this route's bill for something only this page
 * does, and the gateway has the school's names to resolve them against. What
 * the page does is choose, send, and show the answer; nothing is written
 * until the preview has been read and Skriv in is pressed, and then only if
 * the preview's fingerprint is still the plan's.
 */

const KEYS = { summary: (yearId: string) => ["schedule-exchange", "summary", yearId] as const };

export default function ScheduleExchangePage() {
  const t = useTranslations("scheduleExchange");
  const queryClient = useQueryClient();
  const { yearId, isLoading: yearsLoading, isError: yearsError, setYearId, years } = useYearScope();
  const fileInput = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [format, setFormat] = useState<ExchangeFormat | "">("");
  const [periods, setPeriods] = useState("");
  const [plan, setPlan] = useState<ImportPlanDto | null>(null);
  const [result, setResult] = useState<ImportResultDto | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const summary = useQuery({
    queryKey: KEYS.summary(yearId ?? ""),
    queryFn: () => api.get<ExchangeSummary>(`/api/v1/schedule-exchange/summary?academicYearId=${yearId}`),
    enabled: yearId !== null,
  });

  const exportFile = useMutation({
    mutationFn: (chosen: ExchangeFormat) =>
      api.post<{ filename: string; contentType: string; contentBase64: string }>("/api/v1/schedule-exchange/export", {
        academicYearId: yearId,
        format: chosen,
      }),
    onSuccess: (file) => saveBase64(file.filename, file.contentType, file.contentBase64),
    onError: () => toast.error(t("export.failed")),
  });

  const bodyOf = async () => ({
    academicYearId: yearId,
    format,
    files: await Promise.all(files.map(async (file) => ({ name: file.name, contentBase64: await toBase64(file) }))),
    // Only a period-numbered Untis file needs the school's own grid.
    ...(format === "UNTIS_GPU" && periods.trim() !== "" ? { periods } : {}),
  });

  const preview = useMutation({
    mutationFn: async () => api.post<ImportPlanDto>("/api/v1/schedule-exchange/import/preview", await bodyOf()),
    onMutate: () => {
      setPlan(null);
      setResult(null);
      setProblem(null);
    },
    onSuccess: setPlan,
    onError: (error) => setProblem(error instanceof ApiError ? error.message : t("import.previewFailed")),
  });

  const apply = useMutation({
    mutationFn: async () =>
      api.post<ImportResultDto>("/api/v1/schedule-exchange/import/apply", { ...(await bodyOf()), fingerprint: plan?.fingerprint }),
    onSuccess: (done) => {
      setResult(done);
      setPlan(null);
      void queryClient.invalidateQueries();
    },
    onError: (error) => {
      // A plan that moved since the preview is read again; anything else is shown.
      if (error instanceof ApiError && error.code === "IMPORT_PLAN_CHANGED") {
        setPlan(null);
        setProblem(t("import.planChanged"));
      } else {
        setProblem(error instanceof ApiError ? error.message : t("import.applyFailed"));
      }
    },
  });

  function choose(list: FileList | null) {
    const chosen = Array.from(list ?? []);
    setPlan(null);
    setResult(null);
    setProblem(null);
    if (chosen.some((file) => file.size > MAX_UPLOAD_BYTES)) {
      setFiles([]);
      setFormat("");
      setProblem(t("import.tooLarge", { size: Math.round(MAX_UPLOAD_BYTES / 1024) }));
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    setFiles(chosen);
    setFormat(formatOfFileNames(chosen.map((file) => file.name)) ?? "");
  }

  if (yearsLoading) {
    return (
      <Page width="wide">
        <PageHeader title={t("title")} subtitle={t("subtitle")} />
        <Skeleton className="h-40 w-full" />
      </Page>
    );
  }
  if (yearsError) {
    return (
      <Page width="wide">
        <PageHeader title={t("title")} subtitle={t("subtitle")} />
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      </Page>
    );
  }

  const s = summary.data;
  return (
    <Page width="wide">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        intro={t("intro")}
        actions={years.length > 0 ? <YearSelect value={yearId} onValueChange={setYearId} label={t("yearLabel")} /> : undefined}
      />

      <SectionCard id="export" title={t("export.title")} description={t("export.description")} icon={FileDown}>
        {summary.isError ? <LoadError variant="inline" title={t("loadFailed")} hint={t("loadFailedHint")} /> : null}
        {s ? (
          <div className="space-y-3">
            <p className="text-sm">
              {t("export.summary", { count: s.lessons, parked: s.parked, year: s.yearName })}{" "}
              {s.publishMode === "DRAFT" ? t("export.draft") : t("export.direct")}
            </p>
            {s.teachersWithoutSignature > 0 ? (
              <Notice tone="warning">{t("export.noSignature", { count: s.teachersWithoutSignature })}</Notice>
            ) : null}
            <ul className="grid gap-3 sm:grid-cols-2">
              {EXCHANGE_FORMATS.map((id) => (
                <li key={id} className="rounded-md border p-3">
                  <p className="text-sm font-medium">{t(`formats.${id}.name`)}</p>
                  <p className="mb-2 text-sm text-muted-foreground">{t(`formats.${id}.hint`)}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={exportFile.isPending || s.lessons === 0}
                    onClick={() => exportFile.mutate(id)}
                  >
                    {exportFile.isPending && exportFile.variables === id ? (
                      <Loader2 className="animate-spin" aria-hidden="true" />
                    ) : (
                      <FileDown aria-hidden="true" />
                    )}
                    {t("export.download")}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <Skeleton className="h-24 w-full" />
        )}
      </SectionCard>

      <SectionCard id="import" title={t("import.title")} description={t("import.description")} icon={FileUp}>
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1">
              <label htmlFor="exchange-file" className="mb-1 block text-sm font-medium">
                {t("import.file")}
              </label>
              <input
                ref={fileInput}
                id="exchange-file"
                type="file"
                multiple
                accept=".csv,.xlsx,.xml,.txt,.zip"
                onChange={(event) => choose(event.target.files)}
                className="block w-full text-sm"
              />
            </div>
            <div>
              <label htmlFor="exchange-format" className="mb-1 block text-sm font-medium">
                {t("import.format")}
              </label>
              <NativeSelect
                id="exchange-format"
                value={format}
                onChange={(event) => setFormat(event.target.value as ExchangeFormat | "")}
                className="w-56"
              >
                <option value="">{t("import.chooseFormat")}</option>
                {EXCHANGE_FORMATS.map((id) => (
                  <option key={id} value={id}>
                    {t(`formats.${id}.name`)}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <Button disabled={files.length === 0 || format === "" || preview.isPending} onClick={() => preview.mutate()}>
              {preview.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              {t("import.preview")}
            </Button>
          </div>
          {format === "UNTIS_GPU" ? (
            <div>
              <label htmlFor="exchange-periods" className="mb-1 block text-sm font-medium">
                {t("import.periods")}
              </label>
              <textarea
                id="exchange-periods"
                value={periods}
                onChange={(event) => setPeriods(event.target.value)}
                rows={5}
                spellCheck={false}
                placeholder={"1 08:10-09:10\n2 09:20-10:20"}
                className="block w-full max-w-sm rounded-md border border-input-strong bg-transparent px-3 py-2 font-mono text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <p className="mt-1 text-sm text-muted-foreground">{t("import.periodsHint")}</p>
            </div>
          ) : null}
          {files.length > 0 && format === "" ? <Notice tone="warning">{t("import.unknownFormat")}</Notice> : null}
          {problem ? <Notice tone="destructive">{problem}</Notice> : null}
          {result ? (
            <Notice tone="success">
              {t("import.done", {
                created: result.created,
                unchanged: result.unchanged,
                posts: result.requirementsCreated,
                blocks: result.blocksCreated,
              })}
            </Notice>
          ) : null}
          {plan ? (
            <ImportPreview plan={plan} applying={apply.isPending} onApply={() => apply.mutate()} />
          ) : null}
        </div>
      </SectionCard>
    </Page>
  );
}
