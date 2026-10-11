"use client";

import { useTranslations } from "next-intl";
import type { MessageLookup } from "@/lib/engine-message";
import { warningText } from "@/lib/staffing-warnings";
import type { StaffingWarning } from "@/lib/types";
import { Notice } from "@/components/ui/notice";

/*
 * The two things a staffing write can say back, painted once for every place
 * that writes: a WARN banner over a saved row, and a REFUSE notice over a
 * row that was not saved. Both are the app's one Notice (components/ui/
 * notice.tsx): a warning and a destructive tone.
 *
 * CONTRAST: the sentence is `text-foreground` (on muted 17.00 / 13.19, on the
 * destructive tint as Notice measures it), so no colour carries a word. The
 * icons carry the tone, and the heading says "Sparad med varning" /
 * "Vägrades" in words.
 */

export function WarningsNotice({
  warnings,
  onDismiss,
  context,
  live = true,
}: {
  warnings: StaffingWarning[];
  onDismiss?: () => void;
  /**
   * False inside a region that is already live and stays mounted (the
   * unstaffed panel's): a status role mounted together with its content is
   * often not announced, and two nested live regions announce twice.
   */
  live?: boolean;
  /**
   * Which row the warning is about, when the banner outlives the place the
   * save was made — the timplansposter matrix shows it after its dialog has
   * closed, and "Läraren hamnar på 1 200 min/v" alone does not say where.
   * Group · subject, never a teacher's name.
   */
  context?: string;
}) {
  const t = useTranslations("staffing");
  const tEngine = useTranslations("engineMessages") as unknown as MessageLookup;
  if (warnings.length === 0) return null;
  return (
    <Notice
      tone="warning"
      role={live ? "status" : null}
      title={
        <>
          {t("warnedTitle")}
          {context ? ` ${context}` : null}
        </>
      }
      onDismiss={onDismiss}
      dismissLabel={t("warnedDismiss")}
    >
      <ul className="list-disc space-y-0.5 pl-4">
        {warnings.map((warning, index) => (
          <li key={`${warning.code}-${index}`}>{warningText(tEngine, warning)}</li>
        ))}
      </ul>
    </Notice>
  );
}

export function RefusalNotice({ text }: { text: string }) {
  const t = useTranslations("staffing");
  return (
    <Notice tone="destructive">
      <span className="font-medium">{t("refusedTitle")}</span> {text}
    </Notice>
  );
}
