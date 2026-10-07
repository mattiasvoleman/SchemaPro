"use client";

import { useTranslations } from "next-intl";
import { OctagonX, TriangleAlert, X } from "lucide-react";
import type { MessageLookup } from "@/lib/engine-message";
import { warningText } from "@/lib/staffing-warnings";
import type { StaffingWarning } from "@/lib/types";
import { Button } from "@/components/ui/button";

/*
 * The two things a staffing write can say back, painted once for every place
 * that writes: a WARN banner over a saved row, and a REFUSE notice over a
 * row that was not saved.
 *
 * CONTRAST: the sentence is `text-foreground` on the card (18.69 / 15.43), so
 * no colour carries a word. The icons carry the tone — `text-warning` and
 * `text-destructive` on card are graphical objects above 3:1 (the badge
 * measurements in staffing-matrix.tsx) — and the heading says "Sparad med
 * varning" / "Vägrades" in words. A red-tinted box was not used: the breaks
 * page measured the tint's border at 1.60 / 1.43, below 3:1, doing no work.
 */

export function WarningsNotice({
  warnings,
  onDismiss,
}: {
  warnings: StaffingWarning[];
  onDismiss?: () => void;
}) {
  const t = useTranslations("staffing");
  const tEngine = useTranslations("engineMessages") as unknown as MessageLookup;
  if (warnings.length === 0) return null;
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-md border bg-card px-3 py-2 text-sm text-foreground"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{t("warnedTitle")}</p>
        <ul className="list-disc space-y-0.5 pl-4">
          {warnings.map((warning, index) => (
            <li key={`${warning.code}-${index}`}>{warningText(tEngine, warning)}</li>
          ))}
        </ul>
      </div>
      {onDismiss ? (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={onDismiss}
          aria-label={t("warnedDismiss")}
        >
          <X className="size-4" />
        </Button>
      ) : null}
    </div>
  );
}

export function RefusalNotice({ text }: { text: string }) {
  const t = useTranslations("staffing");
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border bg-card px-3 py-2 text-sm text-foreground"
    >
      <OctagonX className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
      <p>
        <span className="font-medium">{t("refusedTitle")}</span> {text}
      </p>
    </div>
  );
}
