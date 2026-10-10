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
// now, the hours so far and the hours planned for the whole stage, and the
// timplan's hours where the national distribution is published — the
// reference data's figure, named by its source. No verdict, no colour and no
// "under": the school follows the figures up, and a family reading "1,1 h
// under" without the school's context reads alarm. The hours "so far" are
// "since 1 October 2026" whenever the stage is not recorded from its start,
// never "hittills" for a stage SchemaPro has seen only part of — a year
// before SchemaPro is not zero, and the card does not let it look like one.
// Nothing about another pupil and nothing about a teacher is in the statement.
//
// Loaded with lazy() by both pages, inside the core tier's budget: the pages
// carry only the import.

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { api } from "@/lib/api";

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
  /** Grades with no class history, and grades ahead no plan carries yet. */
  unrecordedGrades: number[];
  backfilled: boolean;
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
  const { data } = useTeachingTimeCard(studentId);
  const statement = data?.statement ?? null;
  if (!statement || statement.stages.length === 0) return null;
  const hours = (value: number) => `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} h`;
  const day = (value: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(new Date(`${value.slice(0, 10)}T12:00:00Z`));
  const grades = (list: number[]) => new Intl.ListFormat(locale, { type: "conjunction" }).format(list.map(String));
  const titleId = `teaching-time-${studentId}`;
  return (
    <section aria-labelledby={titleId} className="mt-6 rounded-lg border bg-card p-4 text-sm text-card-foreground shadow-sm">
      <h2 id={titleId} className="font-semibold">
        {childName ? t("titleChild", { name: childName }) : t("title")}
      </h2>
      <p className="text-muted-foreground">{t("updated", { date: day(statement.asOfDate) })}</p>
      {statement.stages.map((stage) => (
        <div key={stage.stage} className="mt-3 space-y-1">
          <h3 className="font-medium">
            {t("stage", { stage: stage.stage, from: stage.gradesFrom, to: stage.gradesTo })}
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-1.5 pr-3 font-medium">{t("subject")}</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                    {stage.complete || !stage.recordedFrom ? t("soFar") : t("since", { date: day(stage.recordedFrom) })}
                  </th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">{t("planned")}</th>
                  {stage.distributionPublished ? (
                    <th scope="col" className="py-1.5 text-right font-medium">{t("timplan")}</th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {stage.lines.map((line) => (
                  <tr key={line.subjectCode} className="border-b last:border-b-0">
                    <th scope="row" className="py-1.5 pr-3 text-left font-normal">{line.subjectName}</th>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{hours(line.outcomeHours)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{hours(line.plannedHours)}</td>
                    {stage.distributionPublished ? (
                      <td className="py-1.5 text-right tabular-nums">
                        {line.nationalHours === null ? "–" : hours(line.nationalHours)}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {stage.unrecordedGrades.length > 0 ? (
            <p className="text-xs text-muted-foreground">{t("unrecorded", { grades: grades(stage.unrecordedGrades) })}</p>
          ) : null}
          {!stage.distributionPublished ? (
            <p className="text-xs text-muted-foreground">{t("unpublished")}</p>
          ) : null}
        </div>
      ))}
      <p className="mt-3 max-w-prose text-xs text-muted-foreground">
        {t("footer", {
          versions:
            [...new Set(statement.stages.map((stage) => stage.versionCode).filter((code): code is string => code !== null))]
              .map((code) => code.replace(/^SFS(?=\d)/, "SFS ").replace("/", " "))
              .join(", ") || "none",
        })}
      </p>
    </section>
  );
}
