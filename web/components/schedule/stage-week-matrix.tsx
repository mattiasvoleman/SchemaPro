import { useTranslations } from "next-intl";
import { TableCard } from "@/components/ui/table-card";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/**
 * Monday to Friday. A row may name a Saturday (the API accepts 1-7), but the
 * week is drawn for the days a Swedish grundskola teaches: two mostly empty
 * columns would cost width the clock needs, for a case no school here has.
 */
export const WEEKDAYS = [1, 2, 3, 4, 5] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** A stage as the school wrote it: a span of årskurser, both ends included. */
export interface GradeSpan {
  min: number;
  max: number;
}

/**
 * The distinct stages a school's rows talk about, in year order.
 *
 * Derived from the rows rather than from a fixed F–3/4–6/7–9, because the
 * school decides what a stage is: one row per single year is an equally valid
 * thing to say, and the week drawn from the rows has to show it back.
 */
export function stagesOf(
  rows: readonly { minGradeLevel: number; maxGradeLevel: number }[] | undefined,
): GradeSpan[] {
  const seen = new Map<string, GradeSpan>();
  for (const row of rows ?? []) {
    seen.set(`${row.minGradeLevel}-${row.maxGradeLevel}`, {
      min: row.minGradeLevel,
      max: row.maxGradeLevel,
    });
  }
  return [...seen.values()].sort((a, b) => a.min - b.min || a.max - b.max);
}

/** "Åk 4–6", or "Åk 5" — a single year is the common case and reads worse as a range. */
export function useSpanLabel(): (min: number, max: number) => string {
  const tGrades = useTranslations("grades");
  return (min, max) =>
    min === max
      ? tGrades("grade", { grade: min })
      : `${tGrades("grade", { grade: min })}–${tGrades("grade", { grade: max })}`;
}

export interface StageWeekMatrixProps {
  /** The section's id; its h2 is `${id}-title` and names the region. */
  id: string;
  title: string;
  /** What the matrix is computed from, and how overlapping rows combine. */
  description?: React.ReactNode;
  /** The first column's head ("Årskurser"). */
  stageLabel: string;
  spans: GradeSpan[];
  /** What `span` gets on `day`: the resolved window or windows, or the word for none. */
  renderCell: (span: GradeSpan, day: Weekday) => React.ReactNode;
}

/**
 * The resolved week under a page of school-day rows: one row per stage, one
 * column per weekday.
 *
 * Ramtider, raster and lunchsittningar all have the same problem — an every-day
 * row and a weekday row that overlaps it are two lines in a list and ONE
 * different day in reality — and the same answer: ask the function the engine
 * mirrors (lib/frame-times, lib/rasts, lib/lunch-servings) and print what it
 * says. The three pages drew this table three times; the cell is the only part
 * that differs, so it is the only part they pass.
 *
 * A section without a border, under the page's own table: the h2 and a muted
 * description, spaced by the page's space-y-4. Table heads stay `foreground`,
 * as on the lists above it (the school-day pages hold their tables to 7:1).
 */
export function StageWeekMatrix({
  id,
  title,
  description,
  stageLabel,
  spans,
  renderCell,
}: StageWeekMatrixProps) {
  const tDays = useTranslations("days");
  const spanLabel = useSpanLabel();
  const titleId = `${id}-title`;

  return (
    <section id={id} aria-labelledby={titleId} className="space-y-3">
      <div className="space-y-1">
        <h2 id={titleId} className="text-base font-semibold">
          {title}
        </h2>
        {description ? (
          <div className="max-w-prose space-y-1 text-sm text-muted-foreground">{description}</div>
        ) : null}
      </div>
      <TableCard caption={title}>
        <TableHeader>
          <TableRow>
            <TableHead scope="col" className="text-foreground">
              {stageLabel}
            </TableHead>
            {WEEKDAYS.map((day) => (
              <TableHead key={day} scope="col" className="text-foreground">
                {tDays(String(day))}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {spans.map((span) => (
            <TableRow key={`${span.min}-${span.max}`}>
              <TableCell className="font-medium">{spanLabel(span.min, span.max)}</TableCell>
              {WEEKDAYS.map((day) => (
                <TableCell key={day} className="tabular-nums">
                  {renderCell(span, day)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </TableCard>
    </section>
  );
}
