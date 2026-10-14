"use client";

// "Undervisningstid" — one pupil's teaching time over their current stadium,
// read-only, for the pupil on /student and for each child on /guardian
// (timplan P4).
//
// WHAT IT READS. GET /timplan-stages/card, the statement the school
// PUBLISHED on Täckning › Stadium, read under the caller's own RLS: a pupil
// reads their own (the gateway answers with the caller's id whatever is
// sent), a guardian a child of theirs, nothing else exists to read. Null —
// and the card renders nothing at all — when the school has not published,
// when the publication's läsår is no longer the active one (last year's
// figures must not show all autumn after an activation), or when RLS hides
// the pupil. A TEACHER is refused the route, so neither page asks for one.
//
// WHAT IT SAYS, in plain words: per subject of the stage the pupil is in
// now, the hours so far and the hours planned, and the timplan's hours where
// the national distribution is published — the reference data's figure,
// named by its source. No verdict, no colour and no "under": the school
// follows the figures up, and a family reading "1,1 h under" without the
// school's context reads alarm. Every figure says what it covers:
//
//   * The hours "so far" are "since 1 October 2026" whenever the stage is not
//     recorded from its start, or its class was backfilled — never "hittills"
//     for a stage SchemaPro has seen only part of, nor for a class the
//     database only assumed. A backfilled stage says until when its class is
//     assumed (the day the class history began).
//   * "Planerat" is for the whole stage only when every grade is known; else
//     it names the grades it covers ("Planerat åk 5 och 6"), and the
//     timplan's hours — always the whole stage's — are not set beside it.
//   * Grades with no class history ("inte registrerad") and grades ahead no
//     plan carries yet ("ingen timplan ännu") are told apart.
//
// A year before SchemaPro is not zero, and the card does not let it look
// like one. Nothing about another pupil and nothing about a teacher is in
// the statement.
//
// Loaded with lazy() by both pages, inside the core tier's budget: the pages
// carry only the import.

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { api } from "@/lib/api";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { TableScroll } from "@/components/ui/table-scroll";

/** One subject of the stage, as the gateway's TeachingTimeLine. */
export interface TeachingTimeLine {
  subjectCode: string;
  subjectName: string;
  nationalHours: number | null;
  plannedHours: number;
  outcomeHours: number;
  projectedHours: number;
  status: string;
  projectedStatus: string;
}

export interface TeachingTimeStage {
  stage: "LAG" | "LAG_MELLAN" | "MELLAN" | "HOG";
  versionCode: string | null;
  distributionPublished: boolean;
  gradesFrom: number;
  gradesTo: number;
  /** Every grade recorded in full or planned ahead. */
  complete: boolean;
  /** The first day recorded in the stage. */
  recordedFrom: string | null;
  plannedGrades: number[];
  /** Grades with no class history. */
  unrecordedGrades: number[];
  /** Grades ahead that no plan carries yet. */
  unplannedGrades: number[];
  backfilled: boolean;
  /** When backfilled: the day the class history began; the class before it is assumed. */
  historyFrom: string | null;
  lines: TeachingTimeLine[];
}

export interface TeachingTimeCardResponse {
  statement: {
    studentId: string;
    academicYearId: string;
    /** The school's day the statement was published (its rows carry it; the publication row is the admin's). */
    asOfDate: string;
    stages: TeachingTimeStage[];
  } | null;
}

/** The card's read, per pupil; the statement changes only when the school republishes. */
export function useTeachingTimeCard(studentId: string | null) {
  return useQuery({
    queryKey: ["teachingTimeCard", studentId ?? ""],
    enabled: studentId !== null,
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      api.get<TeachingTimeCardResponse>(`/api/v1/timplan-stages/card?studentId=${encodeURIComponent(studentId!)}`),
  });
}

export function TeachingTimeCard({ studentId, childName }: { studentId: string; childName?: string }) {
  const t = useTranslations("teachingTime");
  const locale = useLocale();
  const { data, isError } = useTeachingTimeCard(studentId);
  const statement = data?.statement ?? null;
  const id = `teaching-time-${studentId}`;
  const title = childName ? t("titleChild", { name: childName }) : t("title");
  // A read that failed is said, in the card's own place: silence would read
  // as "the school has not published", which is a different answer. While
  // it loads the card stays away, as it does for a school that has not
  // published — most pupils never see one, and a skeleton that then vanishes
  // would move the page under the reader.
  if (isError) {
    return (
      <SectionCard id={id} title={title}>
        <LoadError variant="inline" title={t("loadFailed")} hint={t("loadFailedHint")} />
      </SectionCard>
    );
  }
  if (!statement || statement.stages.length === 0) return null;
  const hours = (value: number) => `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} h`;
  const day = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${value.slice(0, 10)}T12:00:00Z`));
  const grades = (list: number[]) => new Intl.ListFormat(locale, { type: "conjunction" }).format(list.map(String));
  return (
    <SectionCard id={id} title={title} description={t("updated", { date: day(statement.asOfDate) })} className="text-sm">
      {statement.stages.map((stage) => {
        // "Hittills" only for a stage recorded from its start AND not backfilled.
        const since = (!stage.complete || stage.backfilled) && stage.recordedFrom !== null;
        // The grades the planned figure covers: the stage's, less those SchemaPro
        // has no history for and those no plan carries yet.
        const left = new Set([...stage.unrecordedGrades, ...stage.unplannedGrades]);
        const covered = Array.from({ length: stage.gradesTo - stage.gradesFrom + 1 }, (_, i) => stage.gradesFrom + i).filter(
          (grade) => !left.has(grade),
        );
        const whole = stage.complete || covered.length === 0;
        // The timplan's hours are the whole stage's: beside a partial figure they read as a shortfall.
        const national = stage.distributionPublished && stage.complete;
        const assumedUntil =
          stage.backfilled && stage.historyFrom !== null && (stage.recordedFrom === null || stage.historyFrom > stage.recordedFrom)
            ? stage.historyFrom
            : null;
        return (
          <div key={stage.stage} className="space-y-1">
            <h3 className="text-sm font-semibold">
              {t("stage", { stage: stage.stage, from: stage.gradesFrom, to: stage.gradesTo })}
            </h3>
            <TableScroll>
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th scope="col" className="py-1.5 pr-3 font-medium">{t("subject")}</th>
                    <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                      {since ? t("since", { date: day(stage.recordedFrom!) }) : t("soFar")}
                    </th>
                    <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                      {whole ? t("planned") : t("plannedGrades", { grades: grades(covered) })}
                    </th>
                    {national ? <th scope="col" className="py-1.5 text-right font-medium">{t("timplan")}</th> : null}
                  </tr>
                </thead>
                <tbody>
                  {stage.lines.map((line) => (
                    <tr key={line.subjectCode} className="border-b last:border-b-0">
                      <th scope="row" className="py-1.5 pr-3 text-left font-normal">{line.subjectName}</th>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{hours(line.outcomeHours)}</td>
                      <td className="py-1.5 pr-3 text-right tabular-nums">{hours(line.plannedHours)}</td>
                      {national ? (
                        <td className="py-1.5 text-right tabular-nums">
                          {line.nationalHours === null ? <span className="text-muted-foreground">—</span> : hours(line.nationalHours)}
                        </td>
                      ) : null}
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableScroll>
            {assumedUntil !== null ? (
              <p className="text-xs text-muted-foreground">{t("backfilled", { date: day(assumedUntil) })}</p>
            ) : null}
            {stage.unrecordedGrades.length > 0 ? (
              <p className="text-xs text-muted-foreground">{t("unrecorded", { grades: grades(stage.unrecordedGrades) })}</p>
            ) : null}
            {stage.unplannedGrades.length > 0 ? (
              <p className="text-xs text-muted-foreground">{t("unplanned", { grades: grades(stage.unplannedGrades) })}</p>
            ) : null}
            {stage.distributionPublished && !stage.complete ? (
              <p className="text-xs text-muted-foreground">{t("timplanWhenComplete")}</p>
            ) : null}
            {!stage.distributionPublished ? (
              <p className="text-xs text-muted-foreground">{t("unpublished")}</p>
            ) : null}
          </div>
        );
      })}
      <p className="max-w-prose text-xs text-muted-foreground">
        {t("footer", {
          versions:
            [...new Set(statement.stages.map((stage) => stage.versionCode).filter((code): code is string => code !== null))]
              .map((code) => code.replace(/^SFS(?=\d)/, "SFS ").replace("/", " "))
              .join(", ") || "none",
        })}
      </p>
    </SectionCard>
  );
}
