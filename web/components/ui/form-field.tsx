import * as React from "react";
import { useTranslations } from "next-intl";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** What FormField hands its control: spread it on the input, or on a radix SelectTrigger. */
export interface FormFieldControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}

export interface FormFieldProps {
  /** The control's id. The label points at it; the hint and error ids derive from it. */
  id: string;
  label: React.ReactNode;
  /** Adds "(valfritt)" in muted text inside the label. */
  optional?: boolean;
  /** A short help line under the control, linked by aria-describedby. */
  hint?: React.ReactNode;
  /** The validation message; marks the control aria-invalid and links it too. */
  error?: React.ReactNode;
  /**
   * The control. An element (Input, Textarea, DateField) gets the id and the
   * aria props merged in. A radix Select needs them on its SelectTrigger, not
   * on its Root, so pass a function instead:
   *   {(control) => <Select …><SelectTrigger {...control}>…</SelectTrigger></Select>}
   */
  children: React.ReactElement | ((control: FormFieldControlProps) => React.ReactNode);
  className?: string;
  /** The hint's colour; the AAA pages pass "text-foreground". */
  hintClassName?: string;
}

/** The hint's id for a field id, for a control wired by hand. */
export const formFieldHintId = (id: string) => `${id}-hint`;
/** The error's id for a field id. */
export const formFieldErrorId = (id: string) => `${id}-error`;

/**
 * One labelled form control: a Label htmlFor, the control, a muted hint and
 * a destructive error, each linked to the control. The fix for the
 * unlabelled Selects on rooms, groups, people, constraints, lessons,
 * teacher-absence and guardian. Lay several out in
 * "grid gap-4 sm:grid-cols-2 [&>*]:min-w-0".
 */
export function FormField({
  id,
  label,
  optional = false,
  hint,
  error,
  children,
  className,
  hintClassName,
}: FormFieldProps) {
  const t = useTranslations("common");
  const hintId = hint ? formFieldHintId(id) : undefined;
  const errorId = error ? formFieldErrorId(id) : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  const control: FormFieldControlProps = {
    id,
    ...(describedBy ? { "aria-describedby": describedBy } : {}),
    ...(error ? { "aria-invalid": true as const } : {}),
  };

  let rendered: React.ReactNode;
  if (typeof children === "function") {
    rendered = children(control);
  } else {
    const own = children.props as { "aria-describedby"?: string };
    const merged = [own["aria-describedby"], describedBy].filter(Boolean).join(" ") || undefined;
    rendered = React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
      ...control,
      ...(merged ? { "aria-describedby": merged } : {}),
    });
  }

  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={id}>
        {label}
        {optional ? (
          <>
            {" "}
            <span className="font-normal text-muted-foreground">({t("optional")})</span>
          </>
        ) : null}
      </Label>
      {rendered}
      {hint ? (
        <p id={hintId} className={cn("text-xs text-muted-foreground", hintClassName)}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
