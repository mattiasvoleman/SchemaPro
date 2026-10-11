import { cn } from "@/lib/utils";

// Two across at the base, not one: a phone stacked eight full-width tiles
// (the dashboard) into a scroll of figures before any content. Each count then
// widens from sm or lg up as before.
const COLUMNS = {
  3: "sm:grid-cols-3",
  4: "lg:grid-cols-4",
  5: "sm:grid-cols-3 lg:grid-cols-5",
} as const;

export interface KpiStripProps extends React.HTMLAttributes<HTMLDListElement> {
  /** Tiles per row at the widest breakpoint. Defaults to 4. */
  columns?: keyof typeof COLUMNS;
}

/**
 * A page's summary figures, before its table or board: a <dl> of KpiTiles.
 * Summary numbers never go in the header actions or as pills in a filter row.
 *
 * Server-safe.
 */
export function KpiStrip({ columns = 4, className, ...props }: KpiStripProps) {
  return <dl className={cn("grid grid-cols-2 gap-3", COLUMNS[columns], className)} {...props} />;
}

export interface KpiTileProps {
  /** The dt: a short noun, drawn as an uppercase eyebrow. */
  label: React.ReactNode;
  /**
   * The figure, already formatted. null when there is none: the tile then
   * shows `fallback` as a sentence, or "—" in muted when no fallback is given.
   * Never pass 0 for a figure that failed to load.
   */
  value: React.ReactNode | null;
  /** Shown instead of the figure when value is null ("Inte registrerat"). */
  fallback?: React.ReactNode;
  /** A second line under the figure: the same figure in hours, a comparison. */
  detail?: React.ReactNode;
  /** A tooltip on the figure, for a fallback that needs its reason. */
  title?: string;
  className?: string;
}

/**
 * One figure of a KpiStrip: a dt and a dd in a card tile. Below sm the tile is
 * tighter and the figure a step smaller, so two fit side by side at 390 px; the
 * label wraps rather than truncates, and min-w-0 with break-words keeps a long
 * compound ("Grundschemapass") inside its half of the row. Server-safe.
 */
export function KpiTile({ label, value, fallback, detail, title, className }: KpiTileProps) {
  return (
    <div className={cn("min-w-0 rounded-lg border bg-card p-3 sm:p-4", className)}>
      <dt className="break-words text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      {value !== null ? (
        <dd className="mt-1 text-xl font-semibold tabular-nums sm:text-2xl" title={title}>
          {value}
        </dd>
      ) : fallback !== undefined ? (
        <dd className="mt-1 text-sm text-foreground" title={title}>
          {fallback}
        </dd>
      ) : (
        <dd className="mt-1 text-xl font-semibold text-muted-foreground sm:text-2xl" title={title}>
          —
        </dd>
      )}
      {detail !== undefined ? (
        <dd className="text-sm text-muted-foreground tabular-nums">{detail}</dd>
      ) : null}
    </div>
  );
}
