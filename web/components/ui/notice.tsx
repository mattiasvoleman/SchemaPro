import { useTranslations } from "next-intl";
import { CircleCheck, OctagonX, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type NoticeTone = "neutral" | "warning" | "destructive" | "success";

/*
 * Every tone keeps its TEXT in the foreground colour and carries the tone in
 * the surface, the edge and the icon. text-destructive on bg-destructive/5
 * measures 4.45:1 in light and 4.41:1 in dark, just under AA for text-sm, and
 * text-success on its tint 3.45:1 — so the red and the green are never the ink.
 * The icons use the -strong shades (globals.css), which pass 3:1 for graphics.
 * Every tinted tone is a full hairline border on its tint, the same family as
 * destructive: no thick side stripe, the icon and the title carry the tone.
 */
const TONE_CLASS: Record<NoticeTone, string> = {
  neutral: "bg-muted",
  warning: "border border-warning/50 bg-warning/10",
  destructive: "border border-destructive/40 bg-destructive/5",
  success: "border border-success/40 bg-success/10",
};

const TONE_ICON: Record<NoticeTone, { icon: LucideIcon; className: string } | null> = {
  neutral: null,
  warning: { icon: TriangleAlert, className: "text-warning-strong" },
  destructive: { icon: OctagonX, className: "text-destructive" },
  success: { icon: CircleCheck, className: "text-success-strong" },
};

export interface NoticeProps {
  /** Defaults to neutral. */
  tone?: NoticeTone;
  /**
   * The live-region role. Defaults to "alert" for destructive and "status" for
   * the rest. Pass null inside a region that is already live and stays
   * mounted (breaks' notice region, the unstaffed panel): a role mounted
   * together with its content is often not announced, and nested live regions
   * announce twice.
   */
  role?: "status" | "alert" | null;
  /** The first line, in font-medium. */
  title?: React.ReactNode;
  /** The body: a sentence, or a list. */
  children?: React.ReactNode;
  /** One button at the right: Button variant="outline" size="sm". */
  action?: React.ReactNode;
  /** Shows a dismiss icon button when given (client parents only: it is a function). */
  onDismiss?: () => void;
  /** The dismiss button's name; defaults to common.close ("Stäng"). */
  dismissLabel?: string;
  /** Hides the tone icon (warning, destructive and success draw one by default). */
  hideIcon?: boolean;
  className?: string;
  id?: string;
}

/**
 * The one callout of the app: a state the page is in (neutral), something
 * that needs a decision (warning), something that failed (destructive), or a
 * finished step (success). Replaces the amber boxes, the bare role=alert
 * paragraphs and the six warning recipes.
 *
 * Server-safe without onDismiss (next-intl's useTranslations works on the server).
 */
export function Notice({
  tone = "neutral",
  role,
  title,
  children,
  action,
  onDismiss,
  dismissLabel,
  hideIcon = false,
  className,
  id,
}: NoticeProps) {
  const t = useTranslations("common");
  const liveRole = role === undefined ? (tone === "destructive" ? "alert" : "status") : role;
  const toneIcon = hideIcon ? null : TONE_ICON[tone];
  return (
    <div
      id={id}
      role={liveRole ?? undefined}
      data-tone={tone}
      className={cn(
        "flex flex-wrap items-start justify-between gap-3 rounded-md px-4 py-3 text-sm text-foreground",
        TONE_CLASS[tone],
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2">
        {toneIcon ? (
          <toneIcon.icon className={cn("mt-0.5 size-4 shrink-0", toneIcon.className)} aria-hidden="true" />
        ) : null}
        <div className="min-w-0 flex-1 space-y-1">
          {title ? <p className="font-medium">{title}</p> : null}
          {children ? <div>{children}</div> : null}
        </div>
      </div>
      {action || onDismiss ? (
        <div className="flex shrink-0 items-center gap-2">
          {action}
          {onDismiss ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={onDismiss}
              aria-label={dismissLabel ?? t("close")}
            >
              <X aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
