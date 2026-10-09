"use client";

// Täckning — the year's timplan coverage in three layers, one tab each:
// planerat mot timplan (P2, below), schemalagt mot planerat and genomfört mot
// schemalagt (P3, components/timplan/coverage-scheduled-tab.tsx and
// coverage-delivered-tab.tsx, each fetched with lazy() the first time its tab
// is chosen, so this route carries only the tab strip for them).
//
// THE TABLIST SITS ABOVE EVERY LOADING AND EMPTY STATE (R27). The planned
// layer's "no classes" or "no year" is about that layer; a year with no
// timplan still has a grundschema to compare and a calendar to count, so the
// other two tabs must be reachable exactly when the planned matrix is empty.
// Each tab panel owns its own empty states; the planned panel keeps the
// markup it had.
//
// A hand-built tablist (role=tablist/tab, aria-selected, roving arrow keys)
// rather than Radix Tabs: three buttons, and no second primitive on a route
// that needs none.
//
// LAYER 1 — PLANERAT MOT TIMPLAN.
//
// WHAT IS SHOWN. Every class of the year down the side, every subject a class
// has a target or a post in across the top; each cell "planerat / mål" in
// minutes per standardvecka, with the line's signed difference — the Mål
// mode's figures and tones, read here from the gateway's GET /timplan-coverage
// rather than recomputed (lib/timplan-tackning.ts says why). Per class the
// Täckning count (lines every pupil reaches) and the whole week and year.
// Choosing a class opens its drill-down: per line, the class's own posts, the
// teaching groups that carry its pupils, and the pupils' min / median / max
// and how many are under mål; then the pupils with a finding of their OWN —
// under mål where the class is not, or the same subject from two groups —
// each with where their minutes come from.
//
// WHY PER PUPIL. Skolinspektionen faults schools that follow up "på klass-
// och gruppnivå" only: a class can be on mål while the pupils of one
// språkval group are not. The class row says the first; the drill-down says
// the second.
//
// NAMES ARE THE PAGE'S. The response carries pupil ids only; the roster this
// page already reads (usePeople) names them, and a pupil it does not hold is
// "okänd elev" rather than an id.
//
// EVERYTHING IS A WARNING. Colours and words say "under mål", never "fel": the
// law lets a pupil's studiegång deviate. Nothing here blocks anything.
//
// The deep link ?year=&group=&layer= (the Timplansposter matrix's Täckning
// pill, and the timetable's Lektionstid panel with layer=scheduled) selects
// the year, the tab and the class; it is read once after mount, not through
// useSearchParams, which would make the whole route bail out of static
// rendering for three ids.

import { Suspense, lazy, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import { ArrowLeft, TriangleAlert, Target } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { useAcademicYears, useGroups, usePeople, useSubjects } from "@/lib/queries";
import { useLocalTimplans } from "@/lib/timplan-queries";
import { useTimplanCoverage } from "@/lib/timplan-tackning-queries";
import {
  buildCoverageMatrix,
  signedMinutes,
  type CoverageCellView,
  type CoverageClassRow,
  type CoverageTone,
} from "@/lib/timplan-tackning";
import type { PupilLine } from "@/lib/timplan-planned";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";
import { DialogLoadBoundary } from "@/components/schedule/dialog-load-boundary";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Hours to the tenth with a decimal comma, as the matrix prints them. */
const hoursText = (hours: number): string => {
  const rounded = Math.round(hours * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1).replace(".", ",")} h`;
};

/*
 * The other two layers' tabs, fetched on first choice. A chunk that does not
 * arrive (a deploy between the page's load and the click) is caught by a
 * DialogLoadBoundary, said in the panel, and the lazy wrapper made again so
 * the next choice of a tab fetches afresh — rather than climbing to the root,
 * where Next draws its client-exception screen over the page (the app has no
 * error.tsx). The timetable's Lektionstid panel does the same.
 */
const lazyScheduledTab = () =>
  lazy(() =>
    import("@/components/timplan/coverage-scheduled-tab").then((module) => ({
      default: module.CoverageScheduledTab,
    })),
  );
const lazyDeliveredTab = () =>
  lazy(() =>
    import("@/components/timplan/coverage-delivered-tab").then((module) => ({
      default: module.CoverageDeliveredTab,
    })),
  );
let CoverageScheduledTab = lazyScheduledTab();
let CoverageDeliveredTab = lazyDeliveredTab();

const LAYERS = ["planned", "scheduled", "delivered"] as const;
type Layer = (typeof LAYERS)[number];
const LAYER_LABEL: Record<Layer, string> = {
  planned: "layerPlanned",
  scheduled: "layerScheduled",
  delivered: "layerDelivered",
};

/**
 * The Mål mode's tones (components/timplan/requirements-target.tsx, whose
 * header measures their contrast): amber under, red with a border for no
 * posts, neutral for a class carried by its groups, the accent otherwise.
 */
const TONE: Record<CoverageTone, string> = {
  unplanned: "border border-destructive text-destructive",
  under: "bg-warning/15 text-warning-foreground dark:text-warning",
  pupils: "bg-muted text-foreground",
  met: "bg-accent/70 text-accent-foreground",
  over: "bg-accent/70 text-accent-foreground",
  none: "bg-accent/70 text-accent-foreground",
};

interface Deeplink {
  year: string | null;
  group: string | null;
  layer: Layer | null;
}

export default function TimplanCoveragePage() {
  const t = useTranslations("timplanCoverage");

  const { data: years, isLoading: yearsLoading, isError: yearsFailed } = useAcademicYears();
  const { data: groups, isLoading: groupsLoading, isError: groupsFailed } = useGroups();
  const { data: subjects, isLoading: subjectsLoading, isError: subjectsFailed } = useSubjects();
  const { data: people } = usePeople();
  const { data: plans } = useLocalTimplans();

  const [link, setLink] = useState<Deeplink | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const layer = params.get("layer");
    setLink({
      year: params.get("year"),
      group: params.get("group"),
      layer: LAYERS.includes(layer as Layer) ? (layer as Layer) : null,
    });
  }, []);

  const [chosenYear, setChosenYear] = useState<string | null>(null);
  const linkedYear = link?.year && years?.some((year) => year.id === link.year) ? link.year : null;
  const yearId =
    chosenYear ?? linkedYear ?? years?.find((year) => year.isActive)?.id ?? years?.[0]?.id ?? null;
  const year = years?.find((entry) => entry.id === yearId) ?? null;

  const [chosenLayer, setChosenLayer] = useState<Layer | null>(null);
  // Undecided until the deep link has been read, so a link to another tab
  // does not first ask the gateway for layer 1.
  const layer: Layer | null = chosenLayer ?? (link === null ? null : (link.layer ?? "planned"));
  const shownTab: Layer = layer ?? "planned";
  // A tab whose chunk failed to load says so in its panel until a tab is
  // chosen again, which mounts a fresh boundary and fetches afresh.
  const [tabLoad, setTabLoad] = useState({ failed: false, attempt: 0 });
  const chooseLayer = (entry: Layer) => {
    setChosenLayer(entry);
    setTabLoad((state) => (state.failed ? { failed: false, attempt: state.attempt + 1 } : state));
  };
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = LAYERS.indexOf(shownTab);
    const next =
      event.key === "ArrowRight"
        ? (index + 1) % LAYERS.length
        : event.key === "ArrowLeft"
          ? (index + LAYERS.length - 1) % LAYERS.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? LAYERS.length - 1
              : null;
    if (next === null) return;
    event.preventDefault();
    chooseLayer(LAYERS[next]!);
    tabs.current[next]?.focus();
  };

  // Layer 1 is asked for only while its tab is the one shown.
  const coverage = useTimplanCoverage(layer === "planned" ? yearId : null);

  const [chosenClass, setChosenClass] = useState<string | null>(null);
  const classId = chosenClass ?? (chosenYear === null ? (link?.group ?? null) : null);

  const matrix = useMemo(
    () =>
      coverage.data && coverage.data.academicYearId === yearId
        ? buildCoverageMatrix(coverage.data, groups ?? [], subjects ?? [], people ?? [])
        : null,
    [coverage.data, yearId, groups, subjects, people],
  );
  const selected = matrix?.classes.find((row) => row.id === classId) ?? null;

  // The linked class is scrolled to once its drill-down is on screen.
  useEffect(() => {
    if (!selected || chosenClass !== null) return;
    document.getElementById("tackning-class")?.scrollIntoView?.({ block: "start" });
  }, [selected, chosenClass]);

  const planName = useMemo(() => new Map((plans ?? []).map((plan) => [plan.id, plan.name])), [plans]);
  const groupName = useMemo(() => new Map((groups ?? []).map((group) => [group.id, group.name])), [groups]);
  const subjectName = useMemo(
    () => new Map((subjects ?? []).map((subject) => [subject.id, subject.name])),
    [subjects],
  );
  const personName = useMemo(
    () => new Map((people ?? []).map((person) => [person.id, `${person.firstName} ${person.lastName}`])),
    [people],
  );

  const gradeName = (grade: number | null) =>
    grade === null ? t("noGrade") : t("grade", { grade: String(grade) });

  const loading = yearsLoading || groupsLoading || subjectsLoading || (yearId !== null && coverage.isLoading);
  const failed = yearsFailed || groupsFailed || subjectsFailed || coverage.isError;
  const linkedGroup = chosenYear === null ? (link?.group ?? null) : null;

  return (
    <div>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <>
            {years && years.length > 0 ? (
              <Select
                value={yearId ?? undefined}
                onValueChange={(value) => {
                  setChosenYear(value);
                  setChosenClass(null);
                }}
              >
                <SelectTrigger className="w-48" aria-label={t("yearLabel")}>
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
            ) : null}
            <Button asChild variant="outline">
              <Link href="/admin/timplan">
                <ArrowLeft />
                {t("backToTimplan")}
              </Link>
            </Button>
          </>
        }
      />

      <div role="tablist" aria-label={t("layersLabel")} className="mb-4 flex flex-wrap gap-1 border-b">
        {LAYERS.map((entry, index) => (
          <button
            key={entry}
            ref={(node) => {
              tabs.current[index] = node;
            }}
            type="button"
            role="tab"
            id={`tackning-tab-${entry}`}
            aria-selected={shownTab === entry}
            aria-controls="tackning-panel"
            tabIndex={shownTab === entry ? 0 : -1}
            onClick={() => chooseLayer(entry)}
            onKeyDown={onTabKey}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-medium",
              shownTab === entry
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t(LAYER_LABEL[entry])}
          </button>
        ))}
      </div>

      <div role="tabpanel" id="tackning-panel" aria-labelledby={`tackning-tab-${shownTab}`}>
      {layer === null ? (
        <Skeleton className="h-96 w-full" />
      ) : layer !== "planned" ? (
        yearsLoading || groupsLoading || subjectsLoading ? (
          <Skeleton className="h-96 w-full" />
        ) : yearsFailed || groupsFailed || subjectsFailed ? (
          <EmptyState icon={TriangleAlert} title={t("loadFailed")} description={t("loadFailedHint")} />
        ) : !year ? (
          <EmptyState icon={Target} title={t("noYearTitle")} description={t("noYearBody")} />
        ) : tabLoad.failed ? (
          <EmptyState icon={TriangleAlert} title={t("loadFailed")} description={t("loadFailedHint")} />
        ) : (
          <DialogLoadBoundary
            key={tabLoad.attempt}
            onError={() => {
              CoverageScheduledTab = lazyScheduledTab();
              CoverageDeliveredTab = lazyDeliveredTab();
              setTabLoad((state) => ({ ...state, failed: true }));
            }}
          >
          <Suspense fallback={<Skeleton className="h-96 w-full" />}>
            {layer === "scheduled" ? (
              <CoverageScheduledTab
                key={year.id}
                year={year}
                linkedGroup={linkedGroup}
                groupName={(id) => groupName.get(id) ?? id}
                subjects={subjects ?? []}
                pupilName={(id) => personName.get(id) ?? t("unknownPupil")}
                gradeName={gradeName}
              />
            ) : (
              <CoverageDeliveredTab
                key={year.id}
                year={year}
                linkedGroup={linkedGroup}
                groupName={(id) => groupName.get(id) ?? id}
                subjects={subjects ?? []}
                pupilName={(id) => personName.get(id) ?? t("unknownPupil")}
                gradeName={gradeName}
              />
            )}
          </Suspense>
          </DialogLoadBoundary>
        )
      ) : loading ? (
        <Skeleton className="h-96 w-full" />
      ) : failed ? (
        <EmptyState icon={TriangleAlert} title={t("loadFailed")} description={t("loadFailedHint")} />
      ) : !year ? (
        <EmptyState icon={Target} title={t("noYearTitle")} description={t("noYearBody")} />
      ) : !matrix ? (
        <Skeleton className="h-96 w-full" />
      ) : matrix.classes.length === 0 ? (
        <EmptyState icon={Target} title={t("noClassesTitle")} description={t("noClassesBody", { year: year.name })} />
      ) : (
        <div className="space-y-4">
          <section className="space-y-2 text-sm text-foreground" aria-label={t("summaryLabel")}>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{t("layerPlanned")}</p>
            <p role="status" className="font-medium">
              {/* "ingen är under mål" is true of a year with no targets at
                  all, and read as all is well; the notices below say why. */}
              {matrix.classes.every((row) => row.summary.linesWithTarget === 0)
                ? t("pupilsNoTarget", { pupils: matrix.coverage.pupilCount })
                : matrix.coverage.pupilsBelowTarget === null
                ? t("pupilsTotal", { pupils: matrix.coverage.pupilCount })
                : t("pupilsBelow", {
                    pupils: matrix.coverage.pupilCount,
                    below: matrix.coverage.pupilsBelowTarget,
                  })}
            </p>
            {matrix.coverage.pupilsOutsideClasses > 0 ? (
              <p>{t("pupilsOutside", { count: matrix.coverage.pupilsOutsideClasses })}</p>
            ) : null}
            {matrix.unattachedGrades.length > 0 ? (
              <p className="rounded-md bg-muted px-3 py-2">
                {t("unattached", { grades: matrix.unattachedGrades.map(gradeName).join(", ") })}
              </p>
            ) : null}
            {matrix.draftPlans.map((plan) => (
              <p key={plan.id} className="rounded-md border-l-4 border-l-warning bg-muted px-3 py-2">
                {t("draft", { name: plan.name, grades: plan.gradeLevels.map(gradeName).join(", ") })}
              </p>
            ))}
            {matrix.emptyPlanGrades.map((entry) => (
              <p key={entry.gradeLevel} className="rounded-md bg-muted px-3 py-2">
                {t("emptyPlan", { name: entry.planName, grade: gradeName(entry.gradeLevel) })}
              </p>
            ))}
            <p className="text-xs text-muted-foreground">{t("legend")}</p>
          </section>

          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">{t("caption", { year: year.name })}</caption>
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th scope="col" className="sticky left-0 z-10 bg-card px-3 py-2 font-medium">
                    {t("classColumn")}
                  </th>
                  {matrix.subjects.map((subject) => (
                    <th key={subject.id} scope="col" className="px-2 py-2 text-center font-medium">
                      {subject.name}
                    </th>
                  ))}
                  <th scope="col" className="px-3 py-2 text-center font-medium">
                    {t("coverageColumn")}
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">
                    {t("totalColumn")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {matrix.classes.map((row) => (
                  <ClassRow
                    key={row.id}
                    row={row}
                    subjects={matrix.subjects}
                    cell={matrix.cell}
                    open={row.id === classId}
                    gradeName={gradeName}
                    onToggle={() => setChosenClass(row.id === classId ? "" : row.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {selected ? (
            <ClassDrillDown
              row={selected}
              planName={selected.summary.localTimplanId ? (planName.get(selected.summary.localTimplanId) ?? "") : null}
              pupilLevel={matrix.coverage.pupilLevel}
              gradeName={gradeName}
              groupName={(id) => groupName.get(id) ?? id}
              subjectNames={(ids) => ids.map((id) => subjectName.get(id) ?? id).join(" / ")}
              pupilName={(id) => personName.get(id) ?? t("unknownPupil")}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{t("chooseClass")}</p>
          )}
        </div>
      )}
      </div>
    </div>
  );
}

interface ClassRowProps {
  row: CoverageClassRow;
  subjects: { id: string; name: string }[];
  cell: (groupId: string, subjectId: string) => CoverageCellView | null;
  open: boolean;
  gradeName: (grade: number | null) => string;
  onToggle: () => void;
}

function ClassRow({ row, subjects, cell, open, gradeName, onToggle }: ClassRowProps) {
  const t = useTranslations("timplanCoverage");
  const { summary } = row;
  const short = summary.linesCovered < summary.linesWithTarget;
  return (
    <tr className={cn("border-b last:border-b-0", open && "bg-muted/50")}>
      <th scope="row" className="sticky left-0 z-10 bg-card px-3 py-1.5 text-left align-middle font-medium">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={open ? "tackning-class" : undefined}
          className="flex flex-col items-start text-left underline-offset-2 hover:underline"
        >
          <span>{row.name}</span>
          <span className="text-xs font-normal text-muted-foreground">
            {gradeName(summary.gradeLevel)}
            {summary.planStatus === "DRAFT" ? ` · ${t("draftShort")}` : ""}
            {row.pupils.length > 0 ? ` · ${t("pupilsListed", { count: row.pupils.length })}` : ""}
          </span>
        </button>
      </th>
      {subjects.map((subject) => {
        const view = cell(row.id, subject.id);
        if (!view) {
          return (
            <td key={subject.id} className="px-2 py-1.5 text-center text-muted-foreground">
              <span aria-hidden>·</span>
            </td>
          );
        }
        return (
          <td key={subject.id} className="px-1 py-1">
            <CoverageCell view={view} subjectName={subject.name} />
          </td>
        );
      })}
      <td className="px-3 py-1.5 text-center">
        {summary.localTimplanId === null ? (
          <span className="text-xs text-muted-foreground">{t("noPlan")}</span>
        ) : summary.linesWithTarget === 0 ? (
          <span className="text-xs text-muted-foreground">{t("emptyPlanShort")}</span>
        ) : (
          <span
            className={cn(
              "inline-flex rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums",
              short ? "bg-warning/15 text-warning-foreground dark:text-warning" : "border text-foreground",
            )}
          >
            {/* aria-label on a role-less span is not read: the sentence is text. */}
            <span aria-hidden="true">
              {summary.linesCovered}/{summary.linesWithTarget}
            </span>
            <span className="sr-only">
              {t("coverageLabel", { covered: summary.linesCovered, total: summary.linesWithTarget })}
            </span>
          </span>
        )}
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums">
        <span className="block font-medium">
          {summary.plannedMinutesPerWeek}
          {summary.localTimplanId === null ? "" : ` / ${summary.targetMinutesPerWeek}`}
        </span>
        <span className="block text-xs text-muted-foreground">
          {hoursText(summary.plannedHours)}
          {summary.localTimplanId === null ? "" : ` / ${hoursText(summary.targetHours)}`}
        </span>
      </td>
    </tr>
  );
}

function CoverageCell({ view, subjectName }: { view: CoverageCellView; subjectName: string }) {
  const t = useTranslations("timplanCoverage");
  const { cell, line, tone } = view;
  const delta = line.deltaMinutesPerWeek;
  const note =
    tone === "pupils"
      ? t("tagPupils")
      : cell.alternativeCode !== null && tone !== "under" && tone !== "unplanned"
        ? t("tagAlternative")
        : delta !== null && delta !== 0
          ? signedMinutes(delta)
          : null;
  const values = {
    subject: subjectName,
    planned: cell.plannedMinutesPerWeek,
    target: cell.targetMinutesPerWeek ?? 0,
    deficit: delta === null ? 0 : -delta,
    surplus: delta ?? 0,
  };
  return (
    <div
      className={cn(
        "mx-auto flex min-h-10 min-w-16 flex-col items-center justify-center rounded-md px-1",
        TONE[tone],
      )}
    >
      <span className="text-sm font-semibold tabular-nums" aria-hidden>
        {cell.plannedMinutesPerWeek} / {cell.targetMinutesPerWeek ?? "–"}
      </span>
      {note ? (
        <span className="text-[10px] font-semibold leading-tight tabular-nums" aria-hidden>
          {note}
        </span>
      ) : null}
      <span className="sr-only">{t(`cell.${tone}`, values)}</span>
    </div>
  );
}

interface DrillDownProps {
  row: CoverageClassRow;
  planName: string | null;
  pupilLevel: boolean;
  gradeName: (grade: number | null) => string;
  groupName: (id: string) => string;
  subjectNames: (ids: string[]) => string;
  pupilName: (id: string) => string;
}

function ClassDrillDown({ row, planName, pupilLevel, gradeName, groupName, subjectNames, pupilName }: DrillDownProps) {
  const t = useTranslations("timplanCoverage");
  const { summary } = row;
  return (
    <section
      id="tackning-class"
      aria-labelledby="tackning-class-title"
      className="scroll-mt-4 space-y-4 rounded-lg border bg-card p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="tackning-class-title" className="text-lg font-semibold">
          {row.name}
        </h2>
        <Badge variant="outline">{gradeName(summary.gradeLevel)}</Badge>
        {planName !== null ? <Badge variant="secondary">{planName}</Badge> : null}
        {summary.planStatus === "DRAFT" ? <Badge variant="warning">{t("draftBadge")}</Badge> : null}
        <span className="text-sm text-muted-foreground">{t("classPupils", { count: summary.pupilCount })}</span>
      </div>

      {summary.localTimplanId === null ? (
        <p className="text-sm text-foreground">{t("classNoPlan")}</p>
      ) : null}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">{t("linesCaption", { group: row.name })}</caption>
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th scope="col" className="py-2 pr-3 font-medium">{t("lineSubject")}</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">{t("lineTarget")}</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">{t("linePlanned")}</th>
              <th scope="col" className="py-2 pr-3 font-medium">{t("lineGroups")}</th>
              {pupilLevel ? (
                <>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">{t("linePupils")}</th>
                  <th scope="col" className="py-2 text-right font-medium">{t("lineBelow")}</th>
                </>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {summary.lines.map((line) => (
              <tr key={line.key} className="border-b last:border-b-0">
                <th scope="row" className="py-1.5 pr-3 text-left font-medium">
                  {subjectNames(line.subjectIds)}
                  {line.alternativeCode !== null ? (
                    <span className="ml-1 text-xs font-normal text-muted-foreground">{t("together")}</span>
                  ) : null}
                </th>
                <td className="py-1.5 pr-3 text-right tabular-nums">{line.targetMinutesPerWeek ?? "–"}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {line.plannedMinutesPerWeek}
                  {line.deltaMinutesPerWeek !== null && line.deltaMinutesPerWeek !== 0 ? (
                    <span
                      className={cn(
                        "ml-1 text-xs",
                        line.deltaMinutesPerWeek < 0 && "font-medium text-warning-foreground dark:text-warning",
                      )}
                    >
                      {signedMinutes(line.deltaMinutesPerWeek)}
                    </span>
                  ) : null}
                </td>
                <td className="py-1.5 pr-3">
                  {line.teachingGroupIds.length > 0 ? line.teachingGroupIds.map(groupName).join(", ") : "–"}
                </td>
                {pupilLevel ? (
                  <>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {line.pupils
                        ? t("stats", { min: line.pupils.min, median: line.pupils.median, max: line.pupils.max })
                        : "–"}
                    </td>
                    <td
                      className={cn(
                        "py-1.5 text-right tabular-nums",
                        line.pupils && line.pupils.below > 0 && "font-medium text-warning-foreground dark:text-warning",
                      )}
                    >
                      {line.pupils ? t("below", { below: line.pupils.below, pupils: summary.pupilCount }) : "–"}
                    </td>
                  </>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pupilLevel ? (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">{t("pupilsTitle", { count: row.pupils.length })}</h3>
          <p className="text-xs text-muted-foreground">{t("pupilsHint")}</p>
          {row.pupils.length === 0 ? (
            <p className="text-sm text-foreground">{t("pupilsNone")}</p>
          ) : (
            <ul className="space-y-2">
              {row.pupils.map((pupil) => (
                <li key={pupil.pupilId} className="rounded-md border px-3 py-2 text-sm">
                  <p className="font-medium">{pupilName(pupil.pupilId)}</p>
                  <ul className="mt-1 space-y-1">
                    {pupil.lines.map((line) => (
                      <PupilLineItem
                        key={line.key}
                        line={line}
                        groupName={groupName}
                        subjectNames={subjectNames}
                      />
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}

function PupilLineItem({
  line,
  groupName,
  subjectNames,
}: {
  line: PupilLine;
  groupName: (id: string) => string;
  subjectNames: (ids: string[]) => string;
}) {
  const t = useTranslations("timplanCoverage");
  const sources = line.sources
    .map((source) => t("source", { group: groupName(source.studentGroupId), minutes: source.minutesPerWeek }))
    .join(", ");
  const subject = subjectNames(line.subjectIds);
  return (
    <li>
      <span
        className={cn(line.status === "UNDER" && "font-medium text-warning-foreground dark:text-warning")}
      >
        {line.status === "UNDER"
          ? t("pupilUnder", {
              subject,
              planned: line.plannedMinutesPerWeek,
              target: line.targetMinutesPerWeek ?? 0,
              deficit: (line.targetMinutesPerWeek ?? 0) - line.plannedMinutesPerWeek,
            })
          : t("pupilLine", { subject, planned: line.plannedMinutesPerWeek, target: line.targetMinutesPerWeek ?? 0 })}
      </span>
      {sources ? <span className="text-muted-foreground"> — {sources}</span> : null}
      {line.doublePlannedSubjectIds.length > 0 ? (
        <span className="block text-xs text-foreground">
          {t("pupilDouble", { subjects: subjectNames(line.doublePlannedSubjectIds) })}
        </span>
      ) : null}
      {line.alternativeSubjectIds.length > 0 ? (
        <span className="block text-xs text-foreground">
          {t("pupilAlternatives", { subjects: subjectNames(line.alternativeSubjectIds) })}
        </span>
      ) : null}
    </li>
  );
}
