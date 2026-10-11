import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * The row of filters and scope controls between the header (or the tabs) and
 * the content: FilterFields bottom-aligned, wrapping on a phone. Toolbar-only
 * actions (export, bulk) go last with className="ml-auto" as outline size=sm
 * buttons; counts and hints sit inline as text-sm text-muted-foreground.
 *
 * Renders a plain div; pass role="group" and an aria-label when the filters
 * need a collective name. Server-safe.
 */
export function FilterBar({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-wrap items-end gap-3", className)} {...props} />;
}

export interface FilterFieldProps {
  /** The control's id; the visible label points at it. On a radix Select it goes on SelectTrigger. */
  id: string;
  label: React.ReactNode;
  /** The control, sized by the page: DateField w-40, SelectTrigger w-44, SearchField max-w-sm. */
  children: React.ReactNode;
  className?: string;
}

/** One labelled control of a FilterBar: a visible Label htmlFor above the control. Server-safe. */
export function FilterField({ id, label, children, className }: FilterFieldProps) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}
