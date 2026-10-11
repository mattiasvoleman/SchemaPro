import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  /**
   * Overrides the description's colour. The AAA pages (breaks, gaps) pass
   * "text-foreground", so their hint is the description and not a paragraph
   * of its own under the box.
   */
  descriptionClassName?: string;
  action?: React.ReactNode;
  /**
   * The title's heading level. 3 (the default) inside a section with an h2;
   * 2 when the state stands directly under the page's h1, so no level is skipped.
   */
  headingLevel?: 2 | 3;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  descriptionClassName,
  action,
  headingLevel = 3,
  className,
}: EmptyStateProps) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-16 text-center",
        className,
      )}
    >
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <Icon className="size-6 text-muted-foreground" aria-hidden="true" />
      </div>
      <Heading className="mt-4 text-sm font-semibold">{title}</Heading>
      {description ? (
        <p className={cn("mt-1 max-w-sm text-sm text-muted-foreground", descriptionClassName)}>
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}
