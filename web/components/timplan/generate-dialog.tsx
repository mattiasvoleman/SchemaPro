"use client";

// "Skapa timplansposter": the plan's minutes per week as the posts a läsår's
// classes are missing (POST /local-timplans/:id/generate-requirements).
//
// PREVIEW FIRST, ALWAYS. The admin picks the läsår and a lesson length and
// asks for a preview (dryRun true): which posts would be created — class,
// subject, the plan's target, lessons × minutes and what that leaves over —
// and which pairs are skipped because the year already has a post for them.
// Nothing can be created without a preview of the same year and length on
// screen; changing either throws the preview away.
//
// WHAT THE GATEWAY DECIDES AND WHAT THE ADMIN MAY CHANGE. The proposal is the
// gateway's: ceil(minutes / length) lessons, capped at 40, for every CLASS of
// the year whose årskurs follows this plan; teaching groups are never
// generated, nothing existing is updated, no teacher is set. A row's lessons
// and minutes may be edited before applying — sent as overrides, the rows the
// admin changed and only those — within the bounds the requirements form
// itself keeps (1–40 lessons, 15–240 minutes on the five-minute grid).
//
// APPLY IS IDEMPOTENT. A second apply creates nothing; a post somebody saved
// between the preview and the apply is passed by and reported as skipped.
//
// THE SUGGESTED LENGTH is the one the year's posts use most, else 60: the
// schema has no school default, and the length a school already writes in is
// the better guess.
//
// LEKTIONSLÄNGDER. "Dela upp resten" (remainder SPLIT) proposes 175 minutes
// at 60 as 2 × 60 + 1 × 55 rather than 3 × 60 and five minutes over, the wall
// a grundskola meets first. It starts UNCHECKED, and unchecked the request
// carries no `remainder` at all: a school that never asks for a second length
// sends the body it always sent and gets the answer it always got, rows
// included. Checked, it sends SPLIT. A row SPLIT made into something other
// than whole lessons of the chosen length (remainderChanged: a split row, but
// also 45 at 60 as 1 × 45) is shown read-only as its lengths, counted in the
// note above the table, and offers one edit, "Gör enhetlig", which turns it
// into the round-up post at the chosen length (sent as an ordinary uniform
// override) and can be undone; splitting a post differently is the
// Timplansposter dialog's job once it exists. Focus follows those two
// buttons: each replaces itself, so focus moves to what took its place.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { useRequirements } from "@/lib/queries";
import { useGenerateRequirements } from "@/lib/timplan-queries";
import {
  editedRow,
  lessonLengthProblem,
  overridesFrom,
  existingCount,
  remainderChanged,
  rowKey,
  suggestLessonLength,
  uniformEdit,
  type GenerateRequirementsResponse,
  type Remainder,
  type RowEdit,
} from "@/lib/timplan-generate";
import { formatLengths } from "@/lib/lesson-lengths-text";
import { signedMinutes } from "@/lib/timplan-tackning";
import type { AcademicYear } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface GenerateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plan: { id: string; name: string; status: "DRAFT" | "DECIDED" };
  years: readonly AcademicYear[];
  /** The year the dialog starts on; the active one when null. */
  initialYearId: string | null;
}

const grade = (t: (key: string, values?: Record<string, string>) => string, value: number) =>
  t("grade", { grade: String(value) });

export function GenerateDialog({ open, onOpenChange, plan, years, initialYearId }: GenerateDialogProps) {
  const t = useTranslations("timplan.generate");
  const tCommon = useTranslations("common");

  // Derived, not frozen at mount, as in the year dialog: the years may
  // arrive after the dialog opened.
  const [chosenYearId, setYearId] = useState<string | null>(null);
  const yearId =
    chosenYearId ?? initialYearId ?? years.find((year) => year.isActive)?.id ?? years[0]?.id ?? null;
  const year = years.find((entry) => entry.id === yearId) ?? null;
  const requirements = useRequirements(yearId);
  const generate = useGenerateRequirements();

  const suggested = useMemo(() => suggestLessonLength(requirements.data ?? []), [requirements.data]);
  // Null until the admin types: the field shows the suggestion, which may
  // still change as the year's posts arrive.
  const [typedLength, setTypedLength] = useState<string | null>(null);
  const lengthText = typedLength ?? String(suggested);
  const lengthProblem = lessonLengthProblem(lengthText);
  const length = lengthProblem === null ? Number(lengthText.trim()) : null;

  const [split, setSplit] = useState(false);
  const remainder: Remainder = split ? "SPLIT" : "ROUND_UP";
  const [preview, setPreview] = useState<GenerateRequirementsResponse | null>(null);
  const [edits, setEdits] = useState<Map<string, RowEdit>>(new Map());
  const [result, setResult] = useState<GenerateRequirementsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A preview belongs to the year, length and remainder it was asked for.
  const current =
    preview &&
    preview.academicYearId === yearId &&
    preview.minutesPerLesson === length &&
    preview.remainder === remainder
      ? preview
      : null;
  const overrides = current ? overridesFrom(current.rows, edits) : null;
  const classCount = current ? new Set(current.rows.map((row) => row.studentGroupId)).size : 0;

  const fail = (caught: unknown) =>
    setError(caught instanceof Error && caught.message ? caught.message : tCommon("error"));

  const askPreview = async () => {
    if (!yearId || length === null) return;
    setError(null);
    try {
      const answer = await generate.mutateAsync({
        planId: plan.id,
        academicYearId: yearId,
        minutesPerLesson: length,
        ...(split ? { remainder } : {}),
        dryRun: true,
      });
      // Kept with the remainder it was asked for, so a toggle discards it
      // whether or not the gateway echoes the field.
      setPreview({ ...answer, remainder });
      setEdits(new Map());
    } catch (caught) {
      fail(caught);
    }
  };

  const apply = async () => {
    if (!current || !yearId || length === null || overrides === null) return;
    setError(null);
    try {
      const answer = await generate.mutateAsync({
        planId: plan.id,
        academicYearId: yearId,
        minutesPerLesson: length,
        ...(split ? { remainder } : {}),
        dryRun: false,
        ...(overrides.length > 0 ? { overrides } : {}),
      });
      setResult(answer);
      setPreview(null);
      setEdits(new Map());
    } catch (caught) {
      fail(caught);
    }
  };

  const close = (next: boolean) => {
    if (generate.isPending) return;
    if (!next) {
      setPreview(null);
      setEdits(new Map());
      setResult(null);
      setError(null);
      setTypedLength(null);
      setSplit(false);
    }
    onOpenChange(next);
  };

  const editRow = (key: string, base: RowEdit, patch: Partial<RowEdit>) => {
    const next = new Map(edits);
    next.set(key, { ...(edits.get(key) ?? base), ...patch });
    setEdits(next);
  };
  /** "Dela upp igen": a split row's edit thrown away, back to the gateway's proposal. */
  const resetRow = (key: string) => {
    const next = new Map(edits);
    next.delete(key);
    setEdits(next);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("body", { plan: plan.name })}</DialogDescription>
        </DialogHeader>

        {result ? (
          <div role="status" className="space-y-2 rounded-md bg-muted px-4 py-3 text-sm text-foreground">
            <p className="font-medium">
              {t("resultCreated", { count: result.created, year: years.find((y) => y.id === result.academicYearId)?.name ?? "" })}
            </p>
            {existingCount(result) > 0 ? <p>{t("resultSkipped", { count: existingCount(result) })}</p> : null}
            <p>{t("resultNext")}</p>
            <Link
              href={`/admin/requirements?year=${encodeURIComponent(result.academicYearId)}`}
              className="font-medium underline underline-offset-2"
            >
              {t("openRequirements")}
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t("yearLabel")}</Label>
                {years.length > 0 ? (
                  <Select value={yearId ?? undefined} onValueChange={setYearId} disabled={generate.isPending}>
                    <SelectTrigger aria-label={t("yearLabel")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {years.map((entry) => (
                        <SelectItem key={entry.id} value={entry.id}>
                          {entry.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <p className="text-sm text-foreground">{t("noYears")}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="generate-length">{t("lengthLabel")}</Label>
                <Input
                  id="generate-length"
                  inputMode="numeric"
                  className="w-28"
                  value={lengthText}
                  aria-invalid={lengthProblem !== null || undefined}
                  aria-describedby="generate-length-hint"
                  disabled={generate.isPending}
                  onChange={(event) => setTypedLength(event.target.value)}
                />
                <p
                  id="generate-length-hint"
                  className={lengthProblem ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
                >
                  {lengthProblem
                    ? t(`length.${lengthProblem}`)
                    : (requirements.data ?? []).length > 0
                      ? t("lengthHintCommon", { minutes: suggested })
                      : t("lengthHintDefault", { minutes: suggested })}
                </p>
              </div>
            </div>

            <div className="space-y-1">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  className="size-4 accent-primary"
                  checked={split}
                  disabled={generate.isPending}
                  aria-describedby="generate-split-hint"
                  onChange={(event) => setSplit(event.target.checked)}
                />
                {t("splitLabel")}
              </label>
              <p id="generate-split-hint" className="text-xs text-muted-foreground">
                {t(split ? "splitHint" : "roundUpHint")}
              </p>
            </div>

            {plan.status === "DRAFT" ? (
              <p className="rounded-md border-l-4 border-l-warning bg-muted px-3 py-2 text-sm text-foreground">
                {t("draft")}
              </p>
            ) : null}

            <Button
              variant="outline"
              onClick={() => void askPreview()}
              disabled={!year || length === null || generate.isPending}
            >
              {generate.isPending && !current ? t("previewing") : current ? t("previewAgain") : t("preview")}
            </Button>

            {current && length !== null ? <PreviewBody preview={current} edits={edits} classCount={classCount} length={length} onEdit={editRow} onReset={resetRow} yearName={year?.name ?? ""} planName={plan.name} /> : null}
            {current && overrides === null ? (
              <p role="alert" className="text-sm text-destructive">
                {t("invalidRows")}
              </p>
            ) : null}
          </div>
        )}

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          {result ? (
            <Button onClick={() => close(false)}>{t("close")}</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => close(false)} disabled={generate.isPending}>
                {tCommon("cancel")}
              </Button>
              <Button
                onClick={() => void apply()}
                disabled={!current || current.rows.length === 0 || overrides === null || generate.isPending}
              >
                {generate.isPending && current
                  ? t("applying")
                  : t("apply", { count: current?.rows.length ?? 0 })}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface PreviewBodyProps {
  preview: GenerateRequirementsResponse;
  edits: ReadonlyMap<string, RowEdit>;
  classCount: number;
  /** The length the preview was asked for: what "Gör enhetlig" writes. */
  length: number;
  yearName: string;
  planName: string;
  onEdit: (key: string, base: RowEdit, patch: Partial<RowEdit>) => void;
  onReset: (key: string) => void;
}

function PreviewBody({ preview, edits, classCount, length, yearName, planName, onEdit, onReset }: PreviewBodyProps) {
  const t = useTranslations("timplan.generate");

  // Rows whose shape SPLIT changed and the admin has not made uniform: what
  // the note counts and what the footer's sentence describes.
  const changedRows = preview.rows.filter(
    (row) => remainderChanged(row, length) && !edits.has(rowKey(row)),
  ).length;

  // "Gör enhetlig" and "Dela upp igen" each unmount the button pressed. Focus
  // goes to what replaced it in the same row — the lessons field, or the
  // "Gör enhetlig" button back — instead of falling to the dialog itself.
  const tableRef = useRef<HTMLTableElement>(null);
  const [focusNext, setFocusNext] = useState<string | null>(null);
  useEffect(() => {
    if (focusNext === null) return;
    const target = Array.from(tableRef.current?.querySelectorAll<HTMLElement>("[data-focus]") ?? []).find(
      (element) => element.dataset.focus === focusNext,
    );
    target?.focus();
    setFocusNext(null);
  }, [focusNext, edits]);

  if (preview.gradeLevels.length === 0) {
    return (
      <p role="status" className="rounded-md bg-muted px-3 py-2 text-sm text-foreground">
        {t("noGrades", { year: yearName, plan: planName })}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <p role="status" className="text-sm font-medium text-foreground">
        {preview.rows.length === 0
          ? t("nothingToCreate", { skipped: preview.skipped.length })
          : t("summary", {
              rows: preview.rows.length,
              classes: classCount,
              skipped: existingCount(preview),
              grades: preview.gradeLevels.map((value) => grade(t, value)).join(", "),
            })}
      </p>
      {changedRows > 0 ? (
        <p className="text-sm text-foreground">{t("splitNote", { count: changedRows })}</p>
      ) : null}
      {preview.skipped.some((row) => row.reason === "ALTERNATIVE") ? (
        <p className="text-sm text-foreground">{t("alternativesNote")}</p>
      ) : null}

      {preview.rows.length > 0 ? (
        <div className="max-h-[45vh] overflow-auto rounded-md border">
          <table ref={tableRef} className="w-full text-sm">
            <caption className="sr-only">{t("tableCaption")}</caption>
            <thead className="sticky top-0 bg-card">
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th scope="col" className="px-3 py-2 font-medium">{t("classColumn")}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t("subjectColumn")}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{t("targetColumn")}</th>
                <th scope="col" className="px-3 py-2 font-medium">{t("lessonsColumn")}</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">{t("surplusColumn")}</th>
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row) => {
                const key = rowKey(row);
                const base: RowEdit = { lessons: String(row.lessonsPerWeek), minutes: String(row.minutesPerLesson) };
                const edit = edits.get(key);
                const shown = edit ?? base;
                const edited = editedRow(row, edit);
                const label = `${row.groupName} ${row.subjectName}`;
                // A row SPLIT changed that the admin has not made uniform: its
                // lengths, read-only, and the one edit it offers.
                const changed = remainderChanged(row, length);
                const splitShown = changed && edit === undefined;
                return (
                  <tr key={key} className="border-b last:border-b-0">
                    <th scope="row" className="px-3 py-1.5 text-left font-medium">{row.groupName}</th>
                    <td className="px-3 py-1.5">{row.subjectName}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{row.targetMinutesPerWeek}</td>
                    <td className="px-3 py-1.5">
                      {splitShown ? (
                        <div className="flex items-center gap-2">
                          <span className="tabular-nums">{formatLengths(row)}</span>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            aria-label={t("makeUniformFor", { row: label })}
                            data-focus={`uniform:${key}`}
                            onClick={() => {
                              onEdit(key, base, uniformEdit(row, length));
                              setFocusNext(`lessons:${key}`);
                            }}
                          >
                            {t("makeUniform")}
                          </Button>
                        </div>
                      ) : (
                      <div className="flex items-center gap-1">
                        <Input
                          inputMode="numeric"
                          className="h-8 w-14"
                          value={shown.lessons}
                          aria-label={t("lessonsFor", { row: label })}
                          data-focus={`lessons:${key}`}
                          aria-invalid={edited.lessons === null || undefined}
                          onChange={(event) => onEdit(key, base, { lessons: event.target.value })}
                        />
                        <span aria-hidden>×</span>
                        <Input
                          inputMode="numeric"
                          className="h-8 w-16"
                          value={shown.minutes}
                          aria-label={t("minutesFor", { row: label })}
                          aria-invalid={edited.minutes === null || undefined}
                          onChange={(event) => onEdit(key, base, { minutes: event.target.value })}
                        />
                        {edited.changed ? <Badge variant="outline">{t("edited")}</Badge> : null}
                        {changed ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-xs"
                            aria-label={t("splitAgainFor", { row: label })}
                            onClick={() => {
                              onReset(key);
                              setFocusNext(`uniform:${key}`);
                            }}
                          >
                            {t("splitAgain")}
                          </Button>
                        ) : null}
                      </div>
                      )}
                    </td>
                    <td
                      className={cn(
                        "px-3 py-1.5 text-right tabular-nums",
                        edited.surplus !== null && edited.surplus < 0 && "font-medium text-warning-foreground dark:text-warning",
                      )}
                    >
                      {edited.surplus === null ? "–" : signedMinutes(edited.surplus)}
                      {row.capped && !edited.changed ? <span className="ml-1 text-xs">{t("capped")}</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {preview.skipped.length > 0 ? (
        <details className="rounded-md border px-3 py-2 text-sm">
          <summary className="cursor-pointer font-medium">{t("skippedTitle", { count: preview.skipped.length })}</summary>
          <ul className="mt-2 space-y-0.5 text-foreground">
            {preview.skipped.map((row) => (
              <li key={rowKey(row)}>
                {row.reason === "EXISTS"
                  ? t("skippedRow", { group: row.groupName, subject: row.subjectName })
                  : row.alternativeTo === null
                    ? t("skippedLanguage", { group: row.groupName, subject: row.subjectName })
                    : t("skippedAlternative", {
                        group: row.groupName,
                        subject: row.subjectName,
                        other: row.alternativeTo,
                      })}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {t(changedRows > 0 ? "surplusHintSplit" : "surplusHint")}
      </p>
    </div>
  );
}
