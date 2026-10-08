"use client";

// Täckning, layer 3 — Genomfört mot schemalagt.
//
// What the calendar records as held, per group and subject, against what was
// published, as the gateway computes it (GET /timplan-coverage?layer=delivered;
// the definition is ONE SQL CASE in src/timplan/timplan-delivered.sql.ts and
// the manual quotes it). Each cell "genomfört / publicerat" in hours with the
// share held and a pill for the year's projection against the planned year.
// A group's drill-down asks the gateway for that group alone: the lost minutes
// by cause, the credits, the projection's parts — the calendar ahead, the
// grundschema after it, time with no teacher ahead and days nothing records,
// reported beside the projection and never inside it — and, for an admin,
// min / median / max over the pupils and the pupils with a shortfall of their
// own, because a class average hides the one pupil in two teaching groups who
// gets nothing.
//
// TODAY'S ROSTERS, SAID ON THE TAB (R28). A pupil's minutes follow the class
// and groups they are in today — there is no roster history until P4 — so a
// pupil who changed class in October carries the new class's year. That is
// stated permanently under the header, not only in the manual.
//
// ATTENDANCE IS NOT SUBTRACTED: undervisningstid is the school's offer, and
// frånvaro the pupil's. The definition sentence says so.
//
// Loaded with lazy() when the tab is first chosen.

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { CalendarClock, TriangleAlert } from "lucide-react";
import { useDeliveredCoverage } from "@/lib/timplan-delivered-queries";
import {
  buildDeliveredMatrix,
  hoursOf,
  isDetail,
  lostShares,
  ownFindingPupils,
  YEAR_NOTICES,
  type DeliveredCoverageResponse,
  type DeliveredGroupSummary,
  type DeliveredLineDetail,
  type DeliveredLineSummary,
  type DeliveredVerdict,
  type LostCause,
} from "@/lib/timplan-delivered";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import type { CoverageTabProps } from "@/components/timplan/coverage-scheduled-tab";

/** Each cause its own fill; the legend beside the bar carries the words. */
const CAUSE_FILL: Record<LostCause, string> = {
  cancelledTeacherUnavailable: "bg-destructive/80",
  cancelledRoomUnavailable: "bg-warning",
  cancelledManual: "bg-primary/70",
  cancelledUnknown: "bg-muted-foreground/60",
  teacherless: "bg-destructive/40",
  otherStatus: "bg-secondary-foreground/40",
};

/** The year's projection against the planned year less the days nothing records. */
const deltaOf = (line: DeliveredLineSummary): number =>
  line.projectedMinutes - (line.plannedYearMinutes - line.unrecordedMinutes);

export function CoverageDeliveredTab({ year, linkedGroup, groupName, subjects, pupilName, gradeName }: CoverageTabProps) {
  const t = useTranslations("timplanCoverage");
  const overview = useDeliveredCoverage(year.id);
  const [chosen, setChosen] = useState<string | null>(null);
  const groupId = chosen ?? linkedGroup;
  const coverage = overview.data && overview.data.academicYearId === year.id ? overview.data : null;
  const matrix = useMemo(() => (coverage ? buildDeliveredMatrix(coverage, subjects) : null), [coverage, subjects]);
  const selected = coverage?.groups.find((g) => g.studentGroupId === groupId) ?? null;
  const columnName = (name: string | null) => name ?? t("noSubject");

  if (overview.isLoading || (!coverage && !overview.isError)) return <Skeleton className="h-96 w-full" />;
  if (overview.isError || !coverage || !matrix) {
    return <EmptyState icon={TriangleAlert} title={t("loadFailed")} description={t("loadFailedHint")} />;
  }

  const asOf = new Date(coverage.asOf);
  const time = Number.isNaN(asOf.getTime())
    ? ""
    : `${String(asOf.getHours()).padStart(2, "0")}:${String(asOf.getMinutes()).padStart(2, "0")}`;

  const header = (
    <section className="space-y-1 text-sm text-foreground" aria-label={t("summaryLabel")}>
      <p className="font-medium">
        {t("delivered.asOf", { date: coverage.asOfDate, time })}
        {coverage.published
          ? ` · ${t("delivered.publishedThrough", { from: coverage.published.from, through: coverage.published.through })}`
          : ""}
      </p>
      <p className="font-medium">{t("delivered.rosterNote")}</p>
      <p className="max-w-prose text-xs leading-relaxed">{t("delivered.definition")}</p>
    </section>
  );

  if (coverage.published === null) {
    return (
      <div className="space-y-4">
        {header}
        <EmptyState
          icon={CalendarClock}
          title={t("delivered.notPublishedTitle")}
          description={t("delivered.notPublishedBody")}
        />
      </div>
    );
  }

  const notices = coverage.verdicts.filter((v) => YEAR_NOTICES.includes(v.code));
  const row = (summary: DeliveredGroupSummary) => (
    <DeliveredRow
      key={summary.studentGroupId}
      summary={summary}
      name={groupName(summary.studentGroupId)}
      columns={matrix.columns}
      columnName={columnName}
      open={summary.studentGroupId === groupId}
      gradeName={gradeName}
      onToggle={() => setChosen(summary.studentGroupId === groupId ? "" : summary.studentGroupId)}
    />
  );

  return (
    <div className="space-y-4">
      {header}
      <section className="space-y-2 text-sm text-foreground" aria-label={t("delivered.noticesLabel")}>
        <p role="status" className="font-medium">
          {coverage.pupilsBelowPlanned === null
            ? t("pupilsTotal", { pupils: coverage.pupilCount })
            : t("delivered.pupilsSummary", { pupils: coverage.pupilCount, below: coverage.pupilsBelowPlanned })}
          {coverage.credits.count > 0
            ? ` ${t("delivered.creditsSummary", { count: coverage.credits.count, hours: hoursOf(coverage.credits.minutes) })}`
            : ""}
        </p>
        {notices.map((verdict, index) => (
          <p key={`${verdict.code}-${index}`} className="rounded-md bg-muted px-3 py-2">
            <YearNotice verdict={verdict} />
          </p>
        ))}
        <p className="text-xs text-muted-foreground">{t("delivered.legend")}</p>
      </section>

      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{t("delivered.caption", { year: year.name })}</caption>
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th scope="col" className="sticky left-0 z-10 bg-card px-3 py-2 font-medium">
                {t("scheduled.groupColumn")}
              </th>
              {matrix.columns.map((column) => (
                <th key={column.key} scope="col" className="px-2 py-2 text-center font-medium">
                  {columnName(column.name)}
                </th>
              ))}
              <th scope="col" className="px-3 py-2 text-right font-medium">
                {t("delivered.columns.lost")}
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                {t("delivered.columns.projectedOfPlanned")}
              </th>
            </tr>
          </thead>
          <tbody>
            {matrix.classes.map(row)}
            {matrix.teachingGroups.length > 0 ? (
              <tr className="border-b bg-muted/40">
                <th
                  scope="colgroup"
                  colSpan={matrix.columns.length + 3}
                  className="px-3 py-1.5 text-left text-xs font-medium"
                >
                  {t("teachingGroups")}
                </th>
              </tr>
            ) : null}
            {matrix.teachingGroups.map(row)}
          </tbody>
        </table>
      </div>

      {selected ? (
        <DeliveredDrillDown
          yearId={year.id}
          summary={selected}
          overview={coverage}
          name={groupName(selected.studentGroupId)}
          lineName={(key) => columnName(matrix.columns.find((c) => c.key === key)?.name ?? null)}
          groupName={groupName}
          pupilName={pupilName}
          gradeName={gradeName}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{t("chooseGroup")}</p>
      )}
    </div>
  );
}

/** A year-wide notice in the reader's language, from the verdict's figures. */
function YearNotice({ verdict }: { verdict: DeliveredVerdict }) {
  const tNotice = useTranslations("timplanCoverage.delivered.notice");
  const p = verdict.params;
  switch (verdict.code) {
    case "TIMPLAN_PUBLISHED_LATE":
      return <>{tNotice("publishedLate", { from: p.from, yearStart: p.yearStart, hours: hoursOf(Number(p.unrecordedMinutes)) })}</>;
    case "TIMPLAN_PUBLISHED_BEHIND":
      return <>{tNotice("publishedBehind", { through: p.through })}</>;
    case "TIMPLAN_DELIVERED_PAST_YEAR_ROSTERS":
      return <>{tNotice("pastYearRosters", { yearEnd: p.yearEnd })}</>;
    case "TIMPLAN_CALENDAR_DRIFT":
      return <>{tNotice("drift", { minutes: Math.abs(Number(p.minutes)), lessons: Number(p.lessons) })}</>;
    case "TIMPLAN_CREDIT_OUTSIDE_YEAR":
      return <>{tNotice("creditOutsideYear", { name: p.creditName, date: p.date, yearStart: p.yearStart, yearEnd: p.yearEnd })}</>;
    case "TIMPLAN_CREDIT_REACHES_NOBODY":
      return (
        <>
          {p.reason === "SUBJECT"
            ? tNotice("creditSubjectNotCounted", { name: p.creditName, date: p.date })
            : tNotice("creditReachesNobody", { name: p.creditName, date: p.date })}
        </>
      );
    case "TIMPLAN_CREDIT_OVERLAPS_DELIVERED":
      return (
        <>
          {tNotice("creditOverlaps", {
            name: p.creditName,
            date: p.date,
            minutes: Number(p.minutes),
            delivered: Number(p.deliveredMinutes),
          })}
        </>
      );
    case "TIMPLAN_CALENDAR_ON_BREAK":
      return <>{tNotice("onBreak", { group: p.groupName, minutes: Number(p.minutes), dates: p.dates })}</>;
    default:
      return <>{verdict.message}</>;
  }
}

interface RowProps {
  summary: DeliveredGroupSummary;
  name: string;
  columns: { key: string; name: string | null }[];
  columnName: (name: string | null) => string;
  open: boolean;
  gradeName: (grade: number | null) => string;
  onToggle: () => void;
}

function DeliveredRow({ summary, name, columns, columnName, open, gradeName, onToggle }: RowProps) {
  const t = useTranslations("timplanCoverage");
  const lines = new Map(summary.lines.map((line) => [line.key, line]));
  const short = summary.lines.filter((line) => line.status === "SHORT").length;
  return (
    <tr className={cn("border-b last:border-b-0", open && "bg-muted/50")}>
      <th scope="row" className="sticky left-0 z-10 bg-card px-3 py-1.5 text-left align-middle font-medium">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={open ? "tackning-delivered-group" : undefined}
          className="flex flex-col items-start text-left underline-offset-2 hover:underline"
        >
          <span>{name}</span>
          <span className="text-xs font-normal text-muted-foreground">
            {summary.kind === "CLASS" ? gradeName(summary.gradeLevel) : t("classPupils", { count: summary.pupilCount })}
            {short > 0 ? ` · ${t("delivered.shortLines", { count: short })}` : ""}
          </span>
        </button>
      </th>
      {columns.map((column) => {
        const line = lines.get(column.key);
        return line ? (
          <td key={column.key} className="px-1 py-1">
            <DeliveredCell line={line} name={columnName(column.name)} />
          </td>
        ) : (
          <td key={column.key} className="px-2 py-1.5 text-center text-muted-foreground">
            <span aria-hidden>·</span>
          </td>
        );
      })}
      <td className="px-3 py-1.5 text-right tabular-nums">{hoursOf(summary.totals.lost)}</td>
      <td className="px-3 py-1.5 text-right tabular-nums">
        {hoursOf(summary.totals.projected)} / {hoursOf(summary.totals.plannedYear)}
      </td>
    </tr>
  );
}

function DeliveredCell({ line, name }: { line: DeliveredLineSummary; name: string }) {
  const t = useTranslations("timplanCoverage");
  const delta = deltaOf(line);
  const pill =
    line.status === "SHORT"
      ? t("delivered.projection.short", { hours: hoursOf(-delta) })
      : line.status === "ON_TRACK"
        ? t("delivered.projection.onTrack")
        : null;
  return (
    <div className="mx-auto flex min-h-12 min-w-20 flex-col items-center justify-center rounded-md border px-1 py-0.5">
      <span className="text-xs font-semibold tabular-nums" aria-hidden>
        {hoursOf(line.deliveredMinutes)} / {hoursOf(line.publishedMinutes)}
      </span>
      {line.deliveredPercent !== null ? (
        <span className="text-[10px] tabular-nums" aria-hidden>
          {t("scheduled.percent", { percent: line.deliveredPercent })}
        </span>
      ) : null}
      {pill ? (
        <span
          className={cn(
            "mt-0.5 rounded-full px-1.5 text-[10px] font-semibold leading-tight",
            line.status === "SHORT"
              ? "bg-warning/15 text-warning-foreground dark:text-warning"
              : "bg-accent/70 text-accent-foreground",
          )}
          aria-hidden
        >
          {pill}
        </span>
      ) : null}
      <span className="sr-only">
        {t("delivered.cellLine", {
          subject: name,
          delivered: hoursOf(line.deliveredMinutes),
          published: hoursOf(line.publishedMinutes),
        })}
        {pill ? ` ${pill}.` : ""}
      </span>
    </div>
  );
}

interface DrillProps {
  yearId: string;
  summary: DeliveredGroupSummary;
  overview: DeliveredCoverageResponse;
  name: string;
  lineName: (key: string) => string;
  groupName: (id: string) => string;
  pupilName: (id: string) => string;
  gradeName: (grade: number | null) => string;
}

function DeliveredDrillDown({ yearId, summary, overview, name, lineName, groupName, pupilName, gradeName }: DrillProps) {
  const t = useTranslations("timplanCoverage");
  // The breakdowns come with the drill-down, for this group alone (R20).
  const drill = useDeliveredCoverage(yearId, summary.studentGroupId);
  const [showAll, setShowAll] = useState(false);
  const detail =
    drill.data && drill.data.academicYearId === yearId
      ? (drill.data.groups.find((g) => g.studentGroupId === summary.studentGroupId) ?? null)
      : null;
  const own = useMemo(() => ownFindingPupils(overview), [overview]);
  const pupils = drill.data?.pupils ?? [];
  const listed = showAll ? pupils : pupils.filter((pupil) => own.has(pupil.pupilId));
  const pupilLevel = overview.pupilLevel;

  return (
    <section
      id="tackning-delivered-group"
      aria-labelledby="tackning-delivered-title"
      className="scroll-mt-4 space-y-4 rounded-lg border bg-card p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="tackning-delivered-title" className="text-lg font-semibold">
          {name}
        </h2>
        <span className="text-sm text-muted-foreground">
          {summary.kind === "CLASS" ? `${gradeName(summary.gradeLevel)} · ` : ""}
          {t("classPupils", { count: summary.pupilCount })}
        </span>
      </div>

      {drill.isError ? (
        <p className="text-sm text-foreground">{t("loadFailed")}</p>
      ) : !detail ? (
        <Skeleton className="h-40 w-full" />
      ) : (
        <ul className="space-y-3">
          {detail.lines.map((line) => (
            <li key={line.key}>
              <DeliveredLineCard line={line} name={lineName(line.key)} pupilLevel={pupilLevel} pupilCount={summary.pupilCount} />
            </li>
          ))}
        </ul>
      )}

      {pupilLevel ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">
              {showAll ? t("allPupilsTitle", { count: pupils.length }) : t("pupilsTitle", { count: listed.length })}
            </h3>
            <Button size="sm" variant="outline" aria-pressed={showAll} onClick={() => setShowAll((on) => !on)}>
              {showAll ? t("showOwnPupils") : t("showAllPupils")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("delivered.pupilsHint")}</p>
          {listed.length === 0 ? (
            <p className="text-sm text-foreground">{drill.isLoading ? "…" : t("groupPupilsNone")}</p>
          ) : (
            <ul className="space-y-2">
              {listed.map((pupil) => (
                <li key={pupil.pupilId} className="rounded-md border px-3 py-2 text-sm">
                  <p className="font-medium">{pupilName(pupil.pupilId)}</p>
                  <ul className="mt-1 space-y-1">
                    {pupil.lines.map((line) => {
                      const sources = line.sources
                        .map((source) =>
                          source.studentGroupId === null
                            ? t("delivered.sourceNamed", { hours: hoursOf(source.deliveredMinutes) })
                            : t("delivered.source", {
                                group: groupName(source.studentGroupId),
                                hours: hoursOf(source.deliveredMinutes),
                              }) +
                              (source.sharedWith.length > 0
                                ? ` ${t("delivered.sharedWith", { groups: source.sharedWith.map(groupName).join(", ") })}`
                                : ""),
                        )
                        .join(", ");
                      return (
                        <li key={line.key}>
                          <span
                            className={cn(
                              line.status === "SHORT" && "font-medium text-warning-foreground dark:text-warning",
                            )}
                          >
                            {t("delivered.pupilLine", {
                              subject: lineName(line.key),
                              delivered: hoursOf(line.deliveredMinutes),
                              projected: hoursOf(line.projectedMinutes),
                              planned: hoursOf(line.plannedYearMinutes - line.unrecordedMinutes),
                            })}
                          </span>
                          {sources ? <span className="text-muted-foreground"> — {sources}</span> : null}
                          {line.plannedYearMinutes > 0 && line.deliveredMinutes === 0 && line.publishedMinutes > 0 ? (
                            <span className="block text-xs text-foreground">{t("nothingDelivered")}</span>
                          ) : null}
                        </li>
                      );
                    })}
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

function DeliveredLineCard({
  line,
  name,
  pupilLevel,
  pupilCount,
}: {
  line: DeliveredLineSummary | DeliveredLineDetail;
  name: string;
  pupilLevel: boolean;
  pupilCount: number;
}) {
  const t = useTranslations("timplanCoverage");
  const tCause = useTranslations("timplanCoverage.delivered.cause");
  const tPart = useTranslations("timplanCoverage.delivered.projection");
  const detail = isDetail(line) ? line : null;
  const shares = detail ? lostShares(detail.lost) : [];
  const delta = deltaOf(line);
  return (
    <article className="space-y-2 rounded-md border p-3" aria-label={name}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="font-semibold">{name}</h3>
        <span className="text-sm tabular-nums">
          {t("delivered.cellLine", {
            subject: name,
            delivered: hoursOf(line.deliveredMinutes),
            published: hoursOf(line.publishedMinutes),
          })}
        </span>
        {line.status === "SHORT" ? (
          <span className="rounded-full bg-warning/15 px-2 text-xs font-semibold text-warning-foreground dark:text-warning">
            {tPart("short", { hours: hoursOf(-delta) })}
          </span>
        ) : line.status === "ON_TRACK" ? (
          <span className="rounded-full bg-accent/70 px-2 text-xs font-semibold text-accent-foreground">
            {tPart("onTrack")}
          </span>
        ) : null}
      </div>

      {detail ? (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <h4 className="text-xs font-semibold uppercase tracking-wide">{t("delivered.lostTitle")}</h4>
            {shares.length === 0 ? (
              <p className="text-sm">{t("delivered.lostNone")}</p>
            ) : (
              <>
                <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden>
                  {shares.map((share) => (
                    <span key={share.cause} className={CAUSE_FILL[share.cause]} style={{ width: `${share.percent}%` }} />
                  ))}
                </div>
                <ul className="space-y-0.5 text-sm">
                  {shares.map((share) => (
                    <li key={share.cause} className="flex items-center gap-2">
                      <span className={cn("inline-block size-2.5 rounded-sm", CAUSE_FILL[share.cause])} aria-hidden />
                      {t("delivered.causeLine", { cause: tCause(share.cause), hours: hoursOf(share.minutes) })}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {detail.cancelledOnBreak > 0 ? (
              <p className="text-sm">
                {t("delivered.causeLine", { cause: tCause("onBreak"), hours: hoursOf(detail.cancelledOnBreak) })}
              </p>
            ) : null}
            {detail.credits.length > 0 ? (
              <>
                <h4 className="pt-1 text-xs font-semibold uppercase tracking-wide">{t("delivered.creditsTitle")}</h4>
                <ul className="text-sm">
                  {detail.credits.map((credit) => (
                    <li key={credit.id}>
                      {t("delivered.creditLine", { date: credit.date, name: credit.name, minutes: credit.minutes })}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-sm">
            {(
              [
                ["deliveredSoFar", detail.projection.deliveredSoFar],
                ["calendarAhead", detail.projection.calendarAhead],
                ["masterAhead", detail.projection.masterAhead],
                ["creditsAhead", detail.projection.creditsAhead],
                ["projected", detail.projection.projectedMinutes],
                ["plannedYear", detail.projection.plannedYearMinutes],
              ] as const
            ).map(([part, minutes]) => (
              <Part key={part} label={tPart(part)} value={hoursOf(minutes)} strong={part === "projected"} />
            ))}
            {detail.projection.targetYearMinutes !== null ? (
              <Part label={tPart("target")} value={hoursOf(detail.projection.targetYearMinutes)} />
            ) : null}
            {detail.projection.unrecordedMinutes > 0 ? (
              <Part label={tPart("unrecorded")} value={hoursOf(detail.projection.unrecordedMinutes)} />
            ) : null}
            {detail.projection.aheadTeacherless > 0 ? (
              <Part label={tPart("aheadTeacherless")} value={hoursOf(detail.projection.aheadTeacherless)} />
            ) : null}
            {detail.projection.aheadCancelled > 0 ? (
              <Part label={tPart("aheadCancelled")} value={hoursOf(detail.projection.aheadCancelled)} />
            ) : null}
            <Part label={tPart("lost")} value={hoursOf(detail.projection.lostMinutes)} />
            <Part label={tPart("scheduleGap")} value={hoursOf(detail.projection.scheduleGapMinutes)} />
          </dl>
        </div>
      ) : null}

      {pupilLevel && line.pupils ? (
        <p className="text-sm">
          {t("delivered.statsDelta", {
            min: hoursOf(line.pupils.projectedDelta.min),
            median: hoursOf(line.pupils.projectedDelta.median),
            max: hoursOf(line.pupils.projectedDelta.max),
            below: line.pupils.belowPlanned,
            pupils: pupilCount,
          })}{" "}
          {t("delivered.statsDelivered", {
            min: hoursOf(line.pupils.delivered.min),
            median: hoursOf(line.pupils.delivered.median),
            max: hoursOf(line.pupils.delivered.max),
          })}
          {line.pupils.nothingDelivered > 0
            ? ` ${t("delivered.nothingCount", { count: line.pupils.nothingDelivered })}`
            : ""}
        </p>
      ) : null}
    </article>
  );
}

function Part({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <>
      <dt className={cn(strong && "font-semibold")}>{label}</dt>
      <dd className={cn("text-right tabular-nums", strong && "font-semibold")}>{value}</dd>
    </>
  );
}
