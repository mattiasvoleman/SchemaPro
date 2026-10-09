"use client";

import { useLocale, useTranslations } from "next-intl";
import { Printer } from "lucide-react";
import { formatPercent } from "@/lib/staffing-view";
import { formatStamp } from "@/lib/employment-history-view";
import { periodOf, tickedBoxes, UPPDRAG_BOXES, type AssignmentPeriod } from "@/lib/uppdrag-view";
import type { LoadModel, TeacherLoad } from "@/lib/teacher-load";
import type { TeacherDuty } from "@/lib/types";
import { AnnualCard } from "@/components/staffing/annual-card";
import { Button } from "@/components/ui/button";

export interface UppdragsbeskrivningProps {
  yearName: string;
  schoolName: string;
  teacherName: string;
  /** The teacher's row of GET /staffing/load — the one source of every figure. */
  load: TeacherLoad;
  loadModel: LoadModel;
  /** The teacher's own uppdrag for the year. */
  duties: readonly TeacherDuty[];
  subjectName: (id: string) => string | null;
  groupName: (id: string) => string | null;
  /** The newest version of the tjänst (TeacherEmploymentLogs), or null before the first write. */
  version: { version: number; createdAt: string } | null;
  timeZone: string;
  /** Today in the school's zone, yyyy-mm-dd. */
  printedOn: string;
}

/**
 * Uppdragsbeskrivning (staffing Fas 3): one teacher's tjänst for one läsår,
 * on paper, in the SHAPE of a Swedish municipal uppdragsbeskrivning — the
 * reference is Göteborgs Stad's "Uppdragsbeskrivning med bilaga, lärare med
 * ferietjänst" (rev. 2024-03-18): a header with tjänstgöringsgrad, rektor
 * and arbetslag; undervisning per ämne, grupp and period; övriga uppdrag as
 * boxes; årsarbetstid; signatures. The shape, not the document: the page
 * says the school's own template applies.
 *
 * Presentational: both routes (the admin's from the drawer, the teacher's
 * own from Min tjänst) read their data and hand it here, so the two cannot
 * print different things for one tjänst. Every number is the gateway's —
 * the load row's assignments, annual and target — so the paper and the
 * screen agree, and every agreement figure is labelled the school's setting.
 *
 * THE VERSION STAMP. The footer cites "Tjänstens version N (datum)" from the
 * teacher's history: the newest version of post AND uppdrag, since a protokoll
 * that cites the post without its uppdrag cites half the tjänst — which is
 * why it is not employment.updatedAt.
 *
 * PRINT. Tailwind's print: variants; the app shell's sidebar and header are
 * print:hidden, the page is A4 with 15 mm margins (globals.css), sections
 * do not break inside, and the Skriv ut button itself is not printed.
 */
export function Uppdragsbeskrivning({
  yearName,
  schoolName,
  teacherName,
  load,
  loadModel,
  duties,
  subjectName,
  groupName,
  version,
  timeZone,
  printedOn,
}: UppdragsbeskrivningProps) {
  const t = useTranslations("uppdrag");
  const tStaffing = useTranslations("staffing");
  const locale = useLocale();
  const employment = load.employment;
  const assignments = load.assignments ?? [];
  // Under FACTOR the load row's minutes and hours are räknad tid (lesson time
  // × the subject's factor). The paper says so on every such figure and
  // prints the undervisningstid itself beside it, so a protokoll citing it
  // cannot read charged minutes as minutes taught. MINUTES: one column, as
  // before — the two figures are the same.
  const factor = loadModel === "FACTOR";
  const timeTotal = assignments.reduce((sum, row) => sum + row.timeMinutesPerWeek, 0);
  const ticked = tickedBoxes(duties);
  const day = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", timeZone: "UTC" });
  const dayOf = (value: string) => day.format(new Date(`${value}T00:00:00Z`));

  const periodText = (period: AssignmentPeriod) => {
    switch (period.kind) {
      case "year":
        return t("periodYear");
      case "odd":
        return t("periodOdd");
      case "even":
        return t("periodEven");
      default: {
        const range = `${period.from ? dayOf(period.from) : t("periodStart")} – ${
          period.to ? dayOf(period.to) : t("periodEnd")
        }`;
        return period.recurrence === "ALL"
          ? range
          : `${range} (${period.recurrence === "ODD" ? t("periodOdd") : t("periodEven")})`;
      }
    }
  };

  const header: { label: string; value: string }[] = [
    { label: t("year"), value: yearName },
    { label: t("name"), value: teacherName },
    { label: t("school"), value: schoolName },
    { label: t("signature"), value: employment?.signature ?? "—" },
    {
      label: t("employmentPercent"),
      value: employment ? `${formatPercent(employment.employmentPercent)} %` : t("noPost"),
    },
    {
      label: t("reductionPercent"),
      value: employment ? `${formatPercent(employment.reductionPercent)} %` : "—",
    },
    {
      label: t("contractKind"),
      value: employment ? tStaffing(`contract${employment.contractKind}`) : "—",
    },
  ];

  return (
    <article className="mx-auto max-w-3xl space-y-5 text-sm print:max-w-none print:space-y-4 print:text-[11pt]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <p className="text-muted-foreground print:text-foreground">
            {t("subtitle", { name: teacherName, year: yearName })}
          </p>
        </div>
        <Button variant="outline" className="print:hidden" onClick={() => window.print()}>
          <Printer />
          {t("print")}
        </Button>
      </div>

      <section className="break-inside-avoid rounded-lg border p-4" aria-labelledby="uppdrag-header">
        <h2 id="uppdrag-header" className="sr-only">
          {t("headerTitle")}
        </h2>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2 print:grid-cols-2">
          {header.map((row) => (
            <div key={row.label} className="flex justify-between gap-3 border-b border-dashed py-1">
              <dt className="text-muted-foreground print:text-foreground">{row.label}</dt>
              <dd className="text-right font-medium">{row.value}</dd>
            </div>
          ))}
          {/* Not in SchemaPro: written by hand on the printed page. */}
          <div className="flex justify-between gap-3 border-b border-dashed py-1">
            <dt className="text-muted-foreground print:text-foreground">{t("rektor")}</dt>
            <dd className="min-w-32 border-b" aria-label={t("toFillIn")} />
          </div>
          <div className="flex justify-between gap-3 border-b border-dashed py-1">
            <dt className="text-muted-foreground print:text-foreground">{t("arbetslag")}</dt>
            <dd className="min-w-32 border-b" aria-label={t("toFillIn")} />
          </div>
        </dl>
      </section>

      <section className="break-inside-avoid space-y-2" aria-labelledby="uppdrag-teaching">
        <h2 id="uppdrag-teaching" className="text-lg font-semibold">
          {t("teachingTitle")}
        </h2>
        {assignments.length === 0 ? (
          <p>{t("noTeaching")}</p>
        ) : (
          <table className="w-full border-collapse">
            <caption className="sr-only">{t("teachingCaption")}</caption>
            <thead>
              <tr className="border-b text-left">
                <th scope="col" className="py-1 pr-2 font-medium">
                  {t("subject")}
                </th>
                <th scope="col" className="py-1 pr-2 font-medium">
                  {t("group")}
                </th>
                <th scope="col" className="py-1 pr-2 font-medium">
                  {t("period")}
                </th>
                {factor ? (
                  <th scope="col" className="py-1 pr-2 text-right font-medium">
                    {t("minutesTime")}
                  </th>
                ) : null}
                <th scope="col" className="py-1 pr-2 text-right font-medium">
                  {factor ? t("minutesFactor") : t("minutes")}
                </th>
                <th scope="col" className="py-1 text-right font-medium">
                  {factor ? t("hoursPerYearFactor") : t("hoursPerYear")}
                </th>
              </tr>
            </thead>
            <tbody>
              {assignments.map((row) => (
                <tr key={`${row.requirementId}-${row.role}`} className="border-b border-dashed">
                  <td className="py-1 pr-2">
                    {row.subjectName}
                    {row.role === "CO_TEACHER" ? ` (${t("coTeacher")})` : ""}
                  </td>
                  <td className="py-1 pr-2">{row.groupName}</td>
                  <td className="py-1 pr-2">{periodText(periodOf(row))}</td>
                  {factor ? (
                    <td className="py-1 pr-2 text-right tabular-nums">{formatPercent(row.timeMinutesPerWeek)}</td>
                  ) : null}
                  <td className="py-1 pr-2 text-right tabular-nums">{formatPercent(row.minutesPerWeek)}</td>
                  <td className="py-1 text-right tabular-nums">{formatPercent(row.hoursPerYear)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="font-medium">
                <th scope="row" colSpan={3} className="py-1 pr-2 text-left">
                  {t("total")}
                </th>
                {factor ? (
                  <td className="py-1 pr-2 text-right tabular-nums">{formatPercent(timeTotal)}</td>
                ) : null}
                <td className="py-1 pr-2 text-right tabular-nums">{load.assignedMinutesPerWeek}</td>
                <td className="py-1 text-right tabular-nums">
                  {formatPercent(load.annual.assignedHoursPerYear)}
                </td>
              </tr>
            </tfoot>
          </table>
        )}
        <p className="text-muted-foreground print:text-foreground">
          {t(factor ? "peakFactor" : "peak", { minutes: load.peakMinutesPerWeek })}
        </p>
        {factor ? <p className="text-muted-foreground print:text-foreground">{t("factorNote")}</p> : null}
      </section>

      <section className="break-inside-avoid space-y-2" aria-labelledby="uppdrag-duties">
        <h2 id="uppdrag-duties" className="text-lg font-semibold">
          {t("dutiesTitle")}
        </h2>
        <ul className="flex flex-wrap gap-x-5 gap-y-1">
          {UPPDRAG_BOXES.map((box) => (
            <li key={box} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                readOnly
                tabIndex={-1}
                checked={ticked.has(box)}
                aria-label={t(`box.${box}`)}
                className="size-4 accent-foreground"
              />
              <span aria-hidden="true">{t(`box.${box}`)}</span>
            </li>
          ))}
        </ul>
        {duties.length === 0 ? (
          <p>{t("noDuties")}</p>
        ) : (
          <ul className="divide-y divide-dashed">
            {duties.map((duty) => {
              const about = [
                duty.subjectId ? subjectName(duty.subjectId) : null,
                duty.studentGroupId ? groupName(duty.studentGroupId) : null,
              ].filter((part): part is string => part !== null);
              return (
                <li key={duty.id} className="flex flex-wrap justify-between gap-2 py-1">
                  <span>
                    <span className="font-medium">{duty.label}</span> · {tStaffing(`dutyKind${duty.kind}`)}
                    {about.length > 0 ? ` · ${about.join(" · ")}` : ""}
                  </span>
                  <span className="tabular-nums">
                    {duty.countsAsTeaching
                      ? tStaffing("dutyMinutesCounted", { minutes: duty.minutesPerWeek })
                      : tStaffing("dutyMinutes", { minutes: duty.minutesPerWeek })}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <AnnualCard annual={load.annual} loadModel={loadModel} headingLevel="h2" />

      <section className="break-inside-avoid space-y-1" aria-labelledby="uppdrag-target">
        <h2 id="uppdrag-target" className="text-lg font-semibold">
          {t("targetTitle")}
        </h2>
        {load.targetMinutesPerWeek === null ? (
          <p>{t("noTarget", { counted: load.countedMinutesPerWeek })}</p>
        ) : (
          <p>
            {t("target", {
              target: load.targetMinutesPerWeek,
              counted: load.countedMinutesPerWeek,
              balance: load.balanceMinutesPerWeek ?? 0,
            })}
          </p>
        )}
      </section>

      <footer className="break-inside-avoid space-y-6 border-t pt-3">
        <p className="text-xs text-muted-foreground print:text-foreground">
          {version
            ? t("stamp", {
                printed: printedOn,
                version: version.version,
                date: formatStamp(version.createdAt, timeZone),
              })
            : t("stampNoVersion", { printed: printedOn })}
        </p>
        <div className="grid grid-cols-3 gap-6">
          {(["signRektor", "signTeacher", "signDate"] as const).map((key) => (
            <div key={key} className="border-t border-foreground pt-1 text-xs">
              {t(key)}
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground print:text-foreground">{t("disclaimer")}</p>
      </footer>
    </article>
  );
}
