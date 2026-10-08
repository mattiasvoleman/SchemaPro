"use client";

// Timplan: skolans lokala timplan, the target the timplansposter lay out.
//
// The huvudman decides the fördelning mellan årskurserna (skollagen 9 kap.
// 4 §) on rektor's proposal, in minutes per week; the statute speaks in hours
// per stadium. This page holds the first and shows the second beside the
// national figure: one row per school subject, one column per årskurs, and
// after each stadium's årskurser its sum, coloured by the verdict of the
// national cell the subject feeds. Nothing here writes a timplanspost — that
// is P2's "Skapa timplansposter" — and nothing here is sent to the solver.
//
// TWO CHECKS, ONE ARITHMETIC. While the admin types, the grid and the rail are
// painted from lib/timplan-coverage.ts, the gateway's module mirrored and held
// to the same fixture; the moment the edits are saved (or thrown away) the
// page shows the gateway's own document again — the one the PUT answered
// with, so the verdicts on screen after a save are the server's, not a guess
// that happened to agree. The rail says which of the two it is showing.
//
// EVERY VERDICT IS A WARNING. Nothing blocks Spara or Besluta: the law lets a
// school deviate (anpassad studiegång, prioriterad timplan, a rektor's
// decision in anpassade grundskolan), and a product that refuses the plan of
// the school with the most vulnerable pupils is wrong. Colours and copy say
// "under mål", never "fel".
//
// A DECIDED PLAN IS A RECORD. The grid turns read-only, and the way forward is
// Öppna igen, which copies it into a new draft; the database refuses every
// change to the decided one anyway (migration 20261006120000's triggers). It
// can still be deleted, as an explicit act whose confirmation names it a
// decided plan.
//
// The six dialogs of this page are fetched on the click that opens them,
// through React.lazy — not next/dynamic, whose loader costs 1.4KB of its own
// on the route (see admin/people). None is reachable during SSR: `dialog`
// starts null.
//
// The delete confirmation is imported STATICALLY, and that is what keeps the
// other four lazy for free. Measured 2026-10-06 (own JS, gzip): with all five
// lazy, no page statically held the Radix Dialog internals the async chunks
// need, and Turbopack re-sliced the (app) layout's chunks — which hold the
// same internals for the user menu — into four instead of three: +0.5KB on
// EVERY app route, guardian 170.1 → 170.6 against its 170 budget, for 183.0KB
// here. All five static: 187.3KB here, the layout untouched. ConfirmDialog
// static (it is Dialog plus two buttons) and the four page dialogs lazy:
// 185.6KB here and the layout untouched again — the cheapest of the three.
// P2 added two more on the same terms (Skapa timplansposter, Timplan per
// årskurs). Measured 2026-10-07: 187.2 → 187.7KB here with both dialogs, the
// three buttons and the Täckning link, the layout's chunks untouched.
//
// P2 ALSO MADE THIS THE PAGE THE LÄSÅR IS TIED TO THE PLAN FROM: "Timplan per
// årskurs" (which plan each årskurs follows, per läsår), "Skapa
// timplansposter" (the plan's minutes as the posts a year's classes miss, on
// the plan shown) and a link to Täckning, where the posts are held against
// the plan per class and pupil.

import { lazy, Suspense, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { CalendarRange, Download, FileUp, ListPlus, Plus, Target, TriangleAlert } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { useAcademicYears, useNationalTimplans, usePeople, useSubjects } from "@/lib/queries";
import {
  useLocalTimplan,
  useLocalTimplanActions,
  useLocalTimplanCheck,
  useLocalTimplans,
  type LocalTimplanDetail,
  type UpdatePlanBody,
} from "@/lib/timplan-queries";
import { checkLocalTimplan, planningWeeksInTenths } from "@/lib/timplan-coverage";
import {
  draftFromEntries,
  entriesFromDraft,
  gridColumns,
  cellKey,
  parseWeeksTenths,
  sameDraft,
  SUGGESTED_WEEKS,
  toCoverageVersion,
  verdictHighlight,
  type DraftCells,
} from "@/lib/timplan-view";
import { downloadCsv } from "@/lib/csv-export";
import { TIMPLAN_CSV_TEMPLATE, timplanToCsv } from "@/lib/timplan-csv";
import { PageHeader } from "@/components/layout/page-header";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { TimplanGrid } from "@/components/timplan/timplan-grid";
import { WarningsRail } from "@/components/timplan/warnings-rail";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const CreateDialog = lazy(() =>
  import("@/components/timplan/create-dialog").then((module) => ({ default: module.CreateDialog })),
);
const DecideDialog = lazy(() =>
  import("@/components/timplan/decide-dialog").then((module) => ({ default: module.DecideDialog })),
);
const CopyDialog = lazy(() =>
  import("@/components/timplan/copy-dialog").then((module) => ({ default: module.CopyDialog })),
);
const GenerateDialog = lazy(() =>
  import("@/components/timplan/generate-dialog").then((module) => ({ default: module.GenerateDialog })),
);
const YearTimplansDialog = lazy(() =>
  import("@/components/timplan/year-timplans-dialog").then((module) => ({
    default: module.YearTimplansDialog,
  })),
);
const TimplanImportDialog = lazy(() =>
  import("@/components/timplan/timplan-import-dialog").then((module) => ({
    default: module.TimplanImportDialog,
  })),
);

type DialogName = "create" | "decide" | "reopen" | "copy" | "delete" | "import" | "generate" | "yearTimplans";

/** What the admin has changed on one plan and not saved. */
interface Draft {
  planId: string;
  cells: DraftCells;
  name: string;
  weeks: string;
  versionId: string;
}

/** 35.6 → "35,6": the field shows the decimal comma a Swedish keyboard types. */
const weeksText = (weeks: number) => weeks.toFixed(1).replace(".", ",");

function draftOf(plan: LocalTimplanDetail): Draft {
  return {
    planId: plan.id,
    cells: draftFromEntries(plan.entries),
    name: plan.name,
    weeks: weeksText(plan.planningWeeks),
    versionId: plan.nationalTimplanVersionId,
  };
}

const errorText = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

export default function TimplanPage() {
  const t = useTranslations("timplan");
  const tCommon = useTranslations("common");
  const locale = useLocale();

  const { data: plans, isLoading: plansLoading, isError: plansFailed } = useLocalTimplans();
  const { data: national, isLoading: nationalLoading, isError: nationalFailed } = useNationalTimplans();
  const { data: subjects, isLoading: subjectsLoading, isError: subjectsFailed } = useSubjects();
  const { data: people } = usePeople();
  const { data: years } = useAcademicYears();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const activeId =
    selectedId !== null && plans?.some((entry) => entry.id === selectedId)
      ? selectedId
      : (plans?.[0]?.id ?? null);
  const { data: plan, isLoading: planLoading, isError: planFailed } = useLocalTimplan(activeId);
  const { data: savedCheck } = useLocalTimplanCheck(activeId);
  const actions = useLocalTimplanActions();

  const [edit, setEdit] = useState<Draft | null>(null);
  const [dialog, setDialog] = useState<DialogName | null>(null);
  const [selectedVerdict, setSelectedVerdict] = useState<number | null>(null);

  const shown = plan && plan.id === activeId ? plan : null;
  const base = useMemo(() => (shown ? draftOf(shown) : null), [shown]);
  // The edit survives a refetch of the same plan — a PATCH that lands before
  // the PUT must not wipe the cells still waiting to be sent — and is dropped
  // the moment another plan is shown.
  const current = edit && base && edit.planId === base.planId ? edit : base;
  const decided = shown?.status === "DECIDED";

  const known = useMemo(() => new Set((subjects ?? []).map((subject) => subject.id)), [subjects]);
  const notes = useMemo(
    () =>
      new Map((shown?.entries ?? []).map((entry) => [cellKey(entry.subjectId, entry.gradeLevel), entry.note])),
    [shown],
  );
  const savedWeeksTenths = shown ? planningWeeksInTenths(shown.planningWeeks) : null;
  const typedWeeksTenths = current ? parseWeeksTenths(current.weeks) : null;
  const weeksTenths = typedWeeksTenths ?? savedWeeksTenths ?? Math.round(SUGGESTED_WEEKS * 10);

  const cellsChanged = !!(current && base && !sameDraft(current.cells, base.cells));
  const planChanged = !!(
    current &&
    shown &&
    (current.name.trim() !== shown.name ||
      typedWeeksTenths !== savedWeeksTenths ||
      current.versionId !== shown.nationalTimplanVersionId)
  );
  const dirty = cellsChanged || planChanged;
  const invalidCells = current ? entriesFromDraft(current.cells, notes, known).invalid : [];
  const nameProblem =
    current && current.name.trim() === ""
      ? t("nameRequired")
      : current && current.name.trim().length > 100
        ? t("nameTooLong")
        : null;

  const versions = national?.versions ?? [];
  const version = versions.find((entry) => entry.id === current?.versionId);
  const parentOf = useMemo(
    () => new Map((national?.subjects ?? []).map((subject) => [subject.code, subject.parentCode])),
    [national],
  );
  const nationalNames = useMemo(
    () => new Map((national?.subjects ?? []).map((subject) => [subject.code, subject.name])),
    [national],
  );

  const liveCheck = useMemo(() => {
    if (!current || !version || !national || !subjects) return null;
    return checkLocalTimplan({
      planningWeeksTenths: weeksTenths,
      version: toCoverageVersion(version),
      nationalSubjects: national.subjects.map(({ code, parentCode }) => ({ code, parentCode })),
      subjects: subjects.map(({ id, name, nationalCode, countsTowardTimplan }) => ({
        id,
        name,
        nationalCode,
        countsTowardTimplan,
      })),
      entries: entriesFromDraft(current.cells, notes, known).entries,
    });
  }, [current, version, national, subjects, weeksTenths, notes, known]);

  const serverCheck = savedCheck && savedCheck.localTimplanId === activeId ? savedCheck : null;
  const live = dirty || serverCheck === null;
  const check = live ? liveCheck : serverCheck;

  const highlight =
    check && selectedVerdict !== null && check.verdicts[selectedVerdict]
      ? verdictHighlight(check.verdicts[selectedVerdict], subjects ?? [], check.stageGrades, parentOf)
      : null;

  const extraGrades = useMemo(() => {
    const grades: number[] = [];
    for (const [key, text] of current?.cells ?? []) {
      if (text.trim() !== "") grades.push(Number(key.slice(key.lastIndexOf(":") + 1)));
    }
    return grades;
  }, [current]);
  const columns = check ? gridColumns(check.stageGrades, extraGrades) : [];

  // Counted subjects without a national code: their minutes feed no national
  // cell, so a school whose subjects are all uncoded sees every stage under
  // mål and — before this — nothing saying why. Unplanned ones included: the
  // check's TIMPLAN_SUBJECT_UNMAPPED names only those with minutes.
  const uncoded = (subjects ?? []).filter((subject) => subject.countsTowardTimplan && !subject.nationalCode).length;

  const loading =
    plansLoading || nationalLoading || subjectsLoading || (activeId !== null && planLoading);
  const failed = plansFailed || nationalFailed || subjectsFailed || planFailed;

  const change = (patch: Partial<Draft>) => {
    if (!current) return;
    setEdit({ ...current, ...patch });
  };

  const onCellChange = (key: string, text: string) => {
    if (!current || decided) return;
    const cells = new Map(current.cells);
    cells.set(key, text);
    change({ cells });
    setSelectedVerdict(null);
  };

  const save = async () => {
    if (!shown || !current || !base || decided) return;
    const { entries, invalid } = entriesFromDraft(current.cells, notes, known);
    if (invalid.length > 0 || typedWeeksTenths === null || nameProblem) return;
    const patch: UpdatePlanBody = {};
    if (current.name.trim() !== shown.name) patch.name = current.name.trim();
    if (typedWeeksTenths !== savedWeeksTenths) patch.planningWeeks = typedWeeksTenths / 10;
    if (current.versionId !== shown.nationalTimplanVersionId) {
      patch.nationalTimplanVersionId = current.versionId;
    }
    try {
      if (Object.keys(patch).length > 0) await actions.update.mutateAsync({ id: shown.id, ...patch });
      if (cellsChanged) await actions.replaceEntries.mutateAsync({ id: shown.id, entries });
      setEdit(null);
      toast.success(t("saved"));
    } catch (error) {
      toast.error(errorText(error, tCommon("error")));
    }
  };

  const run = async (work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      toast.error(errorText(error, tCommon("error")));
    }
  };

  const exportCsv = () => {
    if (!shown || !subjects) return;
    // The SAVED plan: an export is a copy of the document, and the document is
    // what Spara last stored. Unsaved cells are on screen with a notice.
    downloadCsv(TIMPLAN_CSV_TEMPLATE.filename, timplanToCsv(shown.entries, subjects));
  };

  const decidedBy = shown?.decidedByUserId
    ? people?.find((person) => person.id === shown.decidedByUserId)
    : undefined;
  const decidedDate = shown?.decidedAt
    ? new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(new Date(shown.decidedAt))
    : "";

  const pending =
    actions.update.isPending ||
    actions.replaceEntries.isPending ||
    actions.decide.isPending ||
    actions.reopen.isPending ||
    actions.copy.isPending ||
    actions.remove.isPending ||
    actions.create.isPending;

  return (
    <div>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <>
            {plans && plans.length > 0 ? (
              <Select
                value={activeId ?? undefined}
                onValueChange={(value) => {
                  setSelectedId(value);
                  setSelectedVerdict(null);
                }}
                disabled={dirty}
              >
                <SelectTrigger className="w-72" aria-label={t("planLabel")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {plans.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {t("planOption", {
                        name: entry.name,
                        schoolForm: t(`schoolForms.${entry.schoolForm}`),
                      })}
                      {" · "}
                      {entry.status === "DECIDED" ? t("statusDecided") : t("statusDraft")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <Button variant="outline" onClick={() => setDialog("create")} disabled={dirty}>
              <Plus />
              {t("newPlan")}
            </Button>
            <Button variant="outline" onClick={() => setDialog("yearTimplans")} disabled={dirty}>
              <CalendarRange />
              {t("yearTimplansButton")}
            </Button>
            <Button asChild variant="ghost">
              <Link href="/admin/timplan/tackning">
                <Target />
                {t("coverageLink")}
              </Link>
            </Button>
          </>
        }
      />

      {loading ? (
        <Skeleton className="h-96 w-full" />
      ) : failed ? (
        <EmptyState icon={TriangleAlert} title={t("loadFailed")} description={t("loadFailedHint")} />
      ) : !plans || plans.length === 0 ? (
        <EmptyState
          icon={Target}
          title={t("noPlansTitle")}
          description={t("noPlansBody")}
          action={
            <Button onClick={() => setDialog("create")}>
              <Plus />
              {t("newPlan")}
            </Button>
          }
        />
      ) : !shown || !current ? (
        <Skeleton className="h-96 w-full" />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">{shown.name}</h2>
            <Badge variant={decided ? "success" : "secondary"}>
              {decided ? t("statusDecided") : t("statusDraft")}
            </Badge>
            <Badge variant="outline">{t(`schoolForms.${shown.schoolForm}`)}</Badge>
          </div>

          {decided ? (
            <div role="status" className="rounded-md bg-muted px-4 py-3 text-sm text-foreground">
              <p className="font-medium">
                {t("decidedTitle", { date: decidedDate })}
                {decidedBy ? ` ${t("decidedBy", { name: `${decidedBy.firstName} ${decidedBy.lastName}` })}` : ""}
              </p>
              {shown.decisionNote ? <p>{t("decidedNote", { note: shown.decisionNote })}</p> : null}
              <p className="mt-1">{t("decidedReadOnly")}</p>
            </div>
          ) : null}

          <section className="grid gap-4 rounded-lg border bg-card p-4 md:grid-cols-3" aria-label={t("planLabel")}>
            <div className="space-y-1.5">
              <Label htmlFor="timplan-name">{t("nameLabel")}</Label>
              <Input
                id="timplan-name"
                value={current.name}
                readOnly={decided}
                aria-invalid={nameProblem !== null || undefined}
                onChange={(event) => change({ name: event.target.value })}
              />
              {nameProblem ? <p className="text-sm text-destructive">{nameProblem}</p> : null}
            </div>
            <div className="space-y-1.5">
              <Label>{t("versionLabel")}</Label>
              <Select
                value={current.versionId}
                onValueChange={(value) => change({ versionId: value })}
                disabled={decided}
              >
                <SelectTrigger aria-label={t("versionLabel")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {versions
                    .filter((entry) => entry.schoolForm === shown.schoolForm)
                    .map((entry) => (
                      <SelectItem key={entry.id} value={entry.id}>
                        {t("versionOption", {
                          sfs: entry.sfs,
                          total: entry.totalHours,
                          term: entry.appliesFromCohortTerm,
                        })}
                        {entry.entries.length === 0 ? ` · ${t("versionUnpublished")}` : ""}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="timplan-weeks">{t("weeksLabel")}</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="timplan-weeks"
                  inputMode="decimal"
                  className="w-24"
                  value={current.weeks}
                  readOnly={decided}
                  aria-invalid={typedWeeksTenths === null || undefined}
                  aria-describedby="timplan-weeks-hint"
                  onChange={(event) => change({ weeks: event.target.value })}
                />
                {!decided && typedWeeksTenths !== Math.round(SUGGESTED_WEEKS * 10) ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => change({ weeks: weeksText(SUGGESTED_WEEKS) })}
                  >
                    {t("weeksUseSuggestion")}
                  </Button>
                ) : null}
              </div>
              <p
                id="timplan-weeks-hint"
                className={typedWeeksTenths === null ? "text-xs text-destructive" : "text-xs text-muted-foreground"}
              >
                {typedWeeksTenths === null ? t("weeksInvalid") : t("weeksHint")}
              </p>
            </div>
          </section>

          <div className="flex flex-wrap items-center gap-2">
            {!decided ? (
              <>
                <Button
                  onClick={() => void save()}
                  disabled={!dirty || pending || invalidCells.length > 0 || typedWeeksTenths === null || nameProblem !== null}
                >
                  {actions.update.isPending || actions.replaceEntries.isPending ? t("saving") : t("save")}
                </Button>
                {dirty ? (
                  <Button variant="ghost" onClick={() => setEdit(null)} disabled={pending}>
                    {t("discard")}
                  </Button>
                ) : null}
                <Button variant="outline" onClick={() => setDialog("decide")} disabled={dirty || pending}>
                  {t("decide")}
                </Button>
              </>
            ) : (
              <Button onClick={() => setDialog("reopen")} disabled={pending}>
                {t("reopen")}
              </Button>
            )}
            <Button variant="outline" onClick={() => setDialog("copy")} disabled={dirty || pending}>
              {t("copy")}
            </Button>
            <Button
              variant="outline"
              onClick={() => setDialog("generate")}
              disabled={dirty || pending || shown.entries.length === 0}
            >
              <ListPlus />
              {t("generateButton")}
            </Button>
            <Button variant="outline" onClick={exportCsv} disabled={shown.entries.length === 0}>
              <Download />
              {t("exportCsv")}
            </Button>
            {!decided ? (
              <Button variant="outline" onClick={() => setDialog("import")} disabled={dirty || pending}>
                <FileUp />
                {t("importCsv")}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDialog("delete")}
              disabled={dirty || pending}
            >
              {t("delete")}
            </Button>
          </div>

          {dirty ? (
            <p role="status" className="text-sm text-foreground">
              {t("unsaved")}
            </p>
          ) : null}
          {invalidCells.length > 0 ? (
            <p role="alert" className="text-sm text-destructive">
              {t("invalidCells", { count: invalidCells.length })}
            </p>
          ) : null}

          {version && version.entries.length === 0 ? (
            <div role="status" className="rounded-md border-l-4 border-l-warning bg-muted px-4 py-3 text-sm text-foreground">
              <p className="font-medium">{t("unpublishedTitle")}</p>
              <p>{t("unpublishedBody", { version: version.code, total: version.totalHours })}</p>
            </div>
          ) : null}

          {uncoded > 0 ? (
            // Above the grid AND the rail, at every width: below xl the rail
            // falls under twenty-odd rows, and its "under mål" rows are what
            // this sentence explains when no subject is coded yet.
            <p role="status" className="rounded-md border-l-4 border-l-warning bg-muted px-4 py-3 text-sm text-foreground">
              {t("uncodedNotice", { count: uncoded })}{" "}
              <Link href="/admin/subjects" className="underline">
                {t("uncodedNoticeLink")}
              </Link>
            </p>
          ) : null}

          {(subjects ?? []).length === 0 ? (
            <EmptyState icon={Target} title={tCommon("noResults")} description={t("noSubjects")} />
          ) : check ? (
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
              <div className="min-w-0 space-y-2">
                <TimplanGrid
                  subjects={subjects ?? []}
                  parentOf={parentOf}
                  columns={columns}
                  stageGrades={check.stageGrades}
                  draft={current.cells}
                  notes={notes}
                  check={check}
                  weeksTenths={weeksTenths}
                  readOnly={decided}
                  highlight={highlight}
                  onCellChange={onCellChange}
                />
                <p className="text-xs text-muted-foreground">{t("legend")}</p>
                {check.gradesOutsideStages.length > 0 || columns.some((c) => c.kind === "grade" && c.stage === null) ? (
                  <p className="text-xs text-muted-foreground">{t("outsideStagesHint")}</p>
                ) : null}
              </div>
              <WarningsRail
                verdicts={check.verdicts}
                nationalNames={nationalNames}
                live={live && dirty}
                selected={selectedVerdict}
                onSelect={setSelectedVerdict}
              />
            </div>
          ) : (
            <Skeleton className="h-96 w-full" />
          )}
        </div>
      )}

      <Suspense fallback={null}>
        {dialog === "create" ? (
          <CreateDialog
            open
            onOpenChange={(open) => !open && setDialog(null)}
            versions={versions}
            pending={actions.create.isPending}
            onConfirm={(body) =>
              run(async () => {
                const created = await actions.create.mutateAsync(body);
                setSelectedId(created.id);
                setEdit(null);
                setDialog(null);
                toast.success(t("created"));
              })
            }
          />
        ) : null}
        {dialog === "decide" && shown ? (
          <DecideDialog
            open
            onOpenChange={(open) => !open && setDialog(null)}
            planName={shown.name}
            pending={actions.decide.isPending}
            onConfirm={(decisionNote) =>
              run(async () => {
                await actions.decide.mutateAsync({ id: shown.id, decisionNote });
                setDialog(null);
                toast.success(t("decided"));
              })
            }
          />
        ) : null}
        {(dialog === "reopen" || dialog === "copy") && shown ? (
          <CopyDialog
            mode={dialog}
            open
            onOpenChange={(open) => !open && setDialog(null)}
            planName={shown.name}
            takenNames={(plans ?? []).map((entry) => entry.name)}
            pending={actions.reopen.isPending || actions.copy.isPending}
            onConfirm={(name) =>
              run(async () => {
                const mutation = dialog === "reopen" ? actions.reopen : actions.copy;
                const created = await mutation.mutateAsync({ id: shown.id, name });
                setSelectedId(created.id);
                setEdit(null);
                setDialog(null);
                toast.success(t(dialog === "reopen" ? "reopened" : "copied"));
              })
            }
          />
        ) : null}
        {dialog === "generate" && shown ? (
          <GenerateDialog
            open
            onOpenChange={(open) => !open && setDialog(null)}
            plan={{ id: shown.id, name: shown.name, status: shown.status }}
            years={years ?? []}
            initialYearId={null}
          />
        ) : null}
        {dialog === "yearTimplans" ? (
          <YearTimplansDialog
            open
            onOpenChange={(open) => !open && setDialog(null)}
            years={years ?? []}
            initialYearId={null}
          />
        ) : null}
        {dialog === "import" && shown ? (
          <TimplanImportDialog
            open
            onOpenChange={(open) => !open && setDialog(null)}
            plan={{ id: shown.id, name: shown.name, status: shown.status }}
          />
        ) : null}
        {dialog === "delete" && shown ? (
          <ConfirmDialog
            open
            onOpenChange={(open) => !open && setDialog(null)}
            title={t(decided ? "deleteTitleDecided" : "deleteTitleDraft", { name: shown.name })}
            description={t(decided ? "deleteBodyDecided" : "deleteBodyDraft")}
            confirmLabel={decided ? t("deleteConfirmDecided") : t("delete")}
            loading={actions.remove.isPending}
            onConfirm={() =>
              void run(async () => {
                await actions.remove.mutateAsync(shown.id);
                setSelectedId(null);
                setEdit(null);
                setDialog(null);
                toast.success(t("deleted"));
              })
            }
          />
        ) : null}
      </Suspense>
    </div>
  );
}
