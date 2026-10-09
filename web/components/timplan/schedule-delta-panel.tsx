"use client";

// Lektionstid — schemalagt mot planerat, live on the timetable.
//
// Skola24's "Lektionstid %": per group and subject, the minutes a week the
// grundschema gives against the minutes its timplansposter plan. Computed
// here, in the browser, from the rows the board already holds, by the same
// module the gateway answers GET /timplan-coverage?layer=scheduled from
// (lib/timplan-scheduled.ts, parity-tested against the gateway's fixture). So
// a resize, a park, an unpark, a window change or a delete shows in the
// render the grid repaints in: every committed edit refetches `lessons`, and
// the figures below are a useMemo over them. A drag's ghost changes nothing
// until it is dropped, like the grid itself, and a pure move changes nothing
// at all — a week has no weekday.
//
// GROUP LEVEL ONLY (R18). The board passes no pupils: a group line counts the
// lessons the group owns or attends as an extra group against the group's own
// posts and reads no roster, so this panel equals the server's group lines
// for the same rows. Pupils — the one in two groups whose shared lesson
// counts once — are Täckning's, behind the link at the bottom.
//
// FETCHED ON THE FIRST PRESS. The page imports this file through React's
// lazy(), so the module, teacher-load's week arithmetic and lesson-lengths
// cost /admin/timetable nothing until somebody asks; the lov it needs come
// from useSchoolBreaks, which lib/queries already brings to the route.
//
// EVERYTHING IS A WARNING. "under planerat", never "fel": nothing here stops
// a save, and the law lets a pupil's studiegång deviate anyway.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { useSchoolBreaks } from "@/lib/queries";
import { standardWeekWeight } from "@/lib/teacher-load";
import { computeScheduledCoverage, lessonMinutes, type ScheduledCoverage } from "@/lib/timplan-scheduled";
import {
  buildScheduleDelta,
  changedLines,
  signedDelta,
  type ScheduleTone,
} from "@/lib/timplan-scheduled-view";
import type {
  AcademicYear,
  MasterLesson,
  StudentGroup,
  Subject,
  TeachingRequirement,
} from "@/lib/types";
import { cn } from "@/lib/utils";

/** The Mål mode's tones (components/timplan/requirements-target.tsx measures their contrast). */
const TONE: Record<ScheduleTone, string> = {
  missing: "border border-destructive text-destructive",
  short: "bg-warning/15 text-warning-foreground dark:text-warning",
  match: "bg-accent/70 text-accent-foreground",
  extra: "bg-accent/70 text-accent-foreground",
};

/** At most this many changed lines are read out at once; the rest are counted. */
const ANNOUNCED = 3;

/**
 * Each input is undefined until the board has it. The panel says "loading"
 * until every one has landed — a list standing in for one still on its way
 * would paint every line "inget schemalagt" and then announce the load as
 * an edit. The page keys the panel by year, so a year switch starts over
 * rather than reading the new year's lines as changes to the old one's.
 */
export interface ScheduleDeltaPanelProps {
  id: string;
  year: AcademicYear;
  lessons: readonly MasterLesson[] | undefined;
  requirements: readonly TeachingRequirement[] | undefined;
  /** The year's groups (the board's yearGroups). */
  groups: readonly StudentGroup[] | undefined;
  subjects: readonly Subject[] | undefined;
  /** The grid's group filter; empty is every group. */
  groupFilters: readonly string[];
}

export function ScheduleDeltaPanel({
  id,
  year,
  lessons,
  requirements,
  groups,
  subjects,
  groupFilters,
}: ScheduleDeltaPanelProps) {
  const t = useTranslations("timetable.lessonTime");
  const { data: breaks } = useSchoolBreaks(year.id);

  const coverage = useMemo<ScheduledCoverage | null>(() => {
    // Without the lov a dated row or lesson would weigh against the wrong
    // number of teaching weeks; wait for them rather than show a figure that
    // moves when they land. The same for the board's own lists.
    if (!breaks || !lessons || !requirements || !groups || !subjects) return null;
    return computeScheduledCoverage({
      year: { startDate: year.startDate, endDate: year.endDate },
      closures: breaks.map((row) => ({
        startDate: row.startDate,
        endDate: row.endDate,
        minGradeLevel: row.minGradeLevel,
        maxGradeLevel: row.maxGradeLevel,
      })),
      subjects: subjects.map((subject) => ({
        id: subject.id,
        name: subject.name,
        nationalCode: subject.nationalCode ?? null,
        countsTowardTimplan: subject.countsTowardTimplan !== false,
      })),
      groups: groups.map((group) => ({
        id: group.id,
        name: group.name,
        kind: group.kind,
        gradeLevel: group.gradeLevel,
      })),
      requirements: requirements.map((row) => ({
        id: row.id,
        studentGroupId: row.studentGroupId,
        subjectId: row.subjectId,
        lessonsPerWeek: row.lessonsPerWeek,
        minutesPerLesson: row.minutesPerLesson,
        lessonLengths: row.lessonLengths ?? [],
        recurrence: row.recurrence,
        startDate: row.startDate,
        endDate: row.endDate,
      })),
      lessons: lessons.map((lesson) => ({
        id: lesson.id,
        studentGroupId: lesson.studentGroupId,
        subjectId: lesson.subjectId,
        startTime: lesson.startTime,
        endTime: lesson.endTime,
        recurrence: lesson.recurrence,
        startDate: lesson.startDate,
        endDate: lesson.endDate,
        isParked: lesson.isParked,
        extraGroupIds: lesson.extraGroupIds ?? [],
        studentIds: lesson.studentIds ?? [],
      })),
      pupils: [],
      includePupils: false,
    });
  }, [breaks, year.startDate, year.endDate, subjects, groups, requirements, lessons]);

  // Each parked lesson's minutes a week, once: a combined lesson parked
  // reaches every group it is on, and its minutes stand on each of their
  // lines — right per line, but a summary adding the lines counted it once a
  // group. Weighed at the owner's årskurs, as its own line weighs it.
  const parked = useMemo(() => {
    const minutes = new Map<string, number>();
    if (!breaks || !lessons || !groups) return minutes;
    const gradeOf = new Map(groups.map((group) => [group.id, group.kind === "CLASS" ? group.gradeLevel : null]));
    const closures = breaks.map((row) => ({
      startDate: row.startDate,
      endDate: row.endDate,
      minGradeLevel: row.minGradeLevel,
      maxGradeLevel: row.maxGradeLevel,
    }));
    for (const lesson of lessons) {
      if (!lesson.isParked) continue;
      const grade = gradeOf.get(lesson.studentGroupId) ?? null;
      const weight = standardWeekWeight(
        {
          recurrence: lesson.recurrence ?? "ALL_WEEKS",
          startDate: lesson.startDate ?? null,
          endDate: lesson.endDate ?? null,
          gradeSpan: grade === null ? null : { min: grade, max: grade },
        },
        { startDate: year.startDate, endDate: year.endDate },
        closures,
      );
      minutes.set(lesson.id, lessonMinutes(lesson) * weight);
    }
    return minutes;
  }, [breaks, lessons, groups, year.startDate, year.endDate]);

  const view = useMemo(
    () => (coverage && groups && subjects ? buildScheduleDelta(coverage, groupFilters, groups, subjects, parked) : null),
    [coverage, groupFilters, groups, subjects, parked],
  );

  // One polite line naming only what changed since the last answer. The first
  // answer is the panel opening, not a change, and says nothing.
  const previous = useRef<ScheduledCoverage | null>(null);
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (!coverage) return;
    const before = previous.current;
    previous.current = coverage;
    if (!before) return;
    // Only the groups in view: a line of a group the grid is not showing
    // changed by nothing this person did here.
    const inView = new Set(groupFilters);
    const changed = changedLines(before, coverage).filter(
      ({ studentGroupId }) => inView.size === 0 || inView.has(studentGroupId),
    );
    if (changed.length === 0) return;
    const groupName = new Map((groups ?? []).map((group) => [group.id, group.name]));
    const subjectName = new Map((subjects ?? []).map((subject) => [subject.id, subject.name]));
    const said = changed.slice(0, ANNOUNCED).map(({ studentGroupId, line }) =>
      t("announce", {
        group: groupName.get(studentGroupId) ?? "",
        subject: subjectName.get(line.subjectId) ?? "",
        scheduled: line.scheduledMinutesPerWeek,
        planned: line.plannedMinutesPerWeek,
      }),
    );
    if (changed.length > ANNOUNCED) said.push(t("announceMore", { count: changed.length - ANNOUNCED }));
    setAnnouncement(said.join(" "));
  }, [coverage, groupFilters, groups, subjects, t]);

  const onlyGroup = groupFilters.length === 1 ? groupFilters[0]! : null;
  const coverageHref =
    `/admin/timplan/tackning?year=${encodeURIComponent(year.id)}&layer=scheduled` +
    (onlyGroup ? `&group=${encodeURIComponent(onlyGroup)}` : "");

  return (
    <section
      id={id}
      role="region"
      aria-label={t("region")}
      className="mb-4 space-y-2 rounded-lg border bg-card p-3 text-sm text-foreground"
    >
      <p className="max-w-prose text-xs leading-relaxed">{t("intro")}</p>
      {!view ? (
        <p>{t("loading")}</p>
      ) : view.total === 0 ? (
        <p>{t("empty")}</p>
      ) : (
        <>
          <p className="font-medium">
            {t("summary", { matching: view.matching, total: view.total })}
            {view.parkedMinutes > 0 ? ` · ${t("parked", { minutes: view.parkedMinutes })}` : ""}
          </p>
          {view.groups.length === 0 ? (
            <p>{t("allMatch")}</p>
          ) : (
            <ul className="max-h-64 space-y-2 overflow-y-auto pr-1">
              {view.groups.map((group) => (
                <li key={group.studentGroupId}>
                  <p className="font-medium">{group.groupName}</p>
                  <ul className="mt-1 flex flex-wrap gap-1.5">
                    {group.lines.map(({ key, subjectName, line, tone }) => {
                      const sentence =
                        line.status === "UNSCHEDULED"
                          ? t("unscheduled", { subject: subjectName, planned: line.plannedMinutesPerWeek })
                          : line.status === "UNPLANNED"
                            ? t("unplanned", { subject: subjectName, scheduled: line.scheduledMinutesPerWeek })
                            : t("line", {
                                subject: subjectName,
                                scheduled: line.scheduledMinutesPerWeek,
                                planned: line.plannedMinutesPerWeek,
                              });
                      return (
                        <li
                          key={key}
                          className={cn("rounded-md px-2 py-1 text-xs tabular-nums", TONE[tone])}
                        >
                          <span aria-hidden>
                            <span className="font-semibold">{subjectName}</span>{" "}
                            {line.scheduledMinutesPerWeek} / {line.plannedMinutesPerWeek}
                            {line.deltaMinutesPerWeek !== 0 ? ` · ${signedDelta(line.deltaMinutesPerWeek)}` : ""}
                            {line.percent !== null && line.percent !== 100 ? ` · ${line.percent} %` : ""}
                          </span>
                          <span className="sr-only">{sentence}</span>
                          {line.parkedMinutesPerWeek > 0 ? (
                            <span className="block">{t("parked", { minutes: line.parkedMinutesPerWeek })}</span>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </p>
      <Link href={coverageHref} className="inline-block text-xs font-medium underline underline-offset-4">
        {t("openCoverage")}
      </Link>
    </section>
  );
}
