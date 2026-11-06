import { TriangleAlert } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";
import { Notice } from "@/components/ui/notice";

/*
 * components/ui/load-error.tsx's two states, written out. LoadError is imported
 * by ninety-nine files, and one more route in its set of importers made
 * Turbopack cut the chunks of seven admin routes differently (+0.7 KB each;
 * measured by taking Krisläge's two pages out and putting LoadError back, one
 * variant at a time). EmptyState and Notice, which it is made of, did not do
 * that on their own. So these two pages draw the state from them directly:
 * the same markup, the same role, the same words.
 */
export function LoadFailed({
  title,
  hint,
  variant = "page",
  headingLevel,
  action,
}: {
  title: string;
  hint?: string;
  variant?: "page" | "inline";
  headingLevel?: 2 | 3;
  action?: React.ReactNode;
}) {
  if (variant === "inline") {
    return (
      <Notice tone="destructive" title={title} action={action}>
        {hint}
      </Notice>
    );
  }
  return (
    <div role="alert">
      <EmptyState icon={TriangleAlert} title={title} description={hint} headingLevel={headingLevel} action={action} />
    </div>
  );
}
