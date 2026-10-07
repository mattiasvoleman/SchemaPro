"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import {
  cellValue,
  formatPercent,
  groupsInSubject,
  matrixColumns,
  type UnitView,
  type WeekView,
} from "@/lib/staffing-view";
import type { LoadStatus, TeacherLoad, TeacherLoadReport } from "@/lib/teacher-load";
import { subjectColor } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { LoadBar } from "@/components/staffing/load-bar";

export interface StaffingMatrixProps {
  report: TeacherLoadReport;
  subjects: { id: string; name: string; code: string | null; color?: string | null }[];
  requirements: {
    subjectId: string;
    studentGroupId: string;
    teacherId: string | null;
    coTeacherId: string | null;
  }[];
  groupName: (groupId: string) => string;
  teacherName: (userId: string) => string;
  week: WeekView;
  unit: UnitView;
  onOpenTeacher: (userId: string) => void;
}

const STATUS_VARIANT: Record<LoadStatus, "destructive" | "warning" | "success" | "outline"> = {
  OVER: "destructive",
  UNDER: "warning",
  OK: "success",
  NO_TARGET: "outline",
};

export function StatusBadge({ status }: { status: LoadStatus }) {
  const t = useTranslations("staffing");
  return <Badge variant={STATUS_VARIANT[status]}>{t(`status${status}`)}</Badge>;
}

/**
 * Teachers down the side, subjects across the top, minutes (or the SCB
 * share) in the cells, and the six figures that answer "is this post full"
 * pinned to the right.
 *
 * The cells are read-only; the row opens a drawer about the person, and the
 * drawer is where a row's teacher is changed (Fas 2) — a cell sums several
 * groups, so it cannot say which timplanspost a click would mean. The order is the REPORT's order, which the gateway (and
 * the mirror) sort OVER first, then UNDER, OK and NO_TARGET, then by id: the
 * matrix is read to find the problem rows, so they are at the top. Nothing
 * here re-sorts, because a second sort would be a second opinion about which
 * row is the problem.
 *
 * STICKY, like the timplan: the container scrolls, the header is pinned to its
 * top, the name column to its left and the six figures to its right, so a
 * school with fifteen subjects can scroll sideways without losing whose row
 * it is reading or what the row adds up to. The offsets of the right-hand
 * columns are fixed widths and have to move together — see admin/requirements
 * for why `min-w`/`max-w` and not `w`.
 *
 * CONTRAST, MEASURED (HSL tokens from app/globals.css, 8-bit rounded; light,
 * then dark): foreground on card 18.69 / 15.43 for every number; muted-fg on
 * card 4.83 / 6.17 for the "—" of an empty cell, AA, which is the token the
 * whole product uses for secondary text; the status badges are the product's
 * own variants. The bar's own measurement is in load-bar.tsx.
 */
export function StaffingMatrix({
  report,
  subjects,
  requirements,
  groupName,
  teacherName,
  week,
  unit,
  onOpenTeacher,
}: StaffingMatrixProps) {
  const t = useTranslations("staffing");
  const columns = useMemo(() => matrixColumns(report, subjects), [report, subjects]);
  const colorOf = (id: string) =>
    subjectColor(id, subjects.find((subject) => subject.id === id)?.color ?? null);

  const teaching = (teacher: TeacherLoad) =>
    week === "peak" ? teacher.peakMinutesPerWeek : teacher.assignedMinutesPerWeek;

  const balanceText = (teacher: TeacherLoad) => {
    if (teacher.balanceMinutesPerWeek === null) return "—";
    const balance = teacher.balanceMinutesPerWeek;
    return balance > 0 ? `+${balance}` : String(balance);
  };

  return (
    <div className="max-h-[70vh] overflow-auto rounded-lg border bg-card">
      <table className="w-full text-sm">
        <caption className="sr-only">{t("tableCaption")}</caption>
        <thead>
          <tr className="border-b">
            <th
              scope="col"
              className="sticky left-0 top-0 z-30 bg-card px-3 py-2.5 text-left font-medium text-muted-foreground"
            >
              {t("teacherHeader")}
            </th>
            {columns.map((subject) => (
              <th
                key={subject.id}
                scope="col"
                className="sticky top-0 z-20 border-l bg-card px-2 py-2.5 text-center"
              >
                <div className="flex flex-col items-center gap-1">
                  <span
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: colorOf(subject.id) }}
                  />
                  <span className="max-w-24 truncate text-xs font-medium" title={subject.name}>
                    {subject.code ?? subject.name}
                  </span>
                </div>
              </th>
            ))}
            {/*
              Six pinned columns. Widths are the offsets of the ones to their
              left: bar 11rem (right-0), saldo 5rem (right-44), uppdrag 5rem
              (right-64), undervisning 6rem (right-84), mål 5rem (right-108),
              tjänst 5rem (right-128).
            */}
            <th scope="col" className="sticky right-[32rem] top-0 z-30 min-w-20 max-w-20 border-l bg-card px-2 py-2.5 text-right font-medium text-foreground">
              {t("employmentHeader")}
            </th>
            <th scope="col" className="sticky right-[27rem] top-0 z-30 min-w-20 max-w-20 border-l bg-card px-2 py-2.5 text-right font-medium text-foreground">
              {t("targetHeader")}
            </th>
            <th scope="col" className="sticky right-[21rem] top-0 z-30 min-w-24 max-w-24 border-l bg-card px-2 py-2.5 text-right font-medium text-foreground">
              {week === "peak" ? t("teachingPeakHeader") : t("teachingHeader")}
            </th>
            <th scope="col" className="sticky right-64 top-0 z-30 min-w-20 max-w-20 border-l bg-card px-2 py-2.5 text-right font-medium text-foreground">
              {t("dutyHeader")}
            </th>
            <th scope="col" className="sticky right-44 top-0 z-30 min-w-20 max-w-20 border-l bg-card px-2 py-2.5 text-right font-medium text-foreground">
              {t("balanceHeader")}
            </th>
            <th scope="col" className="sticky right-0 top-0 z-30 min-w-44 max-w-44 border-l bg-card px-3 py-2.5 text-left font-medium text-foreground">
              {t("barHeader")}
            </th>
          </tr>
        </thead>
        <tbody>
          {report.teachers.map((teacher) => {
            const name = teacherName(teacher.userId);
            return (
              <tr key={teacher.userId} className="border-b last:border-0">
                <th scope="row" className="sticky left-0 z-10 bg-card px-3 py-2 text-left font-medium">
                  <button
                    type="button"
                    onClick={() => onOpenTeacher(teacher.userId)}
                    aria-label={t("openDrawer", { name })}
                    className="flex flex-col items-start gap-1 text-left hover:underline"
                  >
                    <span>{name}</span>
                    <StatusBadge status={teacher.status} />
                  </button>
                </th>
                {columns.map((subject) => {
                  const cell = cellValue(teacher, subject.id, unit);
                  const groups = cell
                    ? groupsInSubject(requirements, teacher.userId, subject.id, groupName)
                    : [];
                  const tooltip = cell
                    ? `${t("cellLabel", { teacher: name, subject: subject.name, value: cell.text })}${
                        groups.length > 0 ? ` · ${t("cellGroups", { groups: groups.join(", ") })}` : ""
                      }`
                    : undefined;
                  return (
                    <td
                      key={subject.id}
                      className="border-l px-2 py-2 text-center tabular-nums"
                      title={tooltip}
                      aria-label={tooltip}
                    >
                      {cell ? (
                        <span className="font-medium text-foreground">{cell.text}</span>
                      ) : (
                        <span className="text-muted-foreground" aria-hidden="true">
                          —
                        </span>
                      )}
                    </td>
                  );
                })}
                <td className="sticky right-[32rem] z-10 min-w-20 max-w-20 border-l bg-card px-2 py-2 text-right tabular-nums text-foreground">
                  {teacher.employment ? (
                    formatPercent(teacher.employment.employmentPercent)
                  ) : (
                    <span className="text-xs text-muted-foreground">{t("noPost")}</span>
                  )}
                </td>
                <td className="sticky right-[27rem] z-10 min-w-20 max-w-20 border-l bg-card px-2 py-2 text-right tabular-nums text-foreground">
                  {teacher.targetMinutesPerWeek ?? "—"}
                </td>
                <td className="sticky right-[21rem] z-10 min-w-24 max-w-24 border-l bg-card px-2 py-2 text-right font-medium tabular-nums text-foreground">
                  {teaching(teacher)}
                </td>
                <td
                  className="sticky right-64 z-10 min-w-20 max-w-20 border-l bg-card px-2 py-2 text-right tabular-nums text-foreground"
                  title={
                    teacher.countedDutyMinutesPerWeek > 0
                      ? t("dutyCellCounted", { minutes: teacher.countedDutyMinutesPerWeek })
                      : undefined
                  }
                >
                  {teacher.dutyMinutesPerWeek > 0 ? (
                    <>
                      {teacher.dutyMinutesPerWeek}
                      {teacher.countedDutyMinutesPerWeek > 0 ? (
                        <span className="sr-only">
                          {` (${t("dutyCellCounted", { minutes: teacher.countedDutyMinutesPerWeek })})`}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-muted-foreground" aria-hidden="true">
                      —
                    </span>
                  )}
                </td>
                <td className="sticky right-44 z-10 min-w-20 max-w-20 border-l bg-card px-2 py-2 text-right tabular-nums text-foreground">
                  {balanceText(teacher)}
                </td>
                <td className="sticky right-0 z-10 min-w-44 max-w-44 border-l bg-card px-3 py-2">
                  <LoadBar teacher={teacher} week={week} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
