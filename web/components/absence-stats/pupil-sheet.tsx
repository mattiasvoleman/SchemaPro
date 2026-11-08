"use client";

import { createPortal } from "react-dom";
import { groupByYear, type PatternCell, type PupilStatsView } from "@/lib/absence-stats";
import { useProfile } from "@/components/profile-context";
import { useAbsenceStatsText } from "./use-absence-stats-text";

const SUBJECTS_ON_PAPER = 8;

/**
 * One pupil's absence over three läsår on one A4, for the development talk.
 *
 * THE PRINT IS THE PAGE. It is drawn from the card the page already read, so
 * printing reads nothing about anybody that viewing did not. It waits in a
 * portal under <body> that the screen never shows (globals.css,
 * .print-sheet-root); the card puts `printing-sheet` on <html> from the click
 * until the browser says the print is done, and then the page is the sheet
 * alone. The three läsår stand side by side, a month a row, with the class's
 * share and reporting rate beside the pupil's, so that the sheet fits one
 * page; the patterns are the shortest of the three lists.
 *
 * This component is only ever mounted for a pupil whose card the gateway
 * handed out and whom the school has not marked as protected
 * (pupil-print.ts), and only after the click on Skriv ut.
 */
export function PupilSheet({ view }: { view: PupilStatsView }) {
  const { t, decimal, day, monthName, weekday } = useAbsenceStatsText();
  const { school } = useProfile();
  const { student, patterns } = view;
  const classByMonth = new Map((view.classSeries ?? []).map((one) => [one.month, one]));
  const years = groupByYear(view.months);
  const share = (value: number | null | undefined): string => (value === null || value === undefined ? "–" : decimal(value));

  const small = (label: string, cells: readonly PatternCell[], labelOf: (cell: PatternCell) => string) =>
    cells.length === 0 ? null : (
      <table className="w-full border-collapse text-[8pt]">
        <caption className="pb-0.5 text-left font-semibold">{label}</caption>
        <thead>
          <tr className="border-b text-left">
            <th scope="col" className="py-0.5 pr-1 font-medium" />
            <th scope="col" className="px-1 text-right font-medium">
              {t("sheet.column.valid")}
            </th>
            <th scope="col" className="pl-1 text-right font-medium">
              {t("sheet.column.invalid")}
            </th>
          </tr>
        </thead>
        <tbody>
          {cells.map((cell) => (
            <tr key={cell.key} className="border-b">
              <th scope="row" className="py-0.5 pr-1 text-left font-normal">
                {labelOf(cell)}
              </th>
              <td className="px-1 text-right tabular-nums">{share(cell.figures.validPct)}</td>
              <td className="pl-1 text-right tabular-nums">{share(cell.figures.invalidPct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );

  return createPortal(
    <div className="print-sheet-root space-y-3 text-[9pt] leading-snug text-foreground">
      <header className="space-y-0.5 border-b pb-2">
        <p className="text-[8pt] text-muted-foreground">
          {school?.name ?? ""} · {t("sheet.title")}
        </p>
        <h1 className="text-lg font-semibold">{`${student.firstName} ${student.lastName}`}</h1>
        <p>
          {student.className ? t("card.class", { name: student.className }) : t("card.noClass")} ·{" "}
          {t("sheet.printed", { date: day(view.window.today) })}
        </p>
      </header>

      <p>
        {view.marksFrom === null
          ? t("card.noMarks")
          : t("card.marksFrom", { from: day(view.marksFrom), to: day(view.marksTo ?? view.marksFrom) })}
      </p>

      <section aria-label={t("sheet.monthsLabel")} className="grid grid-cols-3 gap-3">
        {years.map((year) => (
          <table key={year.start} className="w-full border-collapse text-[8pt]">
            <caption className="pb-0.5 text-left font-semibold">{t("series.year", { name: year.name })}</caption>
            <thead>
              <tr className="border-b text-right">
                <th scope="col" className="py-0.5 text-left font-medium" />
                <th scope="col" className="px-0.5 font-medium">
                  {t("sheet.column.valid")}
                </th>
                <th scope="col" className="px-0.5 font-medium">
                  {t("sheet.column.invalid")}
                </th>
                <th scope="col" className="px-0.5 font-medium">
                  {t("sheet.column.class")}
                </th>
                <th scope="col" className="pl-0.5 font-medium">
                  {t("sheet.column.reporting")}
                </th>
              </tr>
            </thead>
            <tbody>
              {year.rows.map((row) => {
                const classMonth = classByMonth.get(row.month);
                return (
                  <tr key={row.month} className="border-b text-right">
                    <th scope="row" className="py-0.5 text-left font-normal">
                      {monthName(row.month)}
                    </th>
                    <td className="px-0.5 tabular-nums">{share(row.figures?.validPct)}</td>
                    <td className="px-0.5 tabular-nums">{share(row.figures?.invalidPct)}</td>
                    <td className="px-0.5 tabular-nums">{share(classMonth?.figures?.totalPct)}</td>
                    <td className="pl-0.5 tabular-nums">{share(classMonth?.reporting.ratePct)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ))}
      </section>
      <p className="text-[8pt] text-muted-foreground">{t("sheet.legend")}</p>

      {patterns.suppressed ? null : (
        <section aria-label={t("sheet.patternsLabel")} className="space-y-1">
          <h2 className="text-[9pt] font-semibold">
            {t("sheet.patterns", { from: day(view.period.from), to: day(view.period.to) })}
          </h2>
          <div className="grid grid-cols-3 gap-3">
            {small(t("patterns.column.weekdays"), patterns.weekdays, (cell) => weekday(cell.key))}
            {small(t("patterns.column.slots"), patterns.slots, (cell) => cell.label)}
            {small(t("patterns.column.subjects"), patterns.subjects.slice(0, SUBJECTS_ON_PAPER), (cell) => cell.label)}
          </div>
        </section>
      )}

      <footer className="border-t pt-1 text-[8pt] text-muted-foreground">{t("sheet.footer")}</footer>
    </div>,
    document.body,
  );
}
