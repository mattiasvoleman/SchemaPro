import { useTranslations } from "next-intl";
import { ArrowRight, Check, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface StepperStep {
  id: string;
  label: React.ReactNode;
  /** A finished step: tinted success with a Check, unless it is the current one. */
  done?: boolean;
  /** Drawn before the label of a step that is not done (setup's domain icons). Without it, the step's number. */
  icon?: LucideIcon;
  /** A trailing figure in the pill, such as setup's count of subjects. */
  meta?: React.ReactNode;
}

export interface StepperProps {
  steps: StepperStep[];
  /** The id of the step on screen; it gets aria-current="step". */
  current: string;
  /** The list's accessible name ("Steg i rullningen"). */
  label: string;
  /** Makes each step a button that jumps to it. Without it the steps are plain text (client parents only). */
  onSelect?: (id: string) => void;
  className?: string;
}

const PILL = "flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors";

/**
 * The wizard's progress: an ordered list of rounded pills with ArrowRight
 * between them. The current step is primary and aria-current="step"; a done
 * step is tinted success with a Check (its text stays foreground — the
 * success green on its own tint is 3.45:1, under AA). Lifted from the
 * rollover wizard; replaces setup's copy, which had no aria-current.
 *
 * Server-safe without onSelect (next-intl's useTranslations works on the server).
 */
export function Stepper({ steps, current, label, onSelect, className }: StepperProps) {
  const t = useTranslations("common");
  return (
    <ol className={cn("flex flex-wrap items-center gap-2", className)} aria-label={label}>
      {steps.map((step, index) => {
        const isCurrent = step.id === current;
        const isDone = Boolean(step.done) && !isCurrent;
        const Icon = step.icon;
        const content = (
          <>
            {isDone ? (
              <Check className="size-3.5 text-success-strong" aria-hidden="true" />
            ) : Icon ? (
              <Icon className="size-3.5" aria-hidden="true" />
            ) : (
              <span className="tabular-nums" aria-hidden="true">
                {index + 1}
              </span>
            )}
            {step.label}
            {/* The Check is drawn, so the state is also said: "Ämnen, klart". */}
            {step.done ? <span className="sr-only">, {t("stepDone")}</span> : null}
            {step.meta !== undefined ? <span className="tabular-nums">{step.meta}</span> : null}
          </>
        );
        const look = cn(
          PILL,
          isCurrent
            ? "border-primary bg-primary text-primary-foreground"
            : isDone
              ? "border-success/40 bg-success/10 text-foreground"
              : "text-muted-foreground",
          onSelect && !isCurrent && !isDone && "hover:bg-muted",
          onSelect && isDone && "hover:bg-success/20",
        );
        return (
          <li key={step.id} className="flex items-center gap-2">
            {onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(step.id)}
                aria-current={isCurrent ? "step" : undefined}
                className={look}
              >
                {content}
              </button>
            ) : (
              <span aria-current={isCurrent ? "step" : undefined} className={look}>
                {content}
              </span>
            )}
            {index < steps.length - 1 ? (
              <ArrowRight className="size-3.5 text-muted-foreground" aria-hidden="true" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
