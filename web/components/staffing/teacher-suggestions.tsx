"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { useAssignTeacher, useSuggestTeachers } from "@/lib/staffing-queries";
import type { MessageLookup } from "@/lib/engine-message";
import {
  refusalText,
  staffingRefusal,
  type StaffingRefusal,
} from "@/lib/staffing-warnings";
import type { CandidateRemaining } from "@/lib/staffing-candidates";
import type { StaffingWarning, TeacherCandidate } from "@/lib/types";
import { badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CandidateBadge } from "@/components/staffing/candidate-badge";
import { RefusalNotice } from "@/components/staffing/staffing-notices";

/** Shown before "Visa alla": a school of sixty is a list nobody reads to the end. */
export const SUGGESTIONS_SHOWN = 6;

/** The gateway's remaining minutes, in the shape the Fas 1 badge paints. */
export function remainingOf(candidate: Pick<TeacherCandidate, "remainingMinutesPerWeek">): CandidateRemaining {
  const minutes = candidate.remainingMinutesPerWeek;
  if (minutes === null) return { status: "NO_TARGET" };
  return minutes < 0 ? { status: "OVER", minutes: -minutes } : { status: "REMAINING", minutes };
}

export interface TeacherSuggestionsProps {
  requirementId: string;
  /** The row's lead today, or null for an unstaffed row. */
  currentTeacherId: string | null;
  teacherName: (userId: string) => string;
  /** After a saved assignment, with what WARN mode said (possibly nothing). */
  onAssigned: (result: { teacherId: string | null; warnings: StaffingWarning[] }) => void;
}

/**
 * "Föreslå lärare": who could take one timplanspost, ranked by the gateway,
 * and a button per name that takes it.
 *
 * THE RANKING IS THE GATEWAY'S and nothing here re-sorts it — behörighet for
 * the group's grades, then the teacher who had the group's predecessor in the
 * subject last läsår, then already teaching the group, then room left after
 * the row (GET /staffing/suggest-teachers). Each name carries the badge the
 * timplan's own picker paints (CandidateBadge) — the same behörighet — but
 * with the minutes worded as what is left AFTER this row ("kvar efter
 * raden"): the picker in the requirements dialog shows the room the teacher
 * has today, and one string for two numbers made a teacher read "kvar 180"
 * there and "kvar 60" here. Plus what only this list knows: whether they
 * already teach the group, and whether this row would take them past the
 * policy's limit.
 *
 * "FÖRRA ÅRET" (staffing Fas 5) marks the lead or co-teacher of the subject on
 * the group's predecessor — the reason a name sits above one that already has
 * the group. The badge's own text names the group and the year (6A, 2025/26),
 * so a reader of the list sees why without a tooltip. Only here: the
 * timplanspost dialog on /admin/requirements paints its candidates from the
 * load report alone (lib/staffing-candidates.ts), and that route sits at its
 * budget to the decimal, so continuity is not computed there.
 *
 * ONE CLICK ASSIGNS. A REFUSE verdict comes back as a 409 and is shown here,
 * under the list, as the catalogue's sentence (subject, grades, minutes —
 * never the person, see lib/staffing-warnings.ts) — the list stays open so
 * the next name is one more click. A WARN verdict is a saved row, and goes
 * up to the caller, which shows it where the result is visible.
 */
export function TeacherSuggestions({
  requirementId,
  currentTeacherId,
  teacherName,
  onAssigned,
}: TeacherSuggestionsProps) {
  const t = useTranslations("staffing");
  const tCommon = useTranslations("common");
  const tEngine = useTranslations("engineMessages") as unknown as MessageLookup;
  const { data, isLoading, isError } = useSuggestTeachers(requirementId);
  const assign = useAssignTeacher();
  const [showAll, setShowAll] = useState(false);
  const [refusal, setRefusal] = useState<StaffingRefusal | null>(null);
  const [pendingId, setPendingId] = useState<string | null | undefined>(undefined);

  const take = async (teacherId: string | null) => {
    setRefusal(null);
    setPendingId(teacherId);
    try {
      const saved = await assign.mutateAsync({ requirementId, teacherId });
      onAssigned({ teacherId, warnings: saved?.warnings ?? [] });
    } catch (error) {
      const refused = staffingRefusal(error);
      if (refused) setRefusal(refused);
      else toast.error(error instanceof Error ? error.message : tCommon("error"));
    } finally {
      setPendingId(undefined);
    }
  };

  if (isLoading) return <Skeleton className="h-24 w-full" />;
  if (isError || !data) {
    return <p className="text-sm text-destructive">{t("suggestFailed")}</p>;
  }

  const shown = showAll ? data.candidates : data.candidates.slice(0, SUGGESTIONS_SHOWN);

  return (
    <div className="space-y-2">
      <p className="text-xs text-foreground">
        {t("suggestCharge", { minutes: data.teacherMinutesPerWeek })}
        {data.qualificationsRecorded ? "" : ` ${t("suggestNoQualifications")}`}
      </p>
      {data.candidates.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("suggestEmpty")}</p>
      ) : (
        <ol className="divide-y rounded-md border" aria-label={t("suggestListLabel")}>
          {shown.map((candidate) => {
            const name = teacherName(candidate.userId);
            return (
              <li
                key={candidate.userId}
                className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
                data-candidate={candidate.userId}
              >
                <div className="min-w-0 space-y-1">
                  <p className="text-sm font-medium">{name}</p>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <CandidateBadge
                      qualification={
                        data.qualificationsRecorded
                          ? { recorded: true, kind: candidate.qualificationKind }
                          : { recorded: false }
                      }
                      remaining={remainingOf(candidate)}
                      afterRow
                    />
                    {candidate.taughtLastYear ? (
                      <span className={badgeVariants({ variant: "outline" })}>
                        {data.lastYear
                          ? t("suggestLastYearNamed", {
                              group: data.lastYear.groupName,
                              year: data.lastYear.yearName,
                            })
                          : t("suggestLastYear")}
                      </span>
                    ) : null}
                    {candidate.teachesGroupAlready ? (
                      <span className={badgeVariants({ variant: "outline" })}>
                        {t("suggestTeachesGroup")}
                      </span>
                    ) : null}
                    {candidate.wouldExceed ? (
                      <span className={badgeVariants({ variant: "warning" })}>
                        {t("suggestWouldExceed")}
                      </span>
                    ) : null}
                  </span>
                </div>
                {candidate.currentlyAssigned || candidate.userId === currentTeacherId ? (
                  <span className={badgeVariants({ variant: "secondary" })}>{t("suggestCurrent")}</span>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={assign.isPending}
                    aria-label={t("suggestAssignNamed", { name })}
                    onClick={() => void take(candidate.userId)}
                  >
                    {pendingId === candidate.userId ? tCommon("saving") : t("suggestAssign")}
                  </Button>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <div className="flex flex-wrap gap-2">
        {data.candidates.length > SUGGESTIONS_SHOWN ? (
          <Button variant="ghost" size="sm" onClick={() => setShowAll((value) => !value)}>
            {showAll
              ? t("suggestShowFewer")
              : t("suggestShowAll", { count: data.candidates.length })}
          </Button>
        ) : null}
        {currentTeacherId ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={assign.isPending}
            onClick={() => void take(null)}
          >
            {pendingId === null ? tCommon("saving") : t("suggestUnassign")}
          </Button>
        ) : null}
      </div>
      {refusal ? <RefusalNotice text={refusalText(tEngine, refusal)} /> : null}
    </div>
  );
}
