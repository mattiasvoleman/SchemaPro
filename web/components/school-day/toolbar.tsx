import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/*
 * The row of controls above the grid and one labelled control in it: what
 * FilterBar and FilterField (components/ui/filter-bar.tsx) are, written here
 * on purpose.
 *
 * Importing filter-bar from these routes moved /admin/people from 189.0 to
 * 190.1 KB, over its budget of 190 (measured 2026-11-06, with the new routes
 * the only change): the chunker puts the module in a chunk with the
 * modules the same routes share, and two more routes that use it re-sliced that
 * chunk into two, whose separate gzip streams are 1.0 KB larger together
 * (bundle-gate-measurement, "a module-graph change re-partitions chunks
 * app-wide"). The two components are a flex row and a Label above a control, so
 * writing them here costs the page less than the move costs people. Same
 * classes, same markup: when the chunker moves again, these can go back to
 * the shared ones.
 */

export function Toolbar({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-wrap items-end gap-3", className)} {...props} />;
}

export function Field({ id, label, className, children }: { id: string; label: React.ReactNode; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}
