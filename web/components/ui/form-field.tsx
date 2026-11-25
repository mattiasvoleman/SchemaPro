import * as React from "react";
import { useTranslations } from "next-intl";
import { Label } from "@/components/ui/label";
import { fieldProblem, type ProblemLookup } from "@/lib/api-error-text";
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
   * The property the gateway's validation names for this control (`capacity`). Inside a FormProblems, a refusal whose sentence names
   * the property is drawn here as the error, unless `error` is given; a refusal that names no property stays with the form's toast.
   */
  field?: string;
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

const FormProblemsContext = React.createContext<unknown>(undefined);

/**
 * The box a form's fields are laid in (a div, with the `className` the form gave it), and the failed save they read: each FormField
 * with a `field` that the gateway's validation names draws the sentence beside its control (lib/api-error-text.ts fieldProblem). The
 * form still says the failure in its toast, which lists every sentence, among them those that name no field; the field is where the
 * reader looks for what to change. Pass the error of the last save, and `null` once the form is opened again or sent again.
 */
export function FormProblems({ error, className, children }: { error: unknown; className?: string; children: React.ReactNode }) {
  return (
    <FormProblemsContext.Provider value={error}>
      <div className={className}>{children}</div>
    </FormProblemsContext.Provider>
  );
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
  error: given,
  field,
  children,
  className,
  hintClassName,
}: FormFieldProps) {
  const t = useTranslations("common");
  const failure = React.useContext(FormProblemsContext);
  const error = given ?? (field ? fieldProblem(failure, field, t as unknown as ProblemLookup) : undefined);
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
