"use client";

import { breakOf, hoursOf, placeOnAxis, type Axis, type GridDay, type Row, type RowKind } from "@/lib/school-day";
import { DrawnBlock } from "./drawn-item";
import { useSchoolDayText } from "./use-school-day-text";

/** The height of one lane of a row, in pixels: two lines of text at 11 px. */
const LANE = 38;

/**
 * The day: one row per class, teacher or room, time across.
 *
 * A real table, so a screen reader reads a row by its name: the row header is
 * the class, the teacher or the room, and its cell is the list of what is in
 * it that day, each with its own sentence. The time axis is the eye's help
 * (hidden from assistive technology); every block already says its time.
 * Overlapping lessons of one row go under one another, the row growing by a
 * lane, as Schemavisaren's printed week lays them out.
 *
 * A row that the day's lov closes (a class on prao, the whole school on a
 * höstlov) says so across its width instead of looking free: an empty row on a
 * lov is not a free class.
 */
export function DayGrid({ rows, day, axis, kind }: { rows: Row[]; day: GridDay; axis: Axis; kind: RowKind }) {
  const { t, clock, dayLong, breakText, rowName } = useSchoolDayText();
  const hours = hoursOf(axis);
  const span = axis.end - axis.start;

  return (
    <div role="region" aria-label={t("grid.regionDay", { date: dayLong(day.date) })} tabIndex={0} className="overflow-x-auto rounded-lg border bg-card">
      <table className="w-full min-w-[960px] table-fixed border-collapse text-xs">
        <caption className="sr-only">{t("grid.captionDay", { kind: t(`rows.${kind}`), date: dayLong(day.date) })}</caption>
        <colgroup>
          <col className="w-36" />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 z-10 bg-card px-2 py-2 text-left font-medium">
              {t(`rows.${kind}One`)}
            </th>
            <th scope="col" className="relative h-8 p-0 font-normal">
              <span className="sr-only">{t("grid.time")}</span>
              <div aria-hidden="true" className="absolute inset-0">
                {hours.map((minute, index) => (
                  <span
                    key={minute}
                    className="absolute top-2 -translate-x-1/2 tabular-nums text-muted-foreground"
                    style={{ left: `${((minute - axis.start) / span) * 100}%`, ...(index === 0 ? { transform: "none" } : {}) }}
                  >
                    {clock(minute)}
                  </span>
                ))}
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const items = row.byDate.get(day.date) ?? [];
            const closed = breakOf(day, row);
            const lanes = Math.max(1, ...items.map((item) => item.lane + 1));
            const height = lanes * LANE + 8;
            return (
              <tr key={row.id} className="border-t align-top">
                <th scope="row" className="sticky left-0 z-10 bg-card px-2 py-1.5 text-left font-medium">
                  <span className="block truncate">{rowName(row)}</span>
                  {row.detail ? <span className="block truncate font-normal text-muted-foreground">{row.detail}</span> : null}
                </th>
                <td className="p-0">
                  <div className="relative" style={{ height }}>
                    <div aria-hidden="true" className="pointer-events-none absolute inset-0">
                      {hours.map((minute) => (
                        <span key={minute} className="absolute inset-y-0 border-l border-border/60" style={{ left: `${((minute - axis.start) / span) * 100}%` }} />
                      ))}
                    </div>
                    {closed ? (
                      <p className="absolute inset-x-0 top-0 z-0 bg-muted/70 px-2 py-1 text-muted-foreground">{breakText(closed)}</p>
                    ) : null}
                    <ul className="m-0 list-none p-0" aria-label={rowName(row)}>
                      {items.map((item) => {
                        const place = placeOnAxis(item, axis);
                        if (!place) return null;
                        return (
                          <DrawnBlock
                            key={item.key}
                            item={item}
                            style={{ left: `calc(${place.left}% + 1px)`, width: `calc(${place.width}% - 2px)`, top: 4 + item.lane * LANE, height: LANE - 4 }}
                          />
                        );
                      })}
                    </ul>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
