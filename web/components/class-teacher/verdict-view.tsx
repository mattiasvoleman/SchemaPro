import { CircleCheck, OctagonX, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { VerdictText } from "./use-class-teacher-text";

const ICON = {
  ok: { icon: CircleCheck, className: "text-success-strong" },
  warning: { icon: TriangleAlert, className: "text-warning-strong" },
  destructive: { icon: OctagonX, className: "text-destructive" },
} as const;

/**
 * A verdict, an outcome or a failed write said in a line and what lies under
 * it. The tone is in the icon and in the headline's words ("Kan publiceras",
 * "Krockar i schemat"), never in colour alone, and the text stays in the
 * foreground colour (as Notice does: the red and the green are never the ink).
 * No live role of its own: the caller's region announces it.
 */
export function VerdictView({ verdict, className }: { verdict: VerdictText; className?: string }) {
  const { icon: Icon, className: iconClass } = ICON[verdict.tone];
  return (
    <div data-tone={verdict.tone} className={cn("flex items-start gap-2 text-sm", className)}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", iconClass)} aria-hidden="true" />
      <div className="min-w-0 space-y-0.5">
        <p className="font-medium">{verdict.headline}</p>
        {verdict.lines.length === 1 ? <p>{verdict.lines[0]}</p> : null}
        {verdict.lines.length > 1 ? (
          <ul className="list-disc space-y-0.5 pl-5">
            {verdict.lines.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
