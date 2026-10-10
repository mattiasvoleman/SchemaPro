"use client";

// Täckning, the Stadium tab — stadiesummor över läsår (timplan P4).
//
// Per pupil and stadium (lågstadiet, mellanstadiet, högstadiet, and HKK's
// merged låg- och mellanstadium), the hours across the stadium's läsår —
// planned, the outcome so far (genomfört and tillgodoräknat) and the
// projection — against the national hours of the lydelse that applies to the
// pupil's cohort, as the gateway computes them (GET /timplan-stages;
// src/common/timplan-stage.ts, mirrored in lib/timplan-stage.ts). Past läsår
// come from the class history (StudentEnrollments), the current one is P3's
// held time as of today plus its projection.
//
// UNRECORDED IS NEVER ZERO. A grade with no class history (before the school
// used SchemaPro, before the pupil came), days in no class and a future grade
// no plan carries are "inte registrerat": the stage shows its figures as
// "registrerat sedan …" and is not compared. For the first years nearly every
// stage is partly unrecorded, and the header says so before anything else,
// with the projection leading — otherwise the tab would look broken exactly
// when it is right.
//
// EVERYTHING IS A WARNING OR A NOTICE. "Under timplanen", never "fel";
// nothing here blocks anything. Each national figure is the reference data's
// ("enligt referensdata"), never "lagen säger".
//
// THE OVERVIEW IS PER CLASS AND CARRIES NO PUPIL. A class's row is min /
// median / max over its pupils per cell; opening it fetches that class's
// pupils, and the panel's own rows are computed from them in the browser
// (lib/timplan-stage-view.ts says why). Names are the page's.
//
// THE FAMILIES' CARD IS PUBLISHED HERE. "Publicera" writes the school's
// statement for the active year — each pupil's CURRENT stage, cell by cell —
// which /student and /guardian read as "Undervisningstid", dated. Manual: a
// school decides when its figures are shown, and the card says "Uppdaterad".
//
// Loaded with lazy() when the tab is first chosen.

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Layers, TriangleAlert } from "lucide-react";
import { ApiError } from "@/lib/api";
import { useNationalTimplans } from "@/lib/queries";
import { useTimplanStages, useTimplanStatementActions } from "@/lib/timplan-stage-queries";
import {
  BELOW_CODES,
  drillRows,
  gradeList,
  gradesOfParam,
  hasWarning,
  listedPupils,
  pupilsInStages,
  stageHours,
  stageTables,
  type StagePublicationSummary,
  type StagePupilView,
  type StageVerdictView,
  type TimplanStageResponse,
} from "@/lib/timplan-stage-view";
import type { ClassStageCell, ClassStageSummary, PupilStage, StageCell } from "@/lib/timplan-stage";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { CohortNotice, versionText } from "@/components/timplan/cohort-notice";
import type { CoverageTabProps } from "@/components/timplan/coverage-scheduled-tab";

const WARN = "bg-warning/15 text-warning-foreground dark:text-warning";

function useHours(): (hours: number) => string {
  const locale = useLocale();
  return (hours) => stageHours(hours, locale);
}

/** A day "2026-10-01" in the reader's language, "1 oktober 2026". */
function useDay(): (day: string) => string {
  const locale = useLocale();
  return (day) => {
    const date = new Date(`${day}T12:00:00Z`);
    return Number.isNaN(date.getTime())
      ? day
      : new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(date);
  };
}

export function CoverageStageTab({ year, linkedGroup, groupName, pupilName, gradeName }: CoverageTabProps) {
  const t = useTranslations("timplanCoverage.stage");
  const tCoverage = useTranslations("timplanCoverage");
  const day = useDay();
  const overview = useTimplanStages(year.id);
  const { data: national } = useNationalTimplans();
  const subjectName = useMemo(() => {
    const names = new Map((national?.subjects ?? []).map((subject) => [subject.code, subject.name]));
    return (code: string) => names.get(code) ?? code;
  }, [national]);
  const [chosen, setChosen] = useState<string | null>(null);
  const groupId = chosen ?? linkedGroup;
  const coverage = overview.data && overview.data.academicYearId === year.id ? overview.data : null;
  const tables = useMemo(() => (coverage ? stageTables(coverage.classes, groupName) : []), [coverage, groupName]);
  const selected = coverage?.classes.some((row) => row.studentGroupId === groupId) ? groupId : null;

  if (overview.isLoading || (!coverage && !overview.isError)) return <Skeleton className="h-96 w-full" />;
  if (overview.isError || !coverage) {
    return <EmptyState icon={TriangleAlert} title={tCoverage("loadFailed")} description={tCoverage("loadFailedHint")} />;
  }

  const header = (
    <section className="space-y-1 text-sm text-foreground" aria-label={tCoverage("summaryLabel")}>
      <p className="font-medium">{t("asOf", { date: day(coverage.asOfDate), year: year.name })}</p>
      <p className="max-w-prose text-xs leading-relaxed">{t("definition")}</p>
    </section>
  );

  if (!coverage.isActiveYear) {
    return (
      <div className="space-y-4">
        {header}
        <EmptyState icon={Layers} title={t("notActiveTitle")} description={t("notActiveBody")} />
        <Publication yearId={year.id} publication={coverage.publication} isActiveYear={false} />
      </div>
    );
  }

  const pupils = pupilsInStages(coverage.classes);

  return (
    <div className="space-y-4">
      {header}
      <p role="status" className="max-w-prose rounded-md bg-muted px-3 py-2 text-sm">
        {t("expectation")}
      </p>
      <Publication yearId={year.id} publication={coverage.publication} isActiveYear />

      {coverage.classes.length === 0 ? (
        <EmptyState icon={Layers} title={t("noPupilsTitle")} description={t("noPupilsBody")} />
      ) : (
        <>
          <section className="space-y-1 text-sm" aria-label={t("countsLabel")}>
            <p className="font-medium">{t("pupilsInStages", { pupils })}</p>
            {coverage.verdictCounts.length > 0 ? (
              <ul className="space-y-0.5">
                {coverage.verdictCounts.map((entry) => (
                  <li key={`${entry.code}:${entry.severity}`}>
                    {t("countLine", {
                      label: t(`label.${entry.code}`),
                      within: entry.severity === "notice" && BELOW_CODES.includes(entry.code) ? "yes" : "no",
                      count: entry.pupils,
                    })}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          {tables.map((table) => (
            <section key={table.stage} className="space-y-2" aria-labelledby={`stage-${table.stage}`}>
              <h2 id={`stage-${table.stage}`} className="text-base font-semibold">
                {t("stageTitle", { stage: table.stage })}
              </h2>
              <div className="overflow-x-auto rounded-lg border bg-card">
                <table className="w-full border-collapse text-sm">
                  <caption className="sr-only">{t("caption", { stage: table.stage, year: year.name })}</caption>
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th scope="col" className="sticky left-0 z-10 bg-card px-3 py-2 font-medium">
                        {tCoverage("classColumn")}
                      </th>
                      {table.codes.map((code) => (
                        <th key={code} scope="col" className="px-2 py-2 text-center font-medium">
                          {subjectName(code)}
                        </th>
                      ))}
                      <th scope="col" className="px-3 py-2 font-medium">
                        {t("versionColumn")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {table.rows.map((row) => (
                      <ClassRow
                        key={row.studentGroupId}
                        row={row}
                        codes={table.codes}
                        name={groupName(row.studentGroupId)}
                        subjectName={subjectName}
                        open={row.studentGroupId === selected}
                        onToggle={() => setChosen(row.studentGroupId === selected ? "" : row.studentGroupId)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
          <p className="text-xs text-muted-foreground">{t("legend")}</p>

          {selected ? (
            <StageDrillDown
              yearId={year.id}
              groupId={selected}
              name={groupName(selected)}
              subjectName={subjectName}
              pupilName={pupilName}
              gradeName={gradeName}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{t("chooseClass")}</p>
          )}
        </>
      )}

      <CohortNotice rows={coverage.cohorts} />
    </div>
  );
}

function Publication({
  yearId,
  publication,
  isActiveYear,
}: {
  yearId: string;
  publication: StagePublicationSummary | null;
  isActiveYear: boolean;
}) {
  const t = useTranslations("timplanCoverage.stage");
  const tCommon = useTranslations("common");
  const day = useDay();
  const { publish, withdraw } = useTimplanStatementActions(yearId);
  const current = publication !== null && publication.academicYearId === yearId;
  const failed = (error: unknown) => {
    const code = error instanceof ApiError ? error.code : undefined;
    toast.error(
      code === "TIMPLAN_STAGE_NOT_ACTIVE_YEAR" || code === "TIMPLAN_STAGE_PUBLISH_IN_PROGRESS"
        ? t(`publishError.${code}`)
        : error instanceof Error && error.message
          ? error.message
          : tCommon("error"),
    );
  };
  const pending = publish.isPending || withdraw.isPending;
  return (
    <section className="space-y-2 rounded-lg border bg-card p-4 text-sm" aria-labelledby="stage-publication">
      <h2 id="stage-publication" className="font-semibold">
        {t("publicationTitle")}
      </h2>
      <p className="max-w-prose">
        {publication === null
          ? t("publicationNone")
          : current
            ? t("publicationCurrent", {
                date: day(publication.publishedAt.slice(0, 10)),
                pupils: publication.pupils,
                asOf: day(publication.asOfDate),
              })
            : t("publicationOtherYear", { date: day(publication.publishedAt.slice(0, 10)) })}
      </p>
      <p className="max-w-prose text-xs text-muted-foreground">{t("publicationHint")}</p>
      <div className="flex flex-wrap gap-2">
        {isActiveYear ? (
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              publish.mutate(undefined, {
                onSuccess: (result) => toast.success(t("published", { pupils: result.pupils })),
                onError: failed,
              })
            }
          >
            {publication === null ? t("publish") : t("republish")}
          </Button>
        ) : null}
        {publication !== null ? (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() =>
              withdraw.mutate(undefined, { onSuccess: () => toast.success(t("withdrawn")), onError: failed })
            }
          >
            {t("withdraw")}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

interface ClassRowProps {
  row: ClassStageSummary;
  codes: string[];
  name: string;
  subjectName: (code: string) => string;
  open: boolean;
  onToggle: () => void;
}

function ClassRow({ row, codes, name, subjectName, open, onToggle }: ClassRowProps) {
  const t = useTranslations("timplanCoverage.stage");
  const cells = new Map(row.cells.map((cell) => [cell.code, cell]));
  return (
    <tr className={cn("border-b last:border-b-0", open && "bg-muted/50")}>
      <th scope="row" className="sticky left-0 z-10 bg-card px-3 py-1.5 text-left align-middle font-medium">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={open ? "tackning-stage-class" : undefined}
          className="flex flex-col items-start text-left underline-offset-2 hover:underline"
        >
          <span>{name}</span>
          <span className="text-xs font-normal text-muted-foreground">
            {t("recordedPupils", { complete: row.completePupils, pupils: row.pupils })}
          </span>
        </button>
      </th>
      {codes.map((code) => {
        const cell = cells.get(code);
        return cell ? (
          <td key={code} className="px-1 py-1">
            <OverviewCell cell={cell} name={subjectName(code)} />
          </td>
        ) : (
          <td key={code} className="px-2 py-1.5 text-center text-muted-foreground">
            <span aria-hidden>·</span>
          </td>
        );
      })}
      <td className="px-3 py-1.5 text-xs">
        {row.versionCodes.length > 0 ? row.versionCodes.map(versionText).join(", ") : t("noVersion")}
      </td>
    </tr>
  );
}

function OverviewCell({ cell, name }: { cell: ClassStageCell; name: string }) {
  const t = useTranslations("timplanCoverage.stage");
  const hours = useHours();
  const below = cell.projectedBelowNational;
  return (
    <div
      className={cn(
        "mx-auto flex min-h-12 min-w-20 flex-col items-center justify-center rounded-md border px-1 py-0.5",
        below > 0 && WARN,
      )}
    >
      <span className="text-xs font-semibold tabular-nums" aria-hidden>
        {hours(cell.projected.median)}
        {cell.nationalHours !== null ? ` / ${hours(cell.nationalHours)}` : ""}
      </span>
      <span className="text-[10px] tabular-nums" aria-hidden>
        {hours(cell.projected.min)} – {hours(cell.projected.max)}
      </span>
      {below > 0 ? (
        <span className="text-[10px] font-semibold leading-tight" aria-hidden>
          {t("belowShort", { count: below })}
        </span>
      ) : cell.unrecordedPupils > 0 ? (
        <span className="text-[10px] leading-tight" aria-hidden>
          {t("unrecordedShort", { count: cell.unrecordedPupils })}
        </span>
      ) : null}
      <span className="sr-only">
        {t(cell.nationalHours === null ? "cellLine" : "cellLineNational", {
          subject: name,
          median: hours(cell.projected.median),
          min: hours(cell.projected.min),
          max: hours(cell.projected.max),
          national: hours(cell.nationalHours ?? 0),
          below,
          unrecorded: cell.unrecordedPupils,
        })}
      </span>
    </div>
  );
}

interface DrillProps {
  yearId: string;
  groupId: string;
  name: string;
  subjectName: (code: string) => string;
  pupilName: (id: string) => string;
  gradeName: (grade: number | null) => string;
}

function StageDrillDown({ yearId, groupId, name, subjectName, pupilName, gradeName }: DrillProps) {
  const t = useTranslations("timplanCoverage.stage");
  const tCoverage = useTranslations("timplanCoverage");
  const drill = useTimplanStages(yearId, groupId);
  const [showAll, setShowAll] = useState(false);
  const data: TimplanStageResponse | null =
    drill.data && drill.data.academicYearId === yearId && drill.data.pupils !== null ? drill.data : null;
  const rows = useMemo(() => (data ? drillRows(data, groupId) : []), [data, groupId]);
  const pupils = data?.pupils ?? [];
  const listed = listedPupils(pupils, showAll, pupilName);

  return (
    <section
      id="tackning-stage-class"
      aria-labelledby="tackning-stage-title"
      className="scroll-mt-4 space-y-4 rounded-lg border bg-card p-4"
    >
      <h2 id="tackning-stage-title" className="text-lg font-semibold">
        {name}
      </h2>
      {drill.isError ? (
        <p className="text-sm text-foreground">{tCoverage("loadFailed")}</p>
      ) : !data ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <>
          {rows.map((row) => (
            <ClassStageTable key={row.stage} row={row} subjectName={subjectName} />
          ))}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold">
                {showAll ? t("allPupilsTitle", { count: pupils.length }) : t("pupilsTitle", { count: listed.length })}
              </h3>
              <Button size="sm" variant="outline" aria-pressed={showAll} onClick={() => setShowAll((on) => !on)}>
                {showAll ? t("showWarnedPupils") : tCoverage("showAllPupils")}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t("pupilsHint")}</p>
            {listed.length === 0 ? (
              <p className="text-sm text-foreground">{t("pupilsNone")}</p>
            ) : (
              <ul className="space-y-2">
                {listed.map((pupil) => (
                  <PupilItem
                    key={pupil.pupilId}
                    pupil={pupil}
                    name={pupilName(pupil.pupilId)}
                    subjectName={subjectName}
                    gradeName={gradeName}
                  />
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function ClassStageTable({ row, subjectName }: { row: ClassStageSummary; subjectName: (code: string) => string }) {
  const t = useTranslations("timplanCoverage.stage");
  const hours = useHours();
  const stats = (s: { min: number; median: number; max: number }) =>
    `${hours(s.min)} / ${hours(s.median)} / ${hours(s.max)}`;
  return (
    <div className="space-y-1">
      <h3 className="text-sm font-semibold">
        {t("stageTitle", { stage: row.stage })}
        <span className="ml-2 font-normal text-muted-foreground">
          {t("recordedPupils", { complete: row.completePupils, pupils: row.pupils })}
          {row.backfilledPupils > 0 ? ` · ${t("backfilledPupils", { count: row.backfilledPupils })}` : ""}
        </span>
      </h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">{t("drillCaption", { stage: row.stage })}</caption>
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th scope="col" className="py-2 pr-3 font-medium">{t("subjectColumn")}</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">{t("nationalColumn")}</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">{t("plannedColumn")}</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">{t("projectedColumn")}</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">{t("belowColumn")}</th>
              <th scope="col" className="py-2 text-right font-medium">{t("unrecordedColumn")}</th>
            </tr>
          </thead>
          <tbody>
            {row.cells.map((cell) => (
              <tr key={cell.code} className="border-b last:border-b-0">
                <th scope="row" className="py-1.5 pr-3 text-left font-medium">{subjectName(cell.code)}</th>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {cell.nationalHours === null ? "–" : hours(cell.nationalHours)}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{stats(cell.planned)}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{stats(cell.projected)}</td>
                <td
                  className={cn(
                    "py-1.5 pr-3 text-right tabular-nums",
                    cell.projectedBelowNational + cell.belowNational > 0 &&
                      "font-medium text-warning-foreground dark:text-warning",
                  )}
                >
                  {cell.belowNational} / {cell.projectedBelowNational}
                </td>
                <td className="py-1.5 text-right tabular-nums">{cell.unrecordedPupils}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface PupilProps {
  pupil: StagePupilView;
  name: string;
  subjectName: (code: string) => string;
  gradeName: (grade: number | null) => string;
}

function PupilItem({ pupil, name, subjectName, gradeName }: PupilProps) {
  const t = useTranslations("timplanCoverage.stage");
  const day = useDay();
  const locale = useLocale();
  const grades = (list: number[]) => gradeList(list, locale);
  return (
    <li className={cn("rounded-md border px-3 py-2 text-sm", hasWarning(pupil) && "border-warning/60")}>
      <p className="font-medium">
        {name}
        <span className="ml-2 font-normal text-muted-foreground">
          {pupil.cohortStartHT === null
            ? t("cohortUnknown")
            : t("cohort", { regime: pupil.regime, ht: String(pupil.cohortStartHT) })}
        </span>
      </p>
      {pupil.stages.map((stage) => (
        <PupilStageBlock
          key={stage.stage}
          stage={stage}
          subjectName={subjectName}
          recorded={
            [
              stage.recordedGrades.length > 0 ? t("gradesRecorded", { grades: grades(stage.recordedGrades) }) : null,
              stage.partlyRecordedGrades.length > 0
                ? t("gradesPartly", { grades: grades(stage.partlyRecordedGrades) })
                : null,
              stage.unrecordedGrades.length > 0 ? t("gradesUnrecorded", { grades: grades(stage.unrecordedGrades) }) : null,
              stage.plannedGrades.length > 0 ? t("gradesPlanned", { grades: grades(stage.plannedGrades) }) : null,
              stage.unplannedGrades.length > 0 ? t("gradesUnplanned", { grades: grades(stage.unplannedGrades) }) : null,
              !stage.complete && stage.recordedFrom ? t("recordedSince", { date: day(stage.recordedFrom) }) : null,
            ]
              .filter((part): part is string => part !== null)
              .join(" · ")
          }
        />
      ))}
      {pupil.verdicts.length > 0 ? (
        <ul className="mt-2 space-y-0.5 text-xs">
          {pupil.verdicts.map((verdict, index) => (
            <li
              key={`${verdict.code}-${index}`}
              className={cn(verdict.severity === "warning" && "font-medium text-warning-foreground dark:text-warning")}
            >
              <VerdictText verdict={verdict} subjectName={subjectName} gradeName={gradeName} />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function PupilStageBlock({
  stage,
  subjectName,
  recorded,
}: {
  stage: PupilStage;
  subjectName: (code: string) => string;
  recorded: string;
}) {
  const t = useTranslations("timplanCoverage.stage");
  const hours = useHours();
  return (
    <div className="mt-1.5">
      <p className="text-xs">
        <span className="font-medium">{t("stageTitle", { stage: stage.stage })}</span>
        {stage.current ? ` · ${t("currentStage")}` : ""}
        {` · ${stage.versionCode ? versionText(stage.versionCode) : t("noVersion")}`}
        {recorded ? <span className="block text-muted-foreground">{recorded}</span> : null}
      </p>
      <ul className="mt-0.5 space-y-0.5">
        {stage.cells.map((cell) => (
          <li key={cell.code} className={cn(isBelow(cell) && "font-medium text-warning-foreground dark:text-warning")}>
            {t(cell.nationalHours === null ? "pupilCell" : "pupilCellNational", {
              subject: subjectName(cell.code),
              planned: hours(cell.plannedHours),
              outcome: hours(cell.outcomeHours),
              projected: hours(cell.projectedHours),
              national: hours(cell.nationalHours ?? 0),
            })}
            {" — "}
            {t(`status.${cell.projectedStatus}`, { hours: hours(cell.projectedShortfallHours) })}
          </li>
        ))}
        {stage.unmapped.plannedHours + stage.unmapped.projectedHours > 0 ? (
          <li className="text-muted-foreground">
            {t("unmapped", {
              planned: hours(stage.unmapped.plannedHours),
              projected: hours(stage.unmapped.projectedHours),
            })}
          </li>
        ) : null}
      </ul>
    </div>
  );
}

const isBelow = (cell: StageCell) => cell.projectedStatus === "BELOW" || cell.status === "BELOW";

/** A verdict in the reader's language, from its figures; the gateway's Swedish sentence for a code this page does not know. */
function VerdictText({
  verdict,
  subjectName,
  gradeName,
}: {
  verdict: StageVerdictView;
  subjectName: (code: string) => string;
  gradeName: (grade: number | null) => string;
}) {
  const t = useTranslations("timplanCoverage.stage");
  const tVerdict = useTranslations("timplanCoverage.stage.verdict");
  const hours = useHours();
  const day = useDay();
  const locale = useLocale();
  const p = verdict.params;
  const stage = verdict.stage ? t("stageName", { stage: verdict.stage }) : "";
  const stageTitle = verdict.stage ? t("stageTitle", { stage: verdict.stage }) : "";
  const from = (value: string | number | undefined) => (value ? day(String(value)) : t("unknownDate"));
  const subject = verdict.subjectCode ? subjectName(verdict.subjectCode) : "";
  const h = (value: string | number | undefined) => hours(Number(value ?? 0));
  const yearOf = (ht: string | number | undefined) => `${ht}/${String(Number(ht) + 1).slice(2)}`;
  switch (verdict.code) {
    case "TIMPLAN_PUPIL_STAGE_BELOW_NATIONAL":
    case "TIMPLAN_PUPIL_STAGE_PROJECTED_BELOW_NATIONAL":
      return (
        <>
          {tVerdict(verdict.code === "TIMPLAN_PUPIL_STAGE_BELOW_NATIONAL" ? "below" : "projectedBelow", {
            subject,
            stage,
            hours: h(p.hours),
            shortfall: h(p.shortfallHours),
            national: h(p.nationalHours),
            version: versionText(String(p.versionCode)),
            within: Number(p.withinCap) === 1 ? "yes" : "no",
            cap: String(p.capPercent ?? ""),
          })}
        </>
      );
    case "TIMPLAN_PUPIL_STAGE_GROUP_MINIMUM_UNMET":
      return (
        <>
          {tVerdict("groupMinimum", {
            child: subjectName(String(p.childCode)),
            subject,
            stage,
            planned: h(p.plannedHours),
            shortfall: h(p.shortfallHours),
            minimum: h(p.minimumHours),
          })}
        </>
      );
    case "TIMPLAN_PUPIL_STAGE_PARTLY_UNRECORDED": {
      const grades = (value: string | number | undefined) => gradeList(gradesOfParam(value), locale);
      const parts = [
        p.unrecordedGrades ? tVerdict("partUnrecorded", { grades: grades(p.unrecordedGrades) }) : null,
        p.partlyRecordedGrades ? tVerdict("partPartly", { grades: grades(p.partlyRecordedGrades) }) : null,
        p.unplannedGrades ? tVerdict("partUnplanned", { grades: grades(p.unplannedGrades) }) : null,
        Number(p.classDeleted) === 1 ? tVerdict("partClassDeleted") : null,
      ].filter((part): part is string => part !== null);
      return (
        <>
          {tVerdict("partlyUnrecorded", { stageTitle, parts: parts.join("; "), from: from(p.recordedFrom) })}
        </>
      );
    }
    case "TIMPLAN_PUPIL_STAGE_BACKFILLED":
      return <>{tVerdict("backfilled", { from: from(p.recordedFrom) })}</>;
    case "TIMPLAN_STAGE_VERSION_NOT_IN_REFERENCE":
      return <>{tVerdict("versionMissing", { stageTitle })}</>;
    case "TIMPLAN_STAGE_DISTRIBUTION_UNPUBLISHED":
      return <>{tVerdict("unpublished", { stageTitle, version: versionText(String(p.versionCode)), total: h(p.totalHours) })}</>;
    case "TIMPLAN_STAGE_OLD_COHORT_DISTRIBUTION_ASSUMED":
      return <>{tVerdict("assumed", { stageTitle, version: versionText(String(p.versionCode)) })}</>;
    case "TIMPLAN_PUPIL_STAGE_FORM_CHANGED":
      return <>{tVerdict("formChanged", { stageTitle })}</>;
    case "TIMPLAN_PUPIL_STAGE_GRADE_UNKNOWN":
      return <>{tVerdict("gradeUnknown", { year: yearOf(p.yearStartHT) })}</>;
    case "TIMPLAN_PUPIL_STAGE_GRADE_REPEATED":
      return <>{tVerdict("gradeRepeated", { stageTitle, grade: gradeName(Number(p.gradeLevel)) })}</>;
    case "TIMPLAN_PUPIL_STAGE_PRESCHOOL_AFTER_2028":
      return <>{tVerdict("preschoolAfter2028", { year: yearOf(p.yearStartHT) })}</>;
    case "TIMPLAN_PUPIL_STAGE_SUBJECTS_UNMAPPED":
      return <>{tVerdict("subjectsUnmapped", { stageTitle, planned: h(p.plannedHours) })}</>;
    default:
      return <>{verdict.message}</>;
  }
}
