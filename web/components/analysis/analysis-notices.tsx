"use client";

import type { AnalysisNotice, AnalysisNoticeCode } from "@/lib/analysis-types";
import { Notice } from "@/components/ui/notice";
import { useAnalysisText } from "@/components/analysis/use-analysis-text";

/** What stops a figure from being right, as opposed to what only explains it. */
const WARNING: ReadonlySet<AnalysisNoticeCode> = new Set([
  "ANALYSIS_RATE_MISSING",
  "ANALYSIS_NOTHING_PUBLISHED",
  "ANALYSIS_COVER_TO_CHECK",
  "ANALYSIS_CHARACTERS_REPLACED",
  // A row by its code alone: payroll books it only once the school says whose it is.
  "ANALYSIS_PROTECTED_WITHOUT_PAYROLL_NUMBER",
]);

/** The gateway's notices of an answer, each a sentence, the ones that change a figure as warnings. */
export function AnalysisNotices({ notices }: { notices: readonly AnalysisNotice[] }) {
  const { notice } = useAnalysisText();
  if (notices.length === 0) return null;
  return (
    <div className="space-y-2">
      {notices.map((one, index) => (
        <Notice key={`${one.code}-${index}`} tone={WARNING.has(one.code) ? "warning" : "neutral"}>
          {notice(one)}
        </Notice>
      ))}
    </div>
  );
}
