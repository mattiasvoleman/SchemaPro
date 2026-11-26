"use client";

// Skolans kalender: the red days, a proposal for the year's lov and a municipality's file, measured against the lov
// the school has and saved in one write (P4).
//
// NOTHING IS SAVED BEFORE IT IS SHOWN. Every source fills the same preview table, each row says what it would do
// (Ny, Finns redan, Flyttas, Ligger inom, Utanför läsåret, Bara helg), and the count under it is the gateway's own:
// a dry run of the write, so "42 lektioner tas bort" is the number the save then answers with, not a guess made
// here. A lov deletes published lessons and cannot give them back, which is the reason the count is asked and not
// left to be read after.
//
// WHAT IS ALREADY THERE IS NEVER REMOVED, and a lov the school has is moved only when its row is ticked: a file that
// lacks one of the school's lov says so under the table and leaves it be.
//
// Fetched with lazy() the first time it opens; the page carries none of it. Text is `foreground` throughout, as on
// the rest of the breaks page (its header records the measurements).
import { useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Upload } from "lucide-react";
import {
  calendarBody,
  diffCalendar,
  holidayEntries,
  proposeYearBreaks,
  savableRows,
  HOSTLOV_WEEK,
  SPORTLOV_WEEK,
  type CalendarEntry,
  type DiffRow,
} from "@/lib/school-calendar";
import { readCalendarFile, type CalendarFile } from "@/lib/school-calendar-file";
import { decodeCsvBytes } from "@/lib/csv-encoding";
import {
  useApplySchoolCalendar,
  useSchoolCalendarCount,
  type SchoolCalendarResult,
} from "@/lib/school-calendar-queries";
import type { AcademicYear, SchoolBreak } from "@/lib/types";
import { apiErrorText } from "@/lib/api-error-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface SchoolCalendarDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  year: Pick<AcademicYear, "id" | "name" | "startDate" | "endDate">;
  /** The year's lov as the page holds them. */
  breaks: SchoolBreak[];
  /** What a save answered with, for the page's own live region. */
  onSaved: (result: SchoolCalendarResult) => void;
}

/** A file's bytes as text: an ICS is UTF-8 by RFC 5545, a CSV is read by its encoding like every other import. */
async function readFileText(file: File): Promise<string | { problem: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (/\.ics$/i.test(file.name) || file.type === "text/calendar") return new TextDecoder("utf-8").decode(bytes);
  const decoded = decodeCsvBytes(bytes);
  return decoded.problem === null ? decoded.text : { problem: decoded.problem };
}

export function SchoolCalendarDialog({ open, onOpenChange, year, breaks, onSaved }: SchoolCalendarDialogProps) {
  const t = useTranslations("breaks");
  const tc = useTranslations("breaks.calendar");
  const tCommon = useTranslations("common");
  const fileInput = useRef<HTMLInputElement>(null);

  const holidays = useMemo(() => holidayEntries(year), [year]);
  const proposals = useMemo(() => proposeYearBreaks(year), [year]);

  const [withHolidays, setWithHolidays] = useState(true);
  // A year with no lov at all is the first one: the proposals are what it needs, and are on from the start.
  const [withProposals, setWithProposals] = useState(breaks.length === 0);
  const [file, setFile] = useState<{ name: string; read: CalendarFile } | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  /** A row the admin ticked or unticked; a row not here is ticked, unless it reads as a term date. */
  const [choices, setChoices] = useState<Record<string, boolean>>({});

  const entries = useMemo<CalendarEntry[]>(
    () => [...(file?.read.entries ?? []), ...(withProposals ? proposals : []), ...(withHolidays ? holidays : [])],
    [file, withProposals, proposals, withHolidays, holidays],
  );
  const diff = useMemo(() => diffCalendar(entries, breaks, year), [entries, breaks, year]);

  const isTicked = (row: DiffRow): boolean => choices[row.entry.key] ?? !row.entry.looksLikeTermDate;
  const ticked = useMemo(
    () => new Set(diff.rows.filter((row) => (choices[row.entry.key] ?? !row.entry.looksLikeTermDate)).map((row) => row.entry.key)),
    [diff, choices],
  );
  const toSave = useMemo(() => savableRows(diff, ticked), [diff, ticked]);
  const body = useMemo(() => calendarBody(year.id, toSave, true), [year.id, toSave]);
  const count = useSchoolCalendarCount(body, open && toSave.length > 0);
  const apply = useApplySchoolCalendar();

  const chooseFile = async (chosen: File | undefined) => {
    if (!chosen) return;
    setChoices({});
    const text = await readFileText(chosen);
    if (typeof text !== "string") {
      setFile(null);
      setFileProblem(text.problem);
      return;
    }
    setFileProblem(null);
    setFile({ name: chosen.name, read: readCalendarFile(text, chosen.name) });
  };

  const dropFile = () => {
    setFile(null);
    setFileProblem(null);
    setChoices({});
    if (fileInput.current) fileInput.current.value = "";
  };

  const save = async () => {
    try {
      const result = await apply.mutateAsync(calendarBody(year.id, toSave, false));
      toast.success(tc("saved", { count: result.created + result.updated }));
      onSaved(result);
      onOpenChange(false);
    } catch (error) {
      toast.error(apiErrorText(error, tCommon));
    }
  };

  const rangeLabel = (entry: CalendarEntry) =>
    entry.startDate === entry.endDate ? entry.startDate : `${entry.startDate} – ${entry.endDate}`;
  const gradeLabel = (entry: CalendarEntry) =>
    entry.minGradeLevel === null || entry.maxGradeLevel === null
      ? t("gradeAll")
      : t("gradeRange", { min: entry.minGradeLevel, max: entry.maxGradeLevel });

  const statusText = (row: DiffRow): string => {
    switch (row.status) {
      case "CHANGED":
        return tc("status.CHANGED", {
          range: row.existing ? (row.existing.startDate === row.existing.endDate ? row.existing.startDate : `${row.existing.startDate} – ${row.existing.endDate}`) : "",
        });
      case "COVERED":
        return tc("status.COVERED", { name: row.coveredBy?.name ?? row.existing?.name ?? "" });
      default:
        return tc(`status.${row.status}`);
    }
  };

  const placeText = (place: number) => (file?.read.format === "ICS" ? tc("placeEvent", { n: place }) : tc("placeRow", { n: place }));
  const problemText = (problem: CalendarFile["problems"][number]): string =>
    problem.place === 0
      ? tc(`problem.${problem.code}`, { value: problem.value ?? "" })
      : `${placeText(problem.place)}: ${tc(`problem.${problem.code}`, { value: problem.value ?? "" })}`;

  const savable = toSave.length;
  const lessons = count.data?.removedCalendarLessons;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{tc("title")}</DialogTitle>
          <DialogDescription className="leading-relaxed text-foreground">
            {tc("description", { year: year.name })}
          </DialogDescription>
        </DialogHeader>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">{tc("sources")}</legend>

          <div className="flex items-start gap-3">
            <input
              id="calendar-holidays"
              type="checkbox"
              className="mt-1 size-4 accent-primary"
              checked={withHolidays}
              onChange={(event) => setWithHolidays(event.target.checked)}
            />
            <label htmlFor="calendar-holidays" className="text-sm leading-relaxed">
              <span className="font-medium">{tc("holidays")}</span>
              <span className="block">{tc("holidaysHint", { count: holidays.length })}</span>
            </label>
          </div>

          <div className="flex items-start gap-3">
            <input
              id="calendar-proposals"
              type="checkbox"
              className="mt-1 size-4 accent-primary"
              checked={withProposals}
              onChange={(event) => setWithProposals(event.target.checked)}
            />
            <label htmlFor="calendar-proposals" className="text-sm leading-relaxed">
              <span className="font-medium">{tc("proposals")}</span>
              <span className="block">{tc("proposalsHint", { autumn: HOSTLOV_WEEK, spring: SPORTLOV_WEEK })}</span>
            </label>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">{tc("file")}</p>
            <p className="text-sm leading-relaxed">{tc("fileHint")}</p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileInput}
                id="calendar-file"
                type="file"
                accept=".ics,.csv,.txt,text/calendar,text/csv,text/plain"
                className="sr-only"
                aria-label={tc("chooseFile")}
                onChange={(event) => void chooseFile(event.target.files?.[0])}
              />
              <Button type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
                <Upload aria-hidden="true" />
                {file ? tc("changeFile") : tc("chooseFile")}
              </Button>
              {file ? (
                <>
                  <span className="text-sm">{tc("fileRead", { name: file.name, format: file.read.format, count: file.read.entries.length })}</span>
                  <Button type="button" variant="ghost" size="sm" onClick={dropFile}>
                    {tc("removeFile")}
                  </Button>
                </>
              ) : null}
            </div>
            {fileProblem ? (
              <Notice role="alert" className="leading-relaxed">
                {tc("fileUnreadable", { problem: fileProblem })}
              </Notice>
            ) : null}
            {file && file.read.problems.length > 0 ? (
              <Notice role="status" title={tc("problemsTitle", { count: file.read.problems.length })} className="leading-relaxed">
                <ul className="list-disc space-y-0.5 pl-5">
                  {file.read.problems.slice(0, 8).map((problem, index) => (
                    <li key={index}>{problemText(problem)}</li>
                  ))}
                  {file.read.problems.length > 8 ? <li>{tc("problemsMore", { count: file.read.problems.length - 8 })}</li> : null}
                </ul>
              </Notice>
            ) : null}
          </div>
        </fieldset>

        <section aria-labelledby="calendar-preview" className="space-y-2">
          <h3 id="calendar-preview" className="text-sm font-semibold">
            {tc("preview")}
          </h3>
          {diff.rows.length === 0 ? (
            <p className="text-sm leading-relaxed">{tc("nothingChosen")}</p>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">{tc("previewCaption")}</caption>
                <thead>
                  <tr className="border-b">
                    <th scope="col" className="w-10 p-2">
                      <span className="sr-only">{tc("colTick")}</span>
                    </th>
                    <th scope="col" className="p-2">{tCommon("name")}</th>
                    <th scope="col" className="p-2">{tCommon("date")}</th>
                    <th scope="col" className="p-2">{t("gradeSpan")}</th>
                    <th scope="col" className="p-2">{tc("colStatus")}</th>
                  </tr>
                </thead>
                <tbody>
                  {diff.rows.map((row) => {
                    const canTick = row.status === "NEW" || row.status === "CHANGED";
                    const id = `calendar-row-${row.entry.key}`;
                    return (
                      <tr key={row.entry.key} className="border-b last:border-b-0 align-top">
                        <td className="p-2">
                          <input
                            id={id}
                            type="checkbox"
                            className="size-4 accent-primary"
                            checked={canTick && isTicked(row)}
                            disabled={!canTick}
                            onChange={(event) => setChoices((current) => ({ ...current, [row.entry.key]: event.target.checked }))}
                          />
                        </td>
                        <td className="p-2">
                          <label htmlFor={id} className="font-medium">
                            {row.entry.name}
                          </label>
                          {row.entry.kind === "STAFF_DAY" ? (
                            <Badge variant="outline" className="ml-2">
                              {t("kindStaffDay")}
                            </Badge>
                          ) : null}
                          {row.entry.looksLikeTermDate ? <span className="block text-xs leading-relaxed">{tc("termDate")}</span> : null}
                          {row.overlaps.length > 0 ? (
                            <span className="block text-xs leading-relaxed">{tc("overlaps", { names: row.overlaps.map((lov) => lov.name).join(", ") })}</span>
                          ) : null}
                        </td>
                        <td className="whitespace-nowrap p-2 tabular-nums">{rangeLabel(row.entry)}</td>
                        <td className="p-2">{gradeLabel(row.entry)}</td>
                        <td className="p-2">
                          <Badge variant={row.status === "NEW" || row.status === "CHANGED" ? "secondary" : "outline"}>{statusText(row)}</Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {file && diff.onlyHere.length > 0 ? (
            <p className="text-sm leading-relaxed">{tc("onlyHere", { names: diff.onlyHere.map((lov) => lov.name).join(", ") })}</p>
          ) : null}
        </section>

        <div role="status" aria-live="polite" aria-atomic="true" className="min-h-6 text-sm leading-relaxed">
          {savable === 0 ? (
            diff.rows.length > 0 ? tc("nothingToAdd") : null
          ) : count.isPending ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {tc("counting")}
            </span>
          ) : count.isError ? (
            tc("countFailed", { count: savable })
          ) : (
            tc("willSave", { count: savable, lessons: lessons ?? 0 })
          )}
        </div>
        {savable > 0 && (lessons ?? 0) > 0 ? (
          <Notice role={null} className="leading-relaxed">
            {t("deletesWarning")}
          </Notice>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {tCommon("cancel")}
          </Button>
          <Button type="button" onClick={() => void save()} disabled={savable === 0 || apply.isPending} data-writes="PLANERING DRIFT">
            {apply.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {tc("save", { count: savable })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
