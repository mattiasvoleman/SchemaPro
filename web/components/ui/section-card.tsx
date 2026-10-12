import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SectionCardProps extends Omit<React.HTMLAttributes<HTMLElement>, "title"> {
  /**
   * The section's id. The heading gets `${id}-title` and names the region, so
   * a link can target `#${id}` and a test can find the region by its name.
   */
  id: string;
  title: React.ReactNode;
  /** 2 for a section of the page (the default), 3 for one nested inside another section. */
  headingLevel?: 2 | 3;
  /** One or two sentences under the title. */
  description?: React.ReactNode;
  /**
   * Overrides the description's colour. The AAA pages (breaks, gaps) pass
   * "text-foreground"; everyone else keeps the muted default.
   */
  descriptionClassName?: string;
  /** A small action at the header's right end: Button variant="outline" size="sm". */
  action?: React.ReactNode;
  /** A decorative icon before the title, drawn size-4 and hidden from assistive tech. */
  icon?: LucideIcon;
  /** A border-t row of right-aligned buttons: the settings card's Save. */
  footer?: React.ReactNode;
}

/**
 * A titled block of a page: a <section> named by its own h2 (or h3), in the
 * card surface every later page uses. Replaces shadcn Card in page content,
 * whose CardTitle is a div and so gave those pages no section headings.
 *
 * Server-safe: no hooks, no "use client".
 */
export function SectionCard({
  id,
  title,
  headingLevel = 2,
  description,
  descriptionClassName,
  action,
  icon: Icon,
  footer,
  className,
  children,
  ...props
}: SectionCardProps) {
  const Heading = headingLevel === 3 ? "h3" : "h2";
  const titleId = `${id}-title`;
  return (
    <section
      id={id}
      aria-labelledby={titleId}
      className={cn("space-y-3 rounded-lg border bg-card p-4", className)}
      {...props}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <Heading
            id={titleId}
            className={cn(
              "font-semibold",
              headingLevel === 3 ? "text-sm" : "text-base",
              Icon && "flex items-center gap-2",
            )}
          >
            {Icon ? <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /> : null}
            {title}
          </Heading>
          {description ? (
            <div className={cn("text-sm text-muted-foreground", descriptionClassName)}>{description}</div>
          ) : null}
        </div>
        {action ? <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div> : null}
      </div>
      {children}
      {footer ? <div className="flex justify-end gap-2 border-t pt-3">{footer}</div> : null}
    </section>
  );
}
