"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, RefreshCw, UserMinus } from "lucide-react";
import type { MessageLookup } from "@/lib/engine-message";
import { useApplyProposal, useDayProposal } from "@/lib/cover-queries";
import type { DayProposal } from "@/lib/cover-types";
import { coverErrorText, errorCode, pairKey, reasonText } from "@/lib/cover-view";
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

export interface ProposalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  date: string;
  dateText: string;
  /** "08:00–09:00 · Matematik · 7A" for a lesson on the board. */
  lessonText: (lessonId: string) => string;
  /** The absent person of a pair, by name. */
  absentName: (lessonId: string, absenceId: string) => string;
  nameOf: (userId: string) => string;
}

/** The items the admin keeps: every proposed one, until unticked. */
export function keptItems(proposal: DayProposal, unticked: ReadonlySet<string>) {
  return proposal.items
    .filter((item) => !unticked.has(pairKey(item)))
    .map(({ lessonId, absenceId, userId }) => ({ lessonId, absenceId, userId }));
}

/**
 * "Fördela dagen" (aSc's whole-day generate): one proposal for every open
 * lesson of the day, by the same hard rules as the suggestions, reviewed here
 * and applied in ONE transaction.
 *
 * The admin unticks what they do not want — any subset of a valid proposal is
 * valid, because every rule is monotone (spec §5.1) — or leaves a person out
 * and asks again. Apply sends the proposal's basis back; when the day moved
 * in between (COVER_PROPOSAL_STALE) nothing is applied and a fresh proposal
 * is computed.
 */
export function ProposalDialog({
  open,
  onOpenChange,
  date,
  dateText,
  lessonText,
  absentName,
  nameOf,
}: ProposalDialogProps) {
  const t = useTranslations("coverProposal");
  const tReasons = useTranslations("coverReasons") as unknown as MessageLookup;
  const tErrors = useTranslations("coverErrors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const propose = useDayProposal();
  const apply = useApplyProposal();
  const [excluded, setExcluded] = useState<string[]>([]);
  const [unticked, setUnticked] = useState<Set<string>>(new Set());

  const run = (exclude: string[]) => {
    setUnticked(new Set());
    propose.mutate(
      { date, excludeUserIds: exclude },
      { onError: (error) => toast.error(coverErrorText(tErrors, error, tCommon("error"))) },
    );
  };

  useEffect(() => {
    if (!open) return;
    setExcluded([]);
    run([]);
    // A fresh proposal each time the dialog opens, for the date it opens on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, date]);

  const proposal = propose.data;
  const kept = proposal ? keptItems(proposal, unticked) : [];

  const exclude = (userId: string) => {
    const next = [...excluded, userId];
    setExcluded(next);
    run(next);
  };

  const submit = async () => {
    if (!proposal || kept.length === 0) return;
    try {
      const result = await apply.mutateAsync({ date, basis: proposal.basis, items: kept });
      toast.success(t("applied", { count: result.applied }));
      onOpenChange(false);
    } catch (error) {
      toast.error(coverErrorText(tErrors, error, tCommon("error")));
      if (errorCode(error) === "COVER_PROPOSAL_STALE") run(excluded);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("title", { date: dateText })}</DialogTitle>
          <DialogDescription>{t("body")}</DialogDescription>
        </DialogHeader>

        {propose.isPending || !proposal ? (
          propose.isError ? null : <Skeleton className="h-40 w-full" />
        ) : proposal.items.length === 0 && proposal.unassigned.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <div className="space-y-4">
            {proposal.items.length > 0 ? (
              <ul className="divide-y rounded-md border" aria-label={t("itemsLabel")}>
                {proposal.items.map((item) => {
                  const key = pairKey(item);
                  const name = nameOf(item.userId);
                  return (
                    <li key={key} className="flex items-start gap-3 px-3 py-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-1"
                        aria-label={t("keep", { lesson: lessonText(item.lessonId) })}
                        checked={!unticked.has(key)}
                        onChange={(event) =>
                          setUnticked((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.delete(key);
                            else next.add(key);
                            return next;
                          })
                        }
                      />
                      <div className="flex-1">
                        <p className="font-medium">{lessonText(item.lessonId)}</p>
                        <p className="text-muted-foreground">
                          {t("line", { absent: absentName(item.lessonId, item.absenceId), substitute: name })}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {item.reasons
                            .slice(0, 3)
                            .map((reason) => reasonText(tReasons, reason))
                            .join(" · ")}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => exclude(item.userId)}
                        disabled={propose.isPending}
                        aria-label={t("exclude", { name })}
                      >
                        <UserMinus />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {proposal.unassigned.length > 0 ? (
              <div className="space-y-1">
                <h3 className="text-sm font-semibold">{t("unassignedTitle", { count: proposal.unassigned.length })}</h3>
                <ul className="space-y-1 text-sm">
                  {proposal.unassigned.map((entry) => (
                    <li key={pairKey(entry)}>
                      <span className="font-medium">{lessonText(entry.lessonId)}</span>
                      {" – "}
                      <span className="text-muted-foreground">{t(`why.${entry.why}`)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {excluded.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                {t("excludedNote", { names: excluded.map(nameOf).join(", ") })}
              </p>
            ) : null}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => run(excluded)} disabled={propose.isPending || apply.isPending}>
            <RefreshCw />
            {t("recompute")}
          </Button>
          <Button onClick={() => void submit()} disabled={kept.length === 0 || apply.isPending || propose.isPending}>
            {apply.isPending ? <Loader2 className="animate-spin" /> : null}
            {t("apply", { count: kept.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
