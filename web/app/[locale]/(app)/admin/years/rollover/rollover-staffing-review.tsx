"use client";

import { useTranslations } from "next-intl";
import type { StaffingCarryPreview } from "@/lib/types";
import { StaffingCarrySummary, isEmptyCarry } from "@/components/staffing/staffing-carry-summary";

/**
 * Steg 4's tjänster och uppdrag (staffing Fas 5): what "Tjänster och uppdrag
 * följer med" will write, in the summary the carry dialog on /admin/staffing
 * shows too. Hidden when the plan has nothing to carry and nothing to say —
 * a school that has never entered a tjänst gets no card of zeros. With the
 * switch off the preview has no staffing at all, and the "not carried" list
 * below names the posts and uppdrag left behind, as before Fas 5.
 */
export function RolloverStaffingReview({
  staffing,
  teacherName,
}: {
  staffing: StaffingCarryPreview;
  teacherName: (userId: string) => string;
}) {
  const t = useTranslations("years");
  if (isEmptyCarry(staffing)) return null;
  return (
    <section aria-labelledby="review-staffing" className="space-y-1">
      <h3 id="review-staffing" className="font-medium">
        {t("reviewStaffing")}
      </h3>
      <StaffingCarrySummary preview={staffing} teacherName={teacherName} />
    </section>
  );
}
