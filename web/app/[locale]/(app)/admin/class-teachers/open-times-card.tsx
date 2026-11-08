"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Plus, Trash2 } from "lucide-react";
import { useClassTeacherAdminActions, useOpenTimes } from "@/lib/class-teacher-queries";
import { SPANS_MAX, WEEKDAYS, isTime, minutesOf, type OpenTimeView } from "@/lib/class-teacher";
import { useGroups } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { LoadError } from "@/components/ui/load-error";
import { NativeSelect } from "@/components/ui/native-select";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAreaGate } from "./use-area-gate";

/** One span as the inputs hold it. */
interface SpanRow {
  key: number;
  dayOfWeek: string;
  start: string;
  end: string;
}

const rowsOf = (list: readonly OpenTimeView[], next: () => number): SpanRow[] =>
  list.map((one) => ({ key: next(), dayOfWeek: String(one.dayOfWeek), start: one.startTime.slice(0, 5), end: one.endTime.slice(0, 5) }));

/** The spans as a comparable string, in day and time order, so that "unchanged" does not depend on the order typed. */
const signature = (rows: ReadonlyArray<Pick<SpanRow, "dayOfWeek" | "start" | "end">>): string =>
  rows
    .map((one) => `${one.dayOfWeek}|${one.start}|${one.end}`)
    .sort()
    .join(",");

/**
 * The hours of the week a klasslärare may lay lessons in, per scope: every
 * class of the läsår, or one class. The spans of a scope are replaced whole on
 * save. A class's own spans are added to the ones that hold for every class,
 * so a class never has fewer hours than all; the card says so, and shows the
 * hours that already hold for all when it edits one class.
 */
export function OpenTimesCard({ yearId }: { yearId: string }) {
  const t = useTranslations("classTeacherAdmin");
  const tDays = useTranslations("days");
  const gate = useAreaGate();
  const openTimes = useOpenTimes(yearId);
  const groups = useGroups();
  const [scope, setScope] = useState("all");

  const classes = (groups.data ?? []).filter((group) => group.academicYearId === yearId && group.kind === "CLASS" && !group.halfOfId);
  const scopeId = scope !== "all" && classes.some((one) => one.id === scope) ? scope : null;
  const list = openTimes.data ?? [];
  const forAll = list.filter((one) => one.studentGroupId === null);

  return (
    <SectionCard id="class-teacher-open-times" title={t("openTimes.title")} description={t("openTimes.description")}>
      <FormField id="class-teacher-scope" label={t("openTimes.scope")} className="max-w-xs">
        <NativeSelect value={scopeId ?? "all"} onChange={(event) => setScope(event.target.value)}>
          <option value="all">{t("openTimes.scopeAll")}</option>
          {classes.map((one) => (
            <option key={one.id} value={one.id}>
              {one.name}
            </option>
          ))}
        </NativeSelect>
      </FormField>

      {openTimes.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-24 w-full" />
        </div>
      ) : openTimes.isError || !openTimes.data ? (
        <LoadError variant="inline" title={t("openTimes.loadFailed")} hint={t("loadFailedHint")} />
      ) : (
        <>
          {scopeId !== null ? (
            <p className="text-sm text-muted-foreground">
              {forAll.length > 0
                ? t("openTimes.alsoAll", { spans: forAll.map((one) => `${tDays(String(one.dayOfWeek))} ${one.startTime.slice(0, 5)}–${one.endTime.slice(0, 5)}`).join(", ") })
                : t("openTimes.alsoAllNone")}
            </p>
          ) : null}
          <SpansEditor
            // Each scope, and each läsår, has an editor of its own: what is typed for one is not carried to another.
            key={`${yearId}:${scopeId ?? "all"}`}
            yearId={yearId}
            scopeId={scopeId}
            saved={list.filter((one) => one.studentGroupId === scopeId)}
            may={gate.may("SCHEMALAGGNING")}
            why={gate.why("SCHEMALAGGNING")}
          />
        </>
      )}
    </SectionCard>
  );
}

function SpansEditor({
  yearId,
  scopeId,
  saved,
  may,
  why,
}: {
  yearId: string;
  scopeId: string | null;
  saved: OpenTimeView[];
  may: boolean;
  why: string | null;
}) {
  const t = useTranslations("classTeacherAdmin");
  const tCommon = useTranslations("common");
  const tDays = useTranslations("days");
  const { setOpenTimes } = useClassTeacherAdminActions();
  const counter = useRef(0);
  const next = () => counter.current++;
  const [rows, setRows] = useState<SpanRow[]>(() => rowsOf(saved, next));

  const set = (key: number, patch: Partial<SpanRow>) => setRows((current) => current.map((one) => (one.key === key ? { ...one, ...patch } : one)));
  const faultOf = (row: SpanRow): string | null =>
    !isTime(row.start) || !isTime(row.end) ? t("openTimes.timeMissing") : minutesOf(row.end) <= minutesOf(row.start) ? t("openTimes.endAfterStart") : null;
  const faults = rows.map(faultOf);
  const dirty = signature(rows) !== signature(rowsOf(saved, () => 0));
  const tooMany = rows.length > SPANS_MAX;

  const save = async () => {
    if (!may || setOpenTimes.isPending || faults.some(Boolean) || tooMany) return;
    try {
      const answer = await setOpenTimes.mutateAsync({
        academicYearId: yearId,
        studentGroupId: scopeId,
        spans: rows.map((one) => ({ dayOfWeek: Number(one.dayOfWeek), startTime: one.start, endTime: one.end })),
      });
      // Spans that touch or overlap are made one on save: the editor shows what was kept.
      setRows(rowsOf(answer.filter((one) => one.studentGroupId === scopeId), next));
      toast.success(t("openTimes.saved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  return (
    <form
      className="space-y-3"
      aria-label={t("openTimes.editorLabel")}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {rows.length === 0 ? <p className="text-sm text-muted-foreground">{t("openTimes.empty")}</p> : null}
      {rows.length > 0 ? (
        <ul className="space-y-2" data-writes-inert="SCHEMALAGGNING">
          {rows.map((row, index) => {
            const fault = faults[index];
            const n = index + 1;
            return (
              <li key={row.key} className="space-y-1">
                <div role="group" aria-label={t("openTimes.spanLabel", { n })} className="flex flex-wrap items-end gap-2">
                  <FormField id={`open-day-${row.key}`} label={t("openTimes.day")} className="w-40">
                    <NativeSelect value={row.dayOfWeek} disabled={!may} onChange={(event) => set(row.key, { dayOfWeek: event.target.value })}>
                      {WEEKDAYS.map((one) => (
                        <option key={one} value={String(one)}>
                          {tDays(String(one))}
                        </option>
                      ))}
                    </NativeSelect>
                  </FormField>
                  <FormField id={`open-start-${row.key}`} label={t("openTimes.from")} className="w-32">
                    <Input type="time" step={300} value={row.start} disabled={!may} onChange={(event) => set(row.key, { start: event.target.value })} />
                  </FormField>
                  <FormField id={`open-end-${row.key}`} label={t("openTimes.to")} className="w-32">
                    <Input type="time" step={300} value={row.end} disabled={!may} onChange={(event) => set(row.key, { end: event.target.value })} />
                  </FormField>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-writes="SCHEMALAGGNING"
                    disabled={!may}
                    aria-label={t("openTimes.removeSpan", { n })}
                    onClick={() => setRows((current) => current.filter((one) => one.key !== row.key))}
                  >
                    <Trash2 aria-hidden="true" />
                    {t("openTimes.remove")}
                  </Button>
                </div>
                {fault ? <p className="text-xs text-destructive">{t("openTimes.spanFault", { n, fault })}</p> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {tooMany ? <p className="text-sm text-destructive">{t("openTimes.tooMany", { max: SPANS_MAX })}</p> : null}
      <p className="text-sm text-muted-foreground">{t("openTimes.merged")}</p>
      <div className="flex flex-wrap items-center gap-2" data-writes="SCHEMALAGGNING">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!may || rows.length >= SPANS_MAX}
          onClick={() => setRows((current) => [...current, { key: next(), dayOfWeek: "1", start: "08:00", end: "12:00" }])}
        >
          <Plus aria-hidden="true" />
          {t("openTimes.add")}
        </Button>
        <Button type="submit" disabled={!may || !dirty || faults.some(Boolean) || tooMany || setOpenTimes.isPending}>
          {setOpenTimes.isPending ? tCommon("saving") : t("openTimes.save")}
        </Button>
        {dirty ? <span className="text-sm text-muted-foreground">{t("openTimes.unsaved")}</span> : null}
      </div>
      {!may ? <p className="text-sm">{why}</p> : null}
    </form>
  );
}
