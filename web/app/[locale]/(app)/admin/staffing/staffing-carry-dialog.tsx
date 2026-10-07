"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ApiError } from "@/lib/api";
import { engineMessage, type MessageLookup } from "@/lib/engine-message";
import { StaffingCarrySummary, isEmptyCarry } from "@/components/staffing/staffing-carry-summary";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { STAFFING_ROLLOVER_STALE, useExecuteStaffingCarry, useStaffingCarryPreview } from "./use-staffing-carry";

/**
 * "Ta med tjänster och uppdrag" for a läsår that was rolled WITHOUT them —
 * before staffing Fas 5, or with the wizard's switch off. The gateway carries
 * from the year's predecessor, the same plan the rollover makes, and never
 * overwrites: a teacher who already has a post in the year is skipped whole
 * and named, so running it twice writes nothing the second time.
 *
 * DRY RUN FIRST. The dialog shows the gateway's preview (the summary the
 * wizard's review shows) and sends its hash; a post or uppdrag that moved in
 * between is a 409 that wrote nothing, and the preview is fetched again and
 * said so above it.
 *
 * AN ACTIVE YEAR ASKS ONCE MORE. A carry into the year that is running gives
 * teachers new blocked slots under a schedule that already exists; the
 * gateway warns (STAFFING_SLOTS_OVER_LESSONS) rather than refuses, because
 * carrying APT or rastvakt into a running year is legitimate. Here the admin
 * ticks that they know, before the button works.
 *
 * React.lazy from the page: the dialog opens on a click and costs the matrix
 * nothing until then.
 */
/** A problem's list params (group names) as one string; lib/year-rollover-form would bring the mirror along. */
const values = (params: Record<string, string | number | string[]>) =>
  Object.fromEntries(Object.entries(params).map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value]));

export function StaffingCarryDialog({
  year,
  onOpenChange,
  teacherName,
}: {
  year: { id: string; name: string; isActive: boolean } | null;
  onOpenChange: (open: boolean) => void;
  teacherName: (userId: string) => string;
}) {
  const t = useTranslations("staffing.carry");
  const tCommon = useTranslations("common");
  const tProblems = useTranslations("years.problems") as unknown as MessageLookup;
  const tErrors = useTranslations("staffing.carry.errors") as unknown as MessageLookup;
  const preview = useStaffingCarryPreview(year?.id ?? null);
  const execute = useExecuteStaffingCarry(year?.id ?? null);
  const [confirmed, setConfirmed] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const plan = preview.data;

  const errorText = (error: unknown) =>
    error instanceof ApiError
      ? engineMessage(tErrors, { code: error.code ?? null, message: error.message, params: error.params ?? null })
      : tCommon("error");

  const nothing = plan ? plan.employments.carried + plan.duties.carried === 0 : true;
  const canCarry =
    plan !== undefined && !preview.isFetching && !nothing && !execute.isPending && (!year?.isActive || confirmed);

  const carry = async () => {
    if (!plan) return;
    setRefusal(null);
    try {
      const result = await execute.mutateAsync(plan.planHash);
      toast.success(
        t("done", {
          year: plan.target.name,
          employments: result.counts.employments,
          duties: result.counts.duties,
        }),
      );
      onOpenChange(false);
    } catch (error) {
      // Stale: nothing was written, and onSettled is already refetching the preview.
      setRefusal(errorText(error));
      if (!(error instanceof ApiError && error.code === STAFFING_ROLLOVER_STALE)) toast.error(errorText(error));
    }
  };

  return (
    <Dialog open={year !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title", { year: year?.name ?? "" })}</DialogTitle>
          <DialogDescription>
            {plan ? t("intro", { source: plan.source.name, target: plan.target.name }) : t("introLoading")}
          </DialogDescription>
        </DialogHeader>

        {refusal ? (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {refusal}
          </p>
        ) : null}

        {preview.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorText(preview.error)}
          </p>
        ) : !plan ? (
          <Skeleton className="h-32 w-full" />
        ) : isEmptyCarry(plan) ? (
          <p className="text-sm">{t("empty", { source: plan.source.name })}</p>
        ) : (
          <div className="space-y-3">
            <StaffingCarrySummary preview={plan} teacherName={teacherName} />
            {plan.problems.length > 0 ? (
              <ul className="space-y-1 text-sm" aria-label={t("problemsLabel")}>
                {plan.problems.map((problem, index) => (
                  <li key={`${problem.code}-${index}`} className="rounded-md border border-warning/40 bg-warning/5 p-2">
                    {engineMessage(tProblems, {
                      code: problem.code,
                      message: problem.code,
                      params: values(problem.params),
                    })}
                  </li>
                ))}
              </ul>
            ) : null}
            {nothing ? <p className="text-sm">{t("nothingLeft")}</p> : null}
            {year?.isActive && !nothing ? (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={confirmed}
                  onChange={(event) => setConfirmed(event.target.checked)}
                />
                <span>{t("activeConfirm", { year: year.name })}</span>
              </label>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={() => void carry()} disabled={!canCarry}>
            {execute.isPending ? tCommon("saving") : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
