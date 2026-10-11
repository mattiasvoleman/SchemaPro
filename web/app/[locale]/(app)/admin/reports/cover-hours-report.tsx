"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { CalendarClock, Download, Loader2 } from "lucide-react";
import type { MessageLookup } from "@/lib/engine-message";
import { useProfile } from "@/components/profile-context";
import { useGroups, usePeople, useRooms, useSubjects } from "@/lib/queries";
import { useCoverHours } from "@/lib/cover-queries";
import type { Hours } from "@/lib/cover-types";
import { coverErrorText } from "@/lib/cover-view";
import { shiftDate } from "@/lib/cover-absence-form";
import { toDateString } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar, FilterField } from "@/components/ui/filter-bar";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCard } from "@/components/ui/table-card";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** The calendar month before `today`: the payroll period most schools report. */
export function lastMonth(today: string): { from: string; to: string } {
  const first = `${today.slice(0, 7)}-01`;
  const to = shiftDate(first, -1);
  return { from: `${to.slice(0, 7)}-01`, to };
}

/** Days from `from` to `to` inclusive. */
const span = (from: string, to: string) =>
  Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000) + 1;

const MAX_DAYS = 93;

/** 08:00 on the school's clock, as the payroll file writes it. */
const clockIn = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("sv-SE", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));

/** A cover's calendar day (yyyy-mm-dd) in the reader's language, read at UTC midnight so no zone moves it. */
const dayIn = (date: string, locale: string) =>
  new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${date}T00:00:00.000Z`),
  );

/**
 * Vikarietimmar (`/admin/reports?tab=cover`): per substitute and period, the
 * held covers and their minutes — Fas 3's delivered credit to the SUBSTITUTE
 * row, in clock minutes — and the covers booked but not yet held, which are
 * shown and never exported.
 *
 * Two CSV files for payroll, built on click (lib/cover-hours-export.ts is an
 * import() away). Neither names the replaced teacher, the absence or a
 * reason: payroll needs who worked when.
 *
 * A cover the calendar credits to a substitute who was themself registered
 * away then is not in the files: it is listed under the table for the admin
 * to check (and correct in the calendar), with the lesson only.
 */
export function CoverHoursReport() {
  const t = useTranslations("coverHours");
  const tErrors = useTranslations("coverErrors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const { school } = useProfile();
  const initial = lastMonth(toDateString(new Date()));
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const valid = Boolean(from && to && to >= from && span(from, to) <= MAX_DAYS);
  const { data: hours, isLoading, isError } = useCoverHours(from, to, valid);
  const { data: people } = usePeople();
  const { data: subjects } = useSubjects();
  const { data: groups } = useGroups();
  const { data: rooms } = useRooms();
  const [exporting, setExporting] = useState(false);

  const personOf = useMemo(() => new Map((people ?? []).map((person) => [person.id, person])), [people]);
  const nameOf = (id: string) => {
    const person = personOf.get(id);
    return person ? `${person.firstName} ${person.lastName}` : "—";
  };
  const planned = new Map((hours?.planned ?? []).map((line) => [line.userId, line]));
  const summary = [...(hours?.summary ?? [])].sort((a, b) => nameOf(a.userId).localeCompare(nameOf(b.userId), locale));
  const toCheck = hours?.toCheck ?? [];
  const timezone = school?.timezone ?? "Europe/Stockholm";
  const subjectOf = new Map((subjects ?? []).map((s) => [s.id, s.name]));
  const groupOf = new Map((groups ?? []).map((g) => [g.id, g.name]));
  const total = summary.reduce((sum, line) => sum + line.minutes, 0);

  const download = async (data: Hours, kind: "lektioner" | "summering") => {
    setExporting(true);
    try {
      const [exports, { downloadCsv }] = await Promise.all([
        import("@/lib/cover-hours-export"),
        import("@/lib/csv-export"),
      ]);
      const subjectName = new Map((subjects ?? []).map((s) => [s.id, s.name]));
      const groupName = new Map((groups ?? []).map((g) => [g.id, g.name]));
      const roomName = new Map((rooms ?? []).map((r) => [r.id, r.name]));
      const names = {
        person: (id: string) => {
          const person = personOf.get(id);
          return person ? { name: `${person.firstName} ${person.lastName}`, email: person.email } : null;
        },
        subject: (id: string) => subjectName.get(id) ?? "",
        group: (id: string) => groupName.get(id) ?? "",
        room: (id: string | null) => (id ? (roomName.get(id) ?? "") : ""),
        timezone: school?.timezone ?? "Europe/Stockholm",
      };
      const csv = kind === "lektioner" ? exports.hoursLessonsCsv(data, names) : exports.hoursSummaryCsv(data, names);
      downloadCsv(exports.hoursFilename(kind, data.from, data.to), csv);
    } catch (failure) {
      toast.error(coverErrorText(tErrors, failure, tCommon("error")));
    } finally {
      setExporting(false);
    }
  };

  const hoursOf = (minutes: number) => (minutes / 60).toLocaleString(locale, { maximumFractionDigits: 2 });

  return (
    <div className="space-y-4">
      <p className="max-w-prose text-sm text-muted-foreground">{t("intro")}</p>
      <FilterBar>
        <FilterField id="hours-from" label={tCommon("from")}>
          <DateField id="hours-from" label={tCommon("from")} className="w-40" value={from} onChange={setFrom} />
        </FilterField>
        <FilterField id="hours-to" label={tCommon("to")}>
          <DateField id="hours-to" label={tCommon("to")} className="w-40" value={to} min={from} onChange={setTo} />
        </FilterField>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!hours || exporting || hours.rows.length === 0}
            onClick={() => hours && void download(hours, "lektioner")}
          >
            {exporting ? <Loader2 className="animate-spin" /> : <Download />}
            {t("exportLessons")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!hours || exporting || hours.summary.length === 0}
            onClick={() => hours && void download(hours, "summering")}
          >
            <Download />
            {t("exportSummary")}
          </Button>
        </div>
      </FilterBar>
      {!valid ? (
        <Notice tone="destructive">{t("rangeError", { days: MAX_DAYS })}</Notice>
      ) : isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : isError ? (
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      ) : summary.length === 0 && planned.size === 0 ? (
        <EmptyState icon={CalendarClock} title={t("emptyTitle")} description={t("emptyHint")} headingLevel={2} />
      ) : (
        <div className="space-y-2">
          <TableCard caption={t("tableCaption")}>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{t("columnSubstitute")}</TableHead>
                <TableHead scope="col">{t("columnKind")}</TableHead>
                <TableHead scope="col" className="text-right">{t("columnLessons")}</TableHead>
                <TableHead scope="col" className="text-right">{t("columnMinutes")}</TableHead>
                <TableHead scope="col" className="text-right">{t("columnHours")}</TableHead>
                <TableHead scope="col" className="text-right">{t("columnPlanned")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summary.map((line) => (
                <TableRow key={line.userId}>
                  <TableCell className="font-medium">{nameOf(line.userId)}</TableCell>
                  <TableCell>
                    <Badge variant={line.kind === "POOL" ? "secondary" : "outline"}>{t(`kinds.${line.kind}`)}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{line.lessons}</TableCell>
                  <TableCell className="text-right tabular-nums">{line.minutes}</TableCell>
                  <TableCell className="text-right tabular-nums">{hoursOf(line.minutes)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {planned.get(line.userId)?.lessons ?? 0}
                  </TableCell>
                </TableRow>
              ))}
              {(hours?.planned ?? [])
                .filter((line) => !summary.some((held) => held.userId === line.userId))
                .map((line) => (
                  <TableRow key={`planned-${line.userId}`}>
                    <TableCell className="font-medium">{nameOf(line.userId)}</TableCell>
                    <TableCell />
                    <TableCell className="text-right tabular-nums">0</TableCell>
                    <TableCell className="text-right tabular-nums">0</TableCell>
                    <TableCell className="text-right tabular-nums">0</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{line.lessons}</TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </TableCard>
          <p className="text-sm text-muted-foreground">{t("total", { minutes: total, hours: hoursOf(total) })}</p>
        </div>
      )}
      {toCheck.length > 0 ? (
        // A region of its own, named, for the payroll check; not live — it
        // arrives with the figures, and a list read out on load helps no one.
        <section aria-label={t("toCheckTitle")}>
          <Notice tone="warning" role={null} title={t("toCheckTitle")}>
            <div className="space-y-2">
              <p>{t("toCheckBody", { count: toCheck.length })}</p>
              <ul className="space-y-0.5">
                {toCheck.map((row) => (
                  <li key={`${row.lessonId}:${row.userId}`} className="tabular-nums">
                    {[
                      nameOf(row.userId),
                      `${dayIn(row.date, locale)} ${clockIn(row.startsAt, timezone)}–${clockIn(row.endsAt, timezone)}`,
                      subjectOf.get(row.subjectId) ?? "",
                      groupOf.get(row.studentGroupId) ?? "",
                    ].join(" · ")}
                  </li>
                ))}
              </ul>
            </div>
          </Notice>
        </section>
      ) : null}
      <p className="text-xs text-muted-foreground">{t("privacy")}</p>
    </div>
  );
}
