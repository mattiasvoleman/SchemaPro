import { Fragment, type ReactNode } from "react";
import { layoutClusters } from "@/lib/day-clusters";
import { placement, shownDays, timed, weekSpan } from "@/lib/public-timetable";
import { weekNumberOf, type SheetDocument, type SheetLesson } from "@/lib/print-sheet";

/*
 * One printed week (Utskrift och inbäddning): the header — the school, what
 * the sheet is of, its title, the week and the period it is valid for — and
 * the week itself, as Schemavisaren has always drawn it. One component for
 * every place a week is put on paper or in a frame:
 *
 *   page    Schemavisaren's own page (app/v/[token]): a list on a phone, the
 *           grid on a wider screen and on paper;
 *   embed   the same page compact, for a frame on the school's website
 *           (app/v/[token]/embed): the list in a narrow frame, the grid in a
 *           wide one;
 *   print   one sheet of the admin's print set, and a person's own printout:
 *           the grid always, one landscape A4 each.
 *
 * NO HOOKS AND NO CLIENT CODE: the viewer renders this on the server, so it
 * takes its translations as functions, and a client page passes next-intl's.
 * The lanes are lib/day-lanes.ts's, the arithmetic lib/public-timetable.ts's.
 *
 * ON PAPER IN GRAYSCALE: nothing is said by colour alone. A cancelled lesson
 * is struck through and says "Inställd", a room's lesson for named pupils
 * says "Upptagen", a meal says "Lunch" inside a dashed outline; the tint of a
 * block is only a tint.
 */

export type Translate = (key: string, values?: Record<string, string | number>) => string;

export interface WeekSheetProps {
  document: SheetDocument;
  locale: string;
  /** The publicViewer namespace. */
  t: Translate;
  /** The days namespace: "1" Monday … "7" Sunday. */
  tDays: Translate;
  variant: "page" | "embed" | "print";
  /** Beside the title: the viewer's navigation, a page's buttons. Never printed. */
  actions?: ReactNode;
  /** 1 for a page of its own, 2 for one sheet of many. */
  headingLevel?: 1 | 2;
  /** Unique on the page, for the days' headings: a print set draws many sheets. Without one, day-<date>. */
  idPrefix?: string;
  /**
   * Draw each lesson's note ("Vikarie"): a person's own printout only, whose
   * document this page built itself. Never for a document the gateway sent —
   * the viewer's whitelist has no note, and a key it never sends is not
   * printed either.
   */
  notes?: boolean;
}

/**
 * A lesson's line under its subject: what the sheet's own target is not.
 * A class's week leaves out the class (it is the title) and puts the room
 * first, so the room survives when a narrow block clips the line; a room's
 * week leaves out the room, a teacher's week the teacher. With `notes`, a
 * note ("Vikarie") ends the line.
 */
export function lessonText(
  lesson: SheetLesson,
  t: Translate,
  sheet: Pick<SheetDocument, "kind" | "title">,
  notes = false,
): { main: string; detail: string } {
  if (lesson.busy) return { main: t("busy"), detail: "" };
  const groupNames = (lesson.groups ?? [])
    .filter((group) => !(sheet.kind === "GROUP" && group === sheet.title))
    .map((group) => group ?? t("group"));
  const groups = groupNames.join(", ") || null;
  const room = sheet.kind === "ROOM" ? null : lesson.room ?? null;
  const teachers = (lesson.teachers ?? []).filter((label) => !(sheet.kind === "TEACHER" && label === sheet.title)).join(", ") || null;
  const parts = sheet.kind === "GROUP" ? [room, teachers, groups] : [groups, room, teachers];
  return { main: lesson.subject ?? "", detail: [...parts, notes ? (lesson.note ?? null) : null].filter(Boolean).join(" · ") };
}

function shortDate(locale: string) {
  const format = new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "sv-SE", { day: "numeric", month: "short", timeZone: "UTC" });
  return (date: string) => format.format(new Date(`${date}T00:00:00Z`));
}

function longDate(locale: string) {
  const format = new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "sv-SE", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  return (date: string) => format.format(new Date(`${date}T00:00:00Z`));
}

/**
 * "Giltig fr.o.m. 17 aug. 2026 t.o.m. 11 juni 2027", one per period; said in
 * words when no publication covers the week, so a sheet never leaves its
 * validity out unexplained; null only when it was not asked or not read.
 */
export function validityLine(document: SheetDocument, t: Translate, locale: string): string | null {
  if (!document.validity) return null;
  if (document.validity.length === 0) return t("validityNone");
  const long = longDate(locale);
  return document.validity.map((period) => t("validity", { from: long(period.from), to: long(period.to) })).join(" · ");
}

export function WeekSheet({ document, locale, t, tDays, variant, actions, headingLevel = 1, idPrefix, notes = false }: WeekSheetProps) {
  const days = shownDays(document.days);
  const span = weekSpan(document.days);
  const hours = Array.from({ length: (span.end - span.start) / 60 + 1 }, (_, index) => span.start / 60 + index);
  const short = shortDate(locale);
  const dayName = (date: string) => tDays(String(new Date(`${date}T00:00:00Z`).getUTCDay() || 7));
  const week = weekNumberOf(document);
  const validity = validityLine(document, t, locale);
  const Heading = headingLevel === 1 ? "h1" : "h2";
  const DayHeading = headingLevel === 1 ? "h2" : "h3";
  const compact = variant === "embed";
  // The list is for narrow screens only; paper and the print set get the grid
  // alone, and a set of forty sheets is not given forty lists it never shows.
  const gridClass =
    variant === "print"
      ? "grid rounded-md border text-xs print:text-[9px]"
      : "hidden rounded-md border text-xs md:grid print:grid print:text-[9px]";
  const columnHeight = compact ? "h-[32rem]" : variant === "print" ? "h-[34rem]" : "h-[40rem]";
  const dayId = (date: string) => (idPrefix ? `${idPrefix}-day-${date}` : `day-${date}`);

  return (
    <div className={compact ? "space-y-2" : "space-y-3 print:space-y-1"}>
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className={compact ? "text-xs" : "text-sm"}>
            {document.school} · {t(`kind.${document.kind}`)}
          </p>
          <Heading className={compact ? "text-lg font-semibold" : "text-2xl font-semibold print:text-lg"}>{document.title}</Heading>
          <p className={compact ? "text-xs" : "text-sm"}>
            {t("week", { week })} · {short(document.week.from)} – {short(document.week.to)}
          </p>
          {validity ? <p className={compact ? "text-xs" : "text-sm"}>{validity}</p> : null}
        </div>
        {actions ? <div className="print:hidden">{actions}</div> : null}
      </header>

      {variant === "print" ? null : (
        <ol className="space-y-3 md:hidden print:hidden">
          {days.map((day) => (
            <li key={`list-${day.date}`} className="space-y-1">
              <DayHeading className="font-semibold">
                {dayName(day.date)} <span className="font-normal">{short(day.date)}</span>
              </DayHeading>
              {day.lessons.length === 0 && (day.meals ?? []).length === 0 ? (
                <p className="text-sm">{t("noLessons")}</p>
              ) : (
                <ul className="divide-y rounded-md border text-sm">
                  {[
                    ...day.lessons.map((lesson) => ({ at: lesson.start, lesson })),
                    ...(day.meals ?? []).map((meal) => ({ at: meal.start, meal })),
                  ]
                    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
                    .map((entry, index) => {
                      if ("meal" in entry && entry.meal) {
                        return (
                          <li key={`m-${index}`} className="bg-amber-50 px-3 py-1.5 text-neutral-900">
                            <span className="tabular-nums">
                              {entry.meal.start}–{entry.meal.end}
                            </span>{" "}
                            {t("meal")}
                          </li>
                        );
                      }
                      const lesson = (entry as { lesson: SheetLesson }).lesson;
                      const text = lessonText(lesson, t, document, notes);
                      return (
                        <li key={`l-${index}`} className={`px-3 py-1.5 ${lesson.cancelled ? "text-neutral-600" : ""}`}>
                          <span className="tabular-nums">
                            {lesson.start}–{lesson.end}
                          </span>{" "}
                          <span className={`font-semibold ${lesson.cancelled ? "line-through" : ""}`}>{text.main}</span>
                          {lesson.cancelled ? <strong> · {t("cancelled")}</strong> : null}
                          {text.detail ? <span className="block text-xs">{text.detail}</span> : null}
                        </li>
                      );
                    })}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}

      <div className={gridClass} style={{ gridTemplateColumns: `3rem repeat(${days.length}, minmax(0, 1fr))` }}>
        {/*
          Every cell is placed by hand, so the source can go day by day — a
          day's heading, then its column — while the picture keeps the
          headings in one row. Auto-placed, all the headings came first and
          a screen reader moving by heading met each with nothing under it.
        */}
        <div className="border-b" style={{ gridRow: 1, gridColumn: 1 }} />
        <div className={`relative ${columnHeight} print:h-[145mm]`} style={{ gridRow: 2, gridColumn: 1 }} aria-hidden>
          {hours.slice(0, -1).map((hour) => (
            <span
              key={hour}
              className="absolute right-1 -translate-y-0 tabular-nums"
              style={{ top: `${placement({ start: `${hour}:00`, end: `${hour}:00` }, span).top}%` }}
            >
              {String(hour).padStart(2, "0")}:00
            </span>
          ))}
        </div>
        {days.map((day, dayIndex) => {
          const lessons = layoutClusters(timed(day.lessons));
          return (
            <Fragment key={day.date}>
              <DayHeading
                id={dayId(day.date)}
                className="min-w-0 truncate border-b border-l px-2 py-1 text-sm font-semibold print:text-[10px]"
                style={{ gridRow: 1, gridColumn: dayIndex + 2 }}
              >
                {dayName(day.date)} <span className="font-normal">{short(day.date)}</span>
              </DayHeading>
              <div className={`relative ${columnHeight} border-l print:h-[145mm]`} style={{ gridRow: 2, gridColumn: dayIndex + 2 }}>
                {hours.slice(1, -1).map((hour) => (
                  <div
                    key={hour}
                    className="absolute inset-x-0 border-t border-dashed border-neutral-300"
                    style={{ top: `${placement({ start: `${hour}:00`, end: `${hour}:00` }, span).top}%` }}
                    aria-hidden
                  />
                ))}
                {(day.meals ?? []).map((meal) => {
                  const at = placement(meal, span);
                  return (
                    <div
                      key={`meal-${meal.start}`}
                      className="viewer-block absolute inset-x-0 border-y border-dashed border-amber-500 bg-amber-50 px-1 text-neutral-900"
                      style={{ top: `${at.top}%`, height: `${at.height}%` }}
                    >
                      {t("meal")} {meal.start}–{meal.end}
                    </div>
                  );
                })}
                {lessons.length === 0 ? (
                  <p className="sr-only">
                    {dayName(day.date)} {short(day.date)}: {t("noLessons")}
                  </p>
                ) : (
                  <ol aria-labelledby={dayId(day.date)}>
                    {lessons.map((lesson, index) => {
                      const at = placement(lesson, span);
                      const text = lessonText(lesson, t, document, notes);
                      return (
                          <li
                            key={`${lesson.start}-${index}`}
                            className={`viewer-block absolute overflow-hidden rounded border px-1 py-0.5 leading-tight text-neutral-900 ${
                              lesson.busy
                                ? "border-neutral-400 bg-neutral-200 italic"
                                : lesson.cancelled
                                  ? "border-neutral-400 border-dashed bg-white text-neutral-700"
                                  : "border-indigo-300 bg-indigo-50"
                            }`}
                            style={{
                              top: `${at.top}%`,
                              height: `${at.height}%`,
                              left: `${(lesson.lane * 100) / lesson.laneCount}%`,
                              width: `${100 / lesson.laneCount}%`,
                            }}
                          >
                            <span className="block tabular-nums">
                              {lesson.start}–{lesson.end}
                              {lesson.cancelled ? <strong> · {t("cancelled")}</strong> : null}
                            </span>
                            <span className={`block font-semibold ${lesson.cancelled ? "line-through" : ""}`}>{text.main}</span>
                            {text.detail ? <span className="block">{text.detail}</span> : null}
                          </li>
                      );
                    })}
                  </ol>
                )}
              </div>
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

/** The paper every printed week asks for: one landscape A4, the blocks' tint kept. */
export const SHEET_PAGE_STYLE = `@page { size: A4 landscape; margin: 8mm; }
@media print { .viewer-block { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }`;
