import { Table } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export interface TableCardProps {
  /**
   * The table's name, read by screen readers and used by tests
   * (getByRole("table", { name })). Visually hidden: the page's heading
   * already says it.
   */
  caption: React.ReactNode;
  /** TableHeader and TableBody from components/ui/table. */
  children: React.ReactNode;
  /**
   * True while placeholder data stands in for a refetch: the table dims to
   * opacity-60 and is aria-busy, as staffing-report does.
   */
  busy?: boolean;
  /** On the outer frame. */
  className?: string;
  /** On the <table> itself, e.g. a min-w-[…] for a wide table. */
  tableClassName?: string;
}

/**
 * The one table frame: a horizontally scrolling card around
 * components/ui/table, with a sr-only caption. Dense sticky matrices (timplan,
 * tackning, requirements) keep their raw <table> but copy this frame.
 *
 * Server-safe.
 */
export function TableCard({ caption, children, busy = false, className, tableClassName }: TableCardProps) {
  return (
    <div
      className={cn("overflow-x-auto rounded-lg border bg-card transition-opacity", busy && "opacity-60", className)}
      aria-busy={busy || undefined}
    >
      <Table className={tableClassName}>
        <caption className="sr-only">{caption}</caption>
        {children}
      </Table>
    </div>
  );
}
