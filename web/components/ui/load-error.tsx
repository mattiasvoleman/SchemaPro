import { TriangleAlert } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";

export interface LoadErrorProps {
  /** "X kunde inte hämtas": the namespace's loadFailed. */
  title: string;
  /** What did NOT change, or why no numbers are shown: the namespace's loadFailedHint. */
  hint?: string;
  /**
   * page (the default): the whole region failed, drawn as an EmptyState with
   * TriangleAlert in the place the content would have been.
   * inline: one section of a working page failed, drawn as a destructive
   * Notice (role=alert) inside that section.
   */
  variant?: "page" | "inline";
  /** page only: the AAA pages (breaks, gaps) pass "text-foreground". */
  hintClassName?: string;
  /** page only: 2 when it stands directly under the h1, 3 (default) inside a section. */
  headingLevel?: 2 | 3;
  /** A retry or a way out, when the page has one. */
  action?: React.ReactNode;
  className?: string;
}

/**
 * The error rung of the state ladder (loading → error → no scope → empty →
 * content). Every query-backed region renders this on isError, so a failed
 * request never falls through to "nothing here" or to a 0.
 *
 * Server-safe.
 */
export function LoadError({
  title,
  hint,
  variant = "page",
  hintClassName,
  headingLevel,
  action,
  className,
}: LoadErrorProps) {
  if (variant === "inline") {
    return (
      <Notice tone="destructive" title={title} action={action} className={className}>
        {hint}
      </Notice>
    );
  }
  // role=alert on a wrapper: the state replaces a skeleton after the request
  // fails, and without a live role a screen reader hears nothing change.
  return (
    <div role="alert">
      <EmptyState
        icon={TriangleAlert}
        title={title}
        description={hint}
        descriptionClassName={hintClassName}
        headingLevel={headingLevel}
        action={action}
        className={className}
      />
    </div>
  );
}
