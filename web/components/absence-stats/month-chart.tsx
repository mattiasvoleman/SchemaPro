"use client";

import { useId } from "react";
import { chartCeiling, type ChartPoint } from "@/lib/absence-stats";
import { TableScroll } from "@/components/ui/table-scroll";
import { useAbsenceStatsText } from "./use-absence-stats-text";

// The drawing's own units. The svg scales to its box; below 40rem it scrolls
// instead of shrinking, so the axis text stays readable on a phone.
const WIDTH = 640;
const HEIGHT = 200;
const LEFT = 40;
const RIGHT = 8;
const TOP = 10;
const BOTTOM = 30;
const PLOT_WIDTH = WIDTH - LEFT - RIGHT;
const PLOT_HEIGHT = HEIGHT - TOP - BOTTOM;

/**
 * Giltig and ogiltig frånvaro per month as stacked bars, in percent of the
 * recorded minutes, month by month in time order.
 *
 * THE CHART IS THE EYE'S HELP, NEVER THE ONLY READING. It is one role=img
 * whose name sends the reader to the table under it, which has every number;
 * nothing is in the chart that the table does not say. So nothing depends on
 * telling one colour from another either: ogiltig is a solid bar, giltig an
 * outlined one above it, the same month a year before a dark tick, a month
 * that is going on hatched, and a month with no figure a dotted line at the
 * foot, never a bar of height 0. The legend is drawn beside it for the same
 * eye. Below 40rem the drawing scrolls instead of shrinking (so its axis text
 * stays readable on a phone), in the same keyboard-reachable box a wide table
 * scrolls in.
 *
 * It draws what the gateway computed (the shares are its) and scales them.
 */
export function MonthChart({ points }: { points: readonly ChartPoint[] }) {
  const { t, month: monthText } = useAbsenceStatsText();
  const hatch = useId();
  const ceiling = chartCeiling(points);
  const step = points.length > 0 ? PLOT_WIDTH / points.length : PLOT_WIDTH;
  const barWidth = Math.max(2, step * 0.72);
  const baseline = TOP + PLOT_HEIGHT;
  const y = (share: number): number => TOP + PLOT_HEIGHT * (1 - share / ceiling);
  const height = (share: number): number => (PLOT_HEIGHT * share) / ceiling;
  const grid = [0, ceiling / 2, ceiling];

  return (
    <figure className="space-y-2">
      <TableScroll>
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={t("chart.label")}
          className="h-auto w-full min-w-[40rem] text-foreground"
        >
          <defs>
            <pattern id={hatch} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="2" height="4" className="fill-primary" />
            </pattern>
          </defs>
          {grid.map((line) => (
            <g key={line}>
              <line x1={LEFT} x2={WIDTH - RIGHT} y1={y(line)} y2={y(line)} className="stroke-border" strokeWidth={1} />
              <text x={LEFT - 6} y={y(line) + 4} textAnchor="end" fontSize={11} className="fill-muted-foreground">
                {t("percent", { percent: line })}
              </text>
            </g>
          ))}
          {points.map((point, index) => {
            const x = LEFT + index * step + (step - barWidth) / 2;
            const shown = point.invalidPct !== null || point.validPct !== null;
            const invalid = point.invalidPct ?? 0;
            const valid = point.validPct ?? 0;
            const labelled = index === 0 || point.month.endsWith("-08-01") || point.month.endsWith("-01-01");
            return (
              <g key={point.month} data-month={point.month}>
                {shown ? (
                  <>
                    <rect
                      x={x}
                      y={y(invalid)}
                      width={barWidth}
                      height={height(invalid)}
                      className={point.partial ? "stroke-primary" : "fill-primary stroke-primary"}
                      fill={point.partial ? `url(#${hatch})` : undefined}
                      strokeWidth={1}
                    />
                    <rect
                      x={x}
                      y={y(invalid + valid)}
                      width={barWidth}
                      height={height(valid)}
                      className="fill-primary/15 stroke-primary"
                      strokeWidth={1}
                      strokeDasharray={point.partial ? "3 2" : undefined}
                    />
                  </>
                ) : (
                  <line
                    x1={x}
                    x2={x + barWidth}
                    y1={baseline - 2}
                    y2={baseline - 2}
                    className="stroke-muted-foreground"
                    strokeWidth={2}
                    strokeDasharray="2 2"
                  />
                )}
                {point.previousPct !== null ? (
                  <line
                    x1={x - 1}
                    x2={x + barWidth + 1}
                    y1={y(point.previousPct)}
                    y2={y(point.previousPct)}
                    className="stroke-foreground"
                    strokeWidth={2}
                  />
                ) : null}
                {labelled ? (
                  <text x={x} y={HEIGHT - 10} fontSize={11} className="fill-muted-foreground">
                    {monthText(point.month)}
                  </text>
                ) : null}
              </g>
            );
          })}
          <line x1={LEFT} x2={WIDTH - RIGHT} y1={baseline} y2={baseline} className="stroke-muted-foreground" strokeWidth={1} />
        </svg>
      </TableScroll>
      <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{t("chart.axis")}</span>
        <Key swatch={<span className="inline-block h-3 w-3 border border-primary bg-primary" />}>{t("chart.invalid")}</Key>
        <Key swatch={<span className="inline-block h-3 w-3 border border-primary bg-primary/15" />}>{t("chart.valid")}</Key>
        <Key swatch={<span className="inline-block h-0.5 w-4 bg-foreground" />}>{t("chart.previous")}</Key>
        <Key
          swatch={
            <span
              className="inline-block h-3 w-3 border border-primary"
              style={{ backgroundImage: "repeating-linear-gradient(45deg, hsl(var(--primary)) 0 1px, transparent 1px 3px)" }}
            />
          }
        >
          {t("chart.going")}
        </Key>
        <Key swatch={<span className="inline-block w-4 border-t-2 border-dotted border-muted-foreground" />}>{t("chart.none")}</Key>
      </figcaption>
    </figure>
  );
}

function Key({ swatch, children }: { swatch: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span aria-hidden="true">{swatch}</span>
      {children}
    </span>
  );
}
