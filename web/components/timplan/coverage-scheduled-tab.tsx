"use client";

// Täckning, layer 2 — Schemalagt mot planerat (Skola24's Lektionstid %).
//
// Per group and subject, the minutes a week the year's grundschema gives
// against the minutes its timplansposter plan, as the gateway computes them
// (GET /timplan-coverage?layer=scheduled, src/common/timplan-scheduled.ts).
// Classes down the side, teaching groups under them; each cell "schemalagt /
// planerat" with the signed difference. A group's drill-down resolves its
// lessons to "Måndag 08:00–09:00 (udda veckor)", names the parked minutes, and
// — for an admin — the pupils' spread over their own difference and the
// pupils with a shortfall of their own: a lesson that reaches a pupil through
// two groups counts once against both groups' posts, and only a pupil view
// shows it.
//
// The timetable's Lektionstid panel shows the same figures live while the
// grundschema is edited; this tab is the whole year at once, and the pupils.
//
// Loaded with lazy() when the tab is first chosen, so the planned layer's
// route carries none of it.

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { CalendarDays, TriangleAlert } from "lucide-react";
import { useMasterLessons } from "@/lib/queries";
import { useScheduledCoverage, type ScheduledCoverageResponse } from "@/lib/timplan-scheduled-queries";
import type { ScheduledGroupSummary, ScheduledLine, ScheduledPupil } from "@/lib/timplan-scheduled";
import { scheduleTone, signedDelta, type ScheduleTone } from "@/lib/timplan-scheduled-view";
import type { MasterLesson } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

/** The Mål mode's tones, as the planned tab and the timetable panel paint them. */
const TONE: Record<ScheduleTone, string> = {
  missing: "border border-destructive text-destructive",
  short: "bg-warning/15 text-warning-foreground dark:text-warning",
  match: "bg-accent/70 text-accent-foreground",
  extra: "bg-accent/70 text-accent-foreground",
};

export interface CoverageTabProps {
  year: { id: string; name: string };
  /** The group the deep link opened, until another is chosen. */
  linkedGroup: string | null;
  groupName: (id: string) => string;
  subjects: readonly { id: string; name: string }[];
  pupilName: (id: string) => string;
  gradeName: (grade: number | null) => string;
}

export function CoverageScheduledTab({ year, linkedGroup, groupName, subjects, pupilName, gradeName }: CoverageTabProps) {
  const t = useTranslations("timplanCoverage");
  const overview = useScheduledCoverage(year.id);
  const [chosen, setChosen] = useState<string | null>(null);
  const groupId = chosen ?? linkedGroup;
  const coverage = overview.data && overview.data.academicYearId === year.id ? overview.data : null;
  const selected = coverage?.groups.find((g) => g.studentGroupId === groupId) ?? null;

  const columns = useMemo(() => {
    if (!coverage) return [];
    const used = new Set(coverage.groups.flatMap((g) => g.lines.map((line) => line.subjectId)));
    const known = subjects.filter((s) => used.has(s.id));
    const knownIds = new Set(known.map((s) => s.id));
    return [
      ...known.map((s) => ({ id: s.id, name: s.name })),
      ...[...used].filter((id) => !knownIds.has(id)).sort().map((id) => ({ id, name: id })),
    ];
  }, [coverage, subjects]);

  // A group reached by a link (the timetable's "Se alla i Täckning") is
  // scrolled to once its drill-down is on screen — it opens below the whole
  // table, and P2's tab does the same for its class.
  useEffect(() => {
    if (!selected || chosen !== null) return;
    document.getElementById("tackning-scheduled-group")?.scrollIntoView?.({ block: "start" });
  }, [selected, chosen]);

  if (overview.isLoading || (!coverage && !overview.isError)) return <Skeleton className="h-96 w-full" />;
  if (overview.isError || !coverage) {
    return <EmptyState icon={TriangleAlert} title={t("loadFailed")} description={t("loadFailedHint")} />;
  }
  if (coverage.lessonCount === 0 && coverage.verdicts.some((v) => v.code === "TIMPLAN_SCHEDULE_NONE")) {
    return <EmptyState icon={CalendarDays} title={t("scheduled.noLessons")} description={t("scheduled.noLessonsBody")} />;
  }
  if (coverage.groups.length === 0) {
    return <EmptyState icon={CalendarDays} title={t("scheduled.noLines")} />;
  }

  const classes = coverage.groups.filter((g) => g.kind === "CLASS");
  const teaching = coverage.groups.filter((g) => g.kind === "TEACHING_GROUP");
  const row = (summary: ScheduledGroupSummary) => (
    <ScheduledRow
      key={summary.studentGroupId}
      summary={summary}
      name={groupName(summary.studentGroupId)}
      columns={columns}
      open={summary.studentGroupId === groupId}
      gradeName={gradeName}
      onToggle={() => setChosen(summary.studentGroupId === groupId ? "" : summary.studentGroupId)}
    />
  );

  return (
    <div className="space-y-4">
      <section className="space-y-2 text-sm text-foreground" aria-label={t("summaryLabel")}>
        <p role="status" className="font-medium">
          {coverage.pupilsBelowPlanned === null
            ? t("pupilsTotal", { pupils: coverage.pupilCount })
            : t("scheduled.pupilsSummary", { pupils: coverage.pupilCount, below: coverage.pupilsBelowPlanned })}{" "}
          {t("scheduled.lessonCount", { count: coverage.lessonCount })}
        </p>
        <p className="text-xs text-muted-foreground">{t("scheduled.legend")}</p>
      </section>

      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{t("scheduled.caption", { year: year.name })}</caption>
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th scope="col" className="sticky left-0 z-10 bg-card px-3 py-2 font-medium">
                {t("scheduled.groupColumn")}
              </th>
              {columns.map((subject) => (
                <th key={subject.id} scope="col" className="px-2 py-2 text-center font-medium">
                  {subject.name}
                </th>
              ))}
              <th scope="col" className="px-3 py-2 text-right font-medium">
                {t("scheduled.totalColumn")}
              </th>
            </tr>
          </thead>
          <tbody>
            {classes.map(row)}
            {teaching.length > 0 ? (
              <tr className="border-b bg-muted/40">
                <th scope="colgroup" colSpan={columns.length + 2} className="px-3 py-1.5 text-left text-xs font-medium">
                  {t("teachingGroups")}
                </th>
              </tr>
            ) : null}
            {teaching.map(row)}
          </tbody>
        </table>
      </div>

      {selected ? (
        <ScheduledDrillDown
          yearId={year.id}
          summary={selected}
          overview={coverage}
          name={groupName(selected.studentGroupId)}
          subjectName={(id) => columns.find((c) => c.id === id)?.name ?? id}
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

interface RowProps {
  summary: ScheduledGroupSummary;
  name: string;
  columns: { id: string; name: string }[];
  open: boolean;
  gradeName: (grade: number | null) => string;
  onToggle: () => void;
}

function ScheduledRow({ summary, name, columns, open, gradeName, onToggle }: RowProps) {
  const t = useTranslations("timplanCoverage");
  const lines = new Map(summary.lines.map((line) => [line.subjectId, line]));
  return (
    <tr className={cn("border-b last:border-b-0", open && "bg-muted/50")}>
      <th scope="row" className="sticky left-0 z-10 bg-card px-3 py-1.5 text-left align-middle font-medium">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={open ? "tackning-scheduled-group" : undefined}
          className="flex flex-col items-start text-left underline-offset-2 hover:underline"
        >
          <span>{name}</span>
          <span className="text-xs font-normal text-muted-foreground">
            {summary.kind === "CLASS" ? `${gradeName(summary.gradeLevel)} · ` : ""}
            {t("scheduled.matchLabel", { matching: summary.linesMatching, total: summary.linesTotal })}
          </span>
        </button>
      </th>
      {columns.map((subject) => {
        const line = lines.get(subject.id);
        return line ? (
          <td key={subject.id} className="px-1 py-1">
            <ScheduledCell line={line} subjectName={subject.name} />
          </td>
        ) : (
          <td key={subject.id} className="px-2 py-1.5 text-center text-muted-foreground">
            <span aria-hidden>·</span>
          </td>
        );
      })}
      <td className="px-3 py-1.5 text-right tabular-nums font-medium">
        {summary.scheduledMinutesPerWeek} / {summary.plannedMinutesPerWeek}
      </td>
    </tr>
  );
}

function lineSentence(
  t: ReturnType<typeof useTranslations>,
  line: ScheduledLine,
  subject: string,
): string {
  if (line.status === "UNSCHEDULED") return t("scheduled.cellUnscheduled", { subject, planned: line.plannedMinutesPerWeek });
  if (line.status === "UNPLANNED") return t("scheduled.cellUnplanned", { subject, scheduled: line.scheduledMinutesPerWeek });
  return t("scheduled.cellLine", {
    subject,
    scheduled: line.scheduledMinutesPerWeek,
    planned: line.plannedMinutesPerWeek,
  });
}

function ScheduledCell({ line, subjectName }: { line: ScheduledLine; subjectName: string }) {
  const t = useTranslations("timplanCoverage");
  const tone = scheduleTone(line.status);
  return (
    <div
      className={cn(
        "mx-auto flex min-h-10 min-w-16 flex-col items-center justify-center rounded-md px-1",
        TONE[tone],
      )}
    >
      <span className="text-sm font-semibold tabular-nums" aria-hidden>
        {line.scheduledMinutesPerWeek} / {line.plannedMinutesPerWeek}
      </span>
      {line.deltaMinutesPerWeek !== 0 ? (
        <span className="text-[10px] font-semibold leading-tight tabular-nums" aria-hidden>
          {signedDelta(line.deltaMinutesPerWeek)}
        </span>
      ) : null}
      <span className="sr-only">{lineSentence(t, line, subjectName)}</span>
    </div>
  );
}

interface DrillProps {
  yearId: string;
  summary: ScheduledGroupSummary;
  overview: ScheduledCoverageResponse;
  name: string;
  subjectName: (id: string) => string;
  groupName: (id: string) => string;
  pupilName: (id: string) => string;
  gradeName: (grade: number | null) => string;
}

function ScheduledDrillDown({
  yearId,
  summary,
  overview,
  name,
  subjectName,
  groupName,
  pupilName,
  gradeName,
}: DrillProps) {
  const t = useTranslations("timplanCoverage");
  const tDays = useTranslations("days");
  const pupilLevel = overview.pupilLevel;
  // The pupils of this group come with the drill-down; a teacher's has none.
  const drill = useScheduledCoverage(pupilLevel ? yearId : null, summary.studentGroupId);
  const { data: masters } = useMasterLessons(yearId);
  const [showAll, setShowAll] = useState(false);

  const lessonById = useMemo(() => new Map((masters ?? []).map((lesson) => [lesson.id, lesson])), [masters]);
  const when = (lesson: MasterLesson): string => {
    const text = t("scheduled.lessonWhen", {
      day: tDays(String(lesson.dayOfWeek)),
      start: lesson.startTime.slice(0, 5),
      end: lesson.endTime.slice(0, 5),
    });
    const weeks =
      lesson.recurrence === "ODD_WEEKS"
        ? ` (${t("scheduled.oddWeeks")})`
        : lesson.recurrence === "EVEN_WEEKS"
          ? ` (${t("scheduled.evenWeeks")})`
          : "";
    return `${text}${weeks}${lesson.isParked ? ` · ${t("scheduled.lessonParked")}` : ""}`;
  };

  // A finding of one's own is a pupil verdict; the overview names every one.
  const own = useMemo(
    () =>
      new Map(
        overview.verdicts
          .filter((v) => v.code === "TIMPLAN_PUPIL_SCHEDULE_SHORT" && v.pupilId)
          .map((v) => [`${v.pupilId}|${v.subjectIds?.[0] ?? ""}`, true] as const),
      ),
    [overview.verdicts],
  );
  const pupils: ScheduledPupil[] =
    drill.data && drill.data.academicYearId === yearId ? (drill.data.pupils ?? []) : [];
  // A finding is about one subject: under this group a pupil is listed only
  // for a subject the group has a line in, and only that line is shown.
  const groupSubjects = new Set(summary.lines.map((line) => line.subjectId));
  const ownLine = (pupilId: string, subjectId: string) =>
    groupSubjects.has(subjectId) && own.has(`${pupilId}|${subjectId}`);
  const ownPupils = pupils.filter((pupil) => pupil.lines.some((line) => ownLine(pupil.pupilId, line.subjectId)));
  const listed = showAll ? pupils : ownPupils;

  return (
    <section
      id="tackning-scheduled-group"
      aria-labelledby="tackning-scheduled-title"
      className="scroll-mt-4 space-y-4 rounded-lg border bg-card p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="tackning-scheduled-title" className="text-lg font-semibold">
          {name}
        </h2>
        <span className="text-sm text-muted-foreground">
          {summary.kind === "CLASS" ? `${gradeName(summary.gradeLevel)} · ` : ""}
          {t("classPupils", { count: summary.pupilCount })}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="sr-only">{t("linesCaption", { group: name })}</caption>
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th scope="col" className="py-2 pr-3 font-medium">{t("lineSubject")}</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">{t("scheduled.linePlanned")}</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">{t("scheduled.lineScheduled")}</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">{t("scheduled.lineParked")}</th>
              <th scope="col" className="py-2 pr-3 font-medium">{t("scheduled.lineLessons")}</th>
              {pupilLevel ? (
                <>
                  <th scope="col" className="py-2 pr-3 text-right font-medium">{t("scheduled.linePupils")}</th>
                  <th scope="col" className="py-2 text-right font-medium">{t("scheduled.lineBelow")}</th>
                </>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {summary.lines.map((line) => (
              <tr key={line.subjectId} className="border-b align-top last:border-b-0">
                <th scope="row" className="py-1.5 pr-3 text-left font-medium">
                  {subjectName(line.subjectId)}
                </th>
                <td className="py-1.5 pr-3 text-right tabular-nums">{line.plannedMinutesPerWeek}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums">
                  {line.scheduledMinutesPerWeek}
                  {line.deltaMinutesPerWeek !== 0 ? (
                    <span
                      className={cn(
                        "ml-1 text-xs",
                        line.deltaMinutesPerWeek < 0 && "font-medium text-warning-foreground dark:text-warning",
                      )}
                    >
                      {signedDelta(line.deltaMinutesPerWeek)}
                    </span>
                  ) : null}
                  {line.percent !== null ? (
                    <span className="block text-xs text-muted-foreground">
                      {t("scheduled.percent", { percent: line.percent })}
                    </span>
                  ) : null}
                </td>
                <td className="py-1.5 pr-3 text-right tabular-nums">{line.parkedMinutesPerWeek || "–"}</td>
                <td className="py-1.5 pr-3 text-xs">
                  {line.masterLessonIds.length === 0 ? (
                    "–"
                  ) : (
                    <ul>
                      {line.masterLessonIds.map((id) => {
                        const lesson = lessonById.get(id);
                        return <li key={id}>{lesson ? when(lesson) : "…"}</li>;
                      })}
                    </ul>
                  )}
                </td>
                {pupilLevel ? (
                  <>
                    <td className="py-1.5 pr-3 text-right tabular-nums">
                      {line.pupils
                        ? t("stats", {
                            min: signedDelta(line.pupils.min),
                            median: signedDelta(line.pupils.median),
                            max: signedDelta(line.pupils.max),
                          })
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
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">
              {showAll
                ? t("allPupilsTitle", { count: pupils.length })
                : t("pupilsTitle", { count: ownPupils.length })}
            </h3>
            <Button size="sm" variant="outline" aria-pressed={showAll} onClick={() => setShowAll((on) => !on)}>
              {showAll ? t("showOwnPupils") : t("showAllPupils")}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t("scheduled.pupilsHint")}</p>
          {drill.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : listed.length === 0 ? (
            <p className="text-sm text-foreground">{t("groupPupilsNone")}</p>
          ) : (
            <ul className="space-y-2">
              {listed.map((pupil) => (
                <li key={pupil.pupilId} className="rounded-md border px-3 py-2 text-sm">
                  <p className="font-medium">{pupilName(pupil.pupilId)}</p>
                  <ul className="mt-1 space-y-1">
                    {pupil.lines
                      .filter((line) => showAll || ownLine(pupil.pupilId, line.subjectId))
                      .map((line) => {
                        const short = line.scheduledMinutesPerWeek < line.plannedMinutesPerWeek;
                        const sources = line.sources
                          .map((source) =>
                            source.studentGroupId === null
                              ? t("scheduled.sourceNamed", { minutes: source.minutesPerWeek })
                              : t("source", { group: groupName(source.studentGroupId), minutes: source.minutesPerWeek }),
                          )
                          .join(", ");
                        return (
                          <li key={line.subjectId}>
                            <span className={cn(short && "font-medium text-warning-foreground dark:text-warning")}>
                              {t("scheduled.pupilLine", {
                                subject: subjectName(line.subjectId),
                                scheduled: line.scheduledMinutesPerWeek,
                                planned: line.plannedMinutesPerWeek,
                              })}
                            </span>
                            {sources ? <span className="text-muted-foreground"> — {sources}</span> : null}
                            {line.groupDeficitMinutesPerWeek > 0 ? (
                              <span className="block text-xs text-foreground">
                                {t("scheduled.pupilGroupDeficit", { minutes: line.groupDeficitMinutesPerWeek })}
                              </span>
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
