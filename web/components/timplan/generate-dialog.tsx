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
//
// SPRÅKVAL AS A BLOCK. Once a preview has said which årskurser the year
// follows this plan in, each M2 language of those årskurser offers a choice
// of the year's teaching groups — as many as read it, 7sp1, 7sp2 and 7sp3 for
// one Spanska, each added with its own button and shown with one that takes
// it off again (LanguageGroupsField below). A group reads one language, so a
// group chosen anywhere leaves every select. A
// language given groups is posted on each of them, and every such row of an
// årskurs goes into the block "Språkval åk 7", whose
// lessons the generator places at the same times. Those rows have one shape —
// the line's — so they offer no edit, and a changed choice throws the preview
// away like a changed length. With no group chosen the request carries no
// `languageGroups`, and M2 is skipped on the classes as it always was. The
// summary counts the classes' rows and the språkval rows apart — a language
// group is no class — and the note about split rows counts only rows that
// offer "Gör enhetlig", which a block's rows do not.

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { X } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { useGroups, useRequirements } from "@/lib/queries";
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
  type GenerateLanguageGroup,
  type GenerateRequirementsResponse,
  type Remainder,
  type RowEdit,
} from "@/lib/timplan-generate";
import { formatLengths } from "@/lib/lesson-lengths-text";
import { signedMinutes } from "@/lib/timplan-tackning";
import { gradeOfPlanRow } from "@/lib/grade-numbering";
import type { AcademicYear } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";
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
  /** tioarig: the plan's lydelse numbers its rows the tioårig way (grade-numbering.ts). */
  plan: { id: string; name: string; status: "DRAFT" | "DECIDED"; tioarig?: boolean };
  years: readonly AcademicYear[];
  /** The year the dialog starts on; the active one when null. */
  initialYearId: string | null;
  /** The plan's entries and the school's subjects: which M2 languages the plan has. */
  entries?: readonly { subjectId: string; gradeLevel: number; minutesPerWeek: number }[];
  subjects?: readonly { id: string; name: string; nationalCode?: string | null }[];
}

const grade = (t: (key: string, values?: Record<string, string>) => string, value: number) =>
  t("grade", { grade: String(value) });

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function GenerateDialog({ open, onOpenChange, plan, years, initialYearId, entries, subjects }: GenerateDialogProps) {
  const t = useTranslations("timplan.generate");
  const tCommon = useTranslations("common");

  // Derived, not frozen at mount, as in the year dialog: the years may
  // arrive after the dialog opened.
  const [chosenYearId, setChosenYearId] = useState<string | null>(null);
  // Språkval: "grade:subject" → the teaching groups chosen for it, of this year,
  // in the order they were added. A language may have several (8sp1, 8sp2, 8sp3).
  const [languageChoice, setLanguageChoice] = useState<Map<string, string[]>>(new Map());
  const setYearId = (id: string) => {
    setChosenYearId(id);
    setLanguageChoice(new Map());
  };
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
  const [preview, setPreview] = useState<(GenerateRequirementsResponse & { languages?: string }) | null>(null);

  const groups = useGroups();
  const languages = useMemo(() => {
    const m2 = new Map(
      (subjects ?? []).filter((subject) => subject.nationalCode === "M2").map((subject) => [subject.id, subject.name]),
    );
    // A plan row is offered as the year's årskurs that reads it: an older
    // plan's åk 7 is a tioårig year's åk 8.
    const numbering = year?.gradeNumbering ?? "NIOARIG";
    return (entries ?? [])
      .filter((entry) => entry.minutesPerWeek > 0 && m2.has(entry.subjectId))
      .map((entry) => ({
        gradeLevel: gradeOfPlanRow(plan.tioarig ?? false, numbering, entry.gradeLevel),
        subjectId: entry.subjectId,
        subjectName: m2.get(entry.subjectId)!,
      }))
      .filter((entry): entry is { gradeLevel: number; subjectId: string; subjectName: string } => entry.gradeLevel !== null)
      .sort((a, b) => a.gradeLevel - b.gradeLevel || a.subjectName.localeCompare(b.subjectName, "sv"));
  }, [entries, subjects, plan.tioarig, year?.gradeNumbering]);
  const attached = preview && preview.academicYearId === yearId ? preview.gradeLevels : [];
  const shownLanguages = languages.filter((language) => attached.includes(language.gradeLevel));
  const teachingGroups = (groups.data ?? []).filter(
    (group) => group.academicYearId === yearId && group.kind === "TEACHING_GROUP",
  );
  const teachingName = new Map(teachingGroups.map((group) => [group.id, group.name]));
  // The groups the year still has: one deleted elsewhere since it was chosen
  // drops out here, rather than going to the gateway as a bare id.
  const chosenOf = (key: string) => (languageChoice.get(key) ?? []).filter((id) => teachingName.has(id));
  // Sorted, so the request — and the key a preview is matched on below —
  // depends on which groups are chosen, not on the order they were added in.
  const languageGroups: GenerateLanguageGroup[] = [...languageChoice.keys()]
    .flatMap((key) => {
      const [gradeLevel, subjectId] = key.split(":");
      return chosenOf(key).map((studentGroupId) => ({ gradeLevel: Number(gradeLevel), subjectId: subjectId!, studentGroupId }));
    })
    .sort(
      (a, b) =>
        a.gradeLevel - b.gradeLevel || byId(a.subjectId, b.subjectId) || byId(a.studentGroupId, b.studentGroupId),
    );
  // A group reads one language: once chosen anywhere, no other select offers it.
  const chosenGroups = new Set(languageGroups.map((choice) => choice.studentGroupId));
  const setLanguageGroups = (key: string, groupIds: string[]) => {
    const next = new Map(languageChoice);
    if (groupIds.length > 0) next.set(key, groupIds);
    else next.delete(key);
    setLanguageChoice(next);
  };
  const languagesKey = JSON.stringify(languageGroups);
  const withLanguages = languageGroups.length > 0 ? { languageGroups } : {};
  const [edits, setEdits] = useState<Map<string, RowEdit>>(new Map());
  const [result, setResult] = useState<GenerateRequirementsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A preview belongs to the year, length and remainder it was asked for.
  const current =
    preview &&
    preview.academicYearId === yearId &&
    preview.minutesPerLesson === length &&
    preview.remainder === remainder &&
    (preview.languages ?? "[]") === languagesKey
      ? preview
      : null;
  const overrides = current ? overridesFrom(current.rows, edits) : null;
  // A block's rows are on språkval groups, not on classes.
  const classCount = current
    ? new Set(current.rows.filter((row) => !row.blockName).map((row) => row.studentGroupId)).size
    : 0;

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
        ...withLanguages,
      });
      // Kept with the remainder and the språkval groups it was asked for, so a
      // toggle discards it whether or not the gateway echoes the field.
      setPreview({ ...answer, remainder, languages: languagesKey });
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
        ...withLanguages,
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
      setLanguageChoice(new Map());
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
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("body", { plan: plan.name })}</DialogDescription>
        </DialogHeader>

        {result ? (
          <Notice
            tone="success"
            title={t("resultCreated", {
              count: result.created,
              year: years.find((y) => y.id === result.academicYearId)?.name ?? "",
            })}
          >
            <div className="space-y-2">
              {existingCount(result) > 0 ? <p>{t("resultSkipped", { count: existingCount(result) })}</p> : null}
              {result.blocks && result.blocks.length > 0 ? (
                <p>{t("resultBlocks", { blocks: result.blocks.map((block) => block.name).join(", ") })}</p>
              ) : null}
              <p>{t("resultNext")}</p>
              <Link
                href={`/admin/requirements?year=${encodeURIComponent(result.academicYearId)}`}
                className="font-medium underline underline-offset-2"
              >
                {t("openRequirements")}
              </Link>
            </div>
          </Notice>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={years.length > 0 ? "generate-year" : undefined}>{t("yearLabel")}</Label>
                {years.length > 0 ? (
                  <Select value={yearId ?? undefined} onValueChange={setYearId} disabled={generate.isPending}>
                    <SelectTrigger id="generate-year">
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
              <Notice tone="warning" role={null}>
                {t("draft")}
              </Notice>
            ) : null}

            {shownLanguages.length > 0 ? (
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">{t("languagesTitle")}</legend>
                <p className="text-xs text-foreground">{t("languagesHint")}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  {shownLanguages.map((language) => {
                    const key = `${language.gradeLevel}:${language.subjectId}`;
                    return (
                      <LanguageGroupsField
                        key={key}
                        id={`generate-language-${key}`}
                        label={t("languageLabel", { subject: language.subjectName, grade: String(language.gradeLevel) })}
                        chosen={chosenOf(key).map((id) => ({ id, name: teachingName.get(id)! }))}
                        available={teachingGroups.filter((group) => !chosenGroups.has(group.id))}
                        disabled={generate.isPending}
                        onChange={(groupIds) => setLanguageGroups(key, groupIds)}
                      />
                    );
                  })}
                </div>
              </fieldset>
            ) : null}

            <Button
              variant="outline"
              onClick={() => void askPreview()}
              disabled={!year || length === null || generate.isPending}
            >
              {generate.isPending && !current ? t("previewing") : current ? t("previewAgain") : t("preview")}
            </Button>

            {current && length !== null ? <PreviewBody preview={current} edits={edits} classCount={classCount} length={length} onEdit={editRow} onReset={resetRow} yearName={year?.name ?? ""} planName={plan.name} /> : null}
            {current && overrides === null ? <Notice tone="destructive">{t("invalidRows")}</Notice> : null}
          </div>
        )}

        {error ? <Notice tone="destructive">{error}</Notice> : null}

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

interface LanguageGroupsFieldProps {
  id: string;
  label: string;
  /** The groups chosen for the language, in the order they were added. */
  chosen: readonly { id: string; name: string }[];
  /** The year's teaching groups that no language has. */
  available: readonly { id: string; name: string }[];
  disabled: boolean;
  onChange: (groupIds: string[]) => void;
}

/**
 * One språkval language's groups: the chosen ones, each with a button that
 * takes it off, and a select with "Lägg till" for one more.
 *
 * THE BUTTON ADDS, NOT THE SELECT. Chrome, Edge and Firefox on Windows fire
 * change on every ↑/↓ of a closed select, so a select that added on change
 * would add each group the admin only looked at. The select holds a choice
 * and the button commits it; focus then goes back to the select for the
 * next. Taking a group off moves focus to the next group's button, else the
 * previous one's, else the select, since the button that had it is gone. A
 * polite live region says what was added or taken off.
 */
function LanguageGroupsField({ id, label, chosen, available, disabled, onChange }: LanguageGroupsFieldProps) {
  const t = useTranslations("timplan.generate");
  const [pending, setPending] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const selectRef = useRef<HTMLSelectElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // A group's id, or "" for the select.
  const [focusNext, setFocusNext] = useState<string | null>(null);
  useEffect(() => {
    if (focusNext === null) return;
    const button = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-group]") ?? []).find(
      (element) => element.dataset.group === focusNext,
    );
    (button ?? selectRef.current)?.focus();
    setFocusNext(null);
  }, [focusNext, chosen]);

  // A choice another language has taken since is no choice any more.
  const pick = available.some((group) => group.id === pending) ? pending : "";
  const add = () => {
    const group = available.find((candidate) => candidate.id === pick);
    if (!group) return;
    onChange([...chosen.map((entry) => entry.id), group.id]);
    setPending("");
    setAnnouncement(t("languageAdded", { group: group.name, language: label }));
    setFocusNext("");
  };
  const remove = (index: number) => {
    const group = chosen[index]!;
    const neighbour = chosen[index + 1] ?? chosen[index - 1];
    onChange(chosen.filter((entry) => entry.id !== group.id).map((entry) => entry.id));
    setAnnouncement(t("languageRemoved", { group: group.name, language: label }));
    setFocusNext(neighbour?.id ?? "");
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {chosen.length > 0 ? (
        // role="list": Safari drops a list's role, and so its name, once
        // Tailwind's preflight has taken the bullets away.
        <ul ref={listRef} role="list" className="flex flex-wrap gap-1.5" aria-label={t("languageChosen", { language: label })}>
          {chosen.map((group, index) => (
            <li key={group.id}>
              <Badge variant="secondary" className="gap-1 py-0.5 pr-1 font-normal">
                {group.name}
                <button
                  type="button"
                  data-group={group.id}
                  className="rounded-sm p-0.5 text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
                  aria-label={t("languageRemove", { group: group.name, language: label })}
                  disabled={disabled}
                  onClick={() => remove(index)}
                >
                  <X className="size-3" aria-hidden="true" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex gap-2">
        <NativeSelect
          ref={selectRef}
          id={id}
          value={pick}
          disabled={disabled}
          onChange={(event) => setPending(event.target.value)}
        >
          <option value="">{t("languagePick")}</option>
          {available.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </NativeSelect>
        <Button
          type="button"
          variant="outline"
          className="shrink-0"
          aria-label={t("languageAdd", { language: label })}
          disabled={disabled || pick === ""}
          onClick={add}
        >
          {t("languageAddShort")}
        </Button>
      </div>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
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
  const locale = useLocale();

  // Rows whose shape SPLIT changed and the admin has not made uniform: what
  // the footer's sentence describes. The note counts only those that offer
  // "Gör enhetlig", which a block's rows, of the line's one shape, do not.
  const splitRows = preview.rows.filter((row) => remainderChanged(row, length) && !edits.has(rowKey(row)));
  const changedRows = splitRows.filter((row) => !row.blockName).length;
  const classRows = preview.rows.filter((row) => !row.blockName).length;
  const languageRows = preview.rows.filter((row) => row.blockName);

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
      <Notice>{t("noGrades", { year: yearName, plan: planName })}</Notice>
    );
  }

  return (
    <div className="space-y-3">
      <p role="status" className="text-sm font-medium text-foreground">
        {preview.rows.length === 0
          ? t("nothingToCreate", { skipped: preview.skipped.length })
          : t("summary", {
              rows: classRows,
              classes: classCount,
              skipped: existingCount(preview),
              grades: preview.gradeLevels.map((value) => grade(t, value)).join(", "),
            })}
        {languageRows.length > 0
          ? ` ${t("summaryLanguages", {
              rows: languageRows.length,
              groups: new Set(languageRows.map((row) => row.studentGroupId)).size,
              blocks: [...new Set(languageRows.map((row) => row.blockName))].join(", "),
            })}`
          : null}
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
                    <td className="px-3 py-1.5">
                      {row.subjectName}
                      {row.blockName ? <Badge variant="outline" className="ml-2">{row.blockName}</Badge> : null}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{row.targetMinutesPerWeek}</td>
                    <td className="px-3 py-1.5">
                      {row.blockName ? (
                        // A block's rows have the line's one shape: no edit.
                        <span className="tabular-nums">{formatLengths(row)}</span>
                      ) : splitShown ? (
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
                      {edited.surplus === null ? "—" : signedMinutes(edited.surplus)}
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
                  : row.reason === "HALVES"
                    ? t("skippedHalves", {
                        group: row.groupName,
                        subject: row.subjectName,
                        halves: new Intl.ListFormat(locale, { type: "conjunction" }).format(row.halves ?? []),
                      })
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
        {t(splitRows.length > 0 ? "surplusHintSplit" : "surplusHint")}
      </p>
    </div>
  );
}
