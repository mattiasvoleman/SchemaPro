import { ArrowLeft } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DocumentTitle } from "./document-title";

export interface PageHeaderBack {
  href: string;
  /** Where it goes, named ("Till tjänstefördelningen"), never the generic "Tillbaka". */
  label: string;
}

export interface PageHeaderProps {
  /** The h1, and the browser tab's title ("{title} · Rastra Schema", in the page's language). */
  title: string;
  /** One sentence, no trailing period. */
  subtitle?: string;
  /** A ghost link above the h1 to the page this one belongs under. Hidden in print. */
  back?: PageHeaderBack;
  /** A row of Badges under the title: plan status, publication state. */
  meta?: React.ReactNode;
  /** A longer explanation under the subtitle, in foreground text held to a readable measure. */
  intro?: React.ReactNode;
  /**
   * Left to right: the scope selector (YearSelect), outline secondary actions,
   * at most one primary action. More than four go behind a MoreHorizontal menu.
   */
  actions?: React.ReactNode;
}

/**
 * The one header of every in-app page. Server-safe: the only client part is
 * DocumentTitle, which names the browser tab after the h1.
 */
export function PageHeader({ title, subtitle, back, meta, intro, actions }: PageHeaderProps) {
  // A title with a subtitle centres its actions on the pair. A badge row or an
  // intro paragraph makes the block several lines tall, and centred actions
  // would float halfway down the paragraph, beside nothing; at the top they
  // sit beside the title they act on.
  const tall = Boolean(meta || intro);
  return (
    <div
      className={cn(
        "mb-6 flex flex-col gap-3 sm:flex-row sm:justify-between",
        tall ? "sm:items-start" : "sm:items-center",
      )}
    >
      <DocumentTitle title={title} />
      <div className="min-w-0">
        {back ? (
          <Button variant="ghost" size="sm" asChild className="-ml-2 mb-1 print:hidden">
            <Link href={back.href}>
              <ArrowLeft aria-hidden="true" />
              {back.label}
            </Link>
          </Button>
        ) : null}
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p> : null}
        {meta ? <div className="mt-2 flex flex-wrap gap-2">{meta}</div> : null}
        {intro ? <div className="mt-2 max-w-prose text-sm text-foreground">{intro}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
