"use client";

import { breakOf, placeOnAxis, type Axis, type GridDay, type Row, type RowKind } from "@/lib/school-day";
import { toneOf } from "./drawn-item";
import { cn } from "@/lib/utils";
import { useSchoolDayText } from "./use-school-day-text";

/** The height of a cell's strip, in pixels. */
const STRIP = 34;

/**
 * The week: one row per class, teacher or room, one column per day.
 *
 * A cell is a strip of the day's occupancy on the same axis as the day grid,
 * so a free hour is a gap you can see; the strip is the eye's help (hidden
 * from assistive technology, its blocks named on hover) and the list beside
 * it, visually hidden, is what a screen reader reads: each lesson or block as
 * the same sentence the day grid gives. A day's name is a button that opens
 * that day, where the lessons are readable.
 */
export function WeekGrid({
  rows,
  days,
  axis,
  kind,
  onOpenDay,
}: {
  rows: Row[];
  days: GridDay[];
  axis: Axis;
  kind: RowKind;
  onOpenDay: (date: string) => void;
}) {
  const { t, day, breakText, itemName, rowName } = useSchoolDayText();

  return (
    <div role="region" aria-label={t("grid.regionWeek")} tabIndex={0} className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full min-w-[900px] table-fixed border-collapse text-xs">
        <caption className="sr-only">{t("grid.captionWeek", { kind: t(`rows.${kind}`) })}</caption>
        <colgroup>
          <col className="w-36" />
          {days.map((one) => (
            <col key={one.date} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 z-10 bg-card px-2 py-2 text-left font-medium">
              {t(`rows.${kind}One`)}
            </th>
            {days.map((one) => (
              <th key={one.date} scope="col" className="border-l px-1 py-1 text-center font-medium">
                <button
                  type="button"
                  onClick={() => onOpenDay(one.date)}
                  aria-label={t("grid.openDay", { date: day(one.date) })}
                  className="rounded px-1.5 py-0.5 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring print:hover:bg-transparent"
                >
                  {day(one.date)}
                </button>
                {one.breaks.length > 0 ? <span className="block truncate font-normal text-muted-foreground">{one.breaks.map((entry) => entry.name).join(", ")}</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-t align-top">
              <th scope="row" className="sticky left-0 z-10 bg-card px-2 py-1.5 text-left font-medium">
                <span className="block truncate">{rowName(row)}</span>
                {row.detail ? <span className="block truncate font-normal text-muted-foreground">{row.detail}</span> : null}
              </th>
              {days.map((one) => {
                const items = row.byDate.get(one.date) ?? [];
                const closed = breakOf(one, row);
                const lanes = Math.max(1, ...items.map((item) => item.lane + 1));
                return (
                  <td key={one.date} className="border-l p-1">
                    {closed ? (
                      <p className="truncate rounded bg-muted/70 px-1 py-0.5 text-muted-foreground">{breakText(closed)}</p>
                    ) : (
                      <div aria-hidden="true" className="relative rounded-sm bg-muted/30" style={{ height: STRIP }}>
                        {items.map((item) => {
                          const place = placeOnAxis(item, axis);
                          if (!place) return null;
                          const laneHeight = STRIP / lanes;
                          return (
                            <span
                              key={item.key}
                              title={itemName(item)}
                              className={cn("absolute rounded-[2px]", toneOf(item))}
                              style={{ left: `${place.left}%`, width: `${Math.max(place.width, 1)}%`, top: item.lane * laneHeight, height: Math.max(laneHeight - 1, 3) }}
                            />
                          );
                        })}
                      </div>
                    )}
                    <ul className="sr-only">
                      {closed ? <li>{breakText(closed)}</li> : null}
                      {items.map((item) => (
                        <li key={item.key}>{itemName(item)}</li>
                      ))}
                      {!closed && items.length === 0 ? <li>{t("grid.nothing")}</li> : null}
                    </ul>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
