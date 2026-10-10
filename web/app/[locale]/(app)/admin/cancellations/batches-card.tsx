"use client";

/*
 * The year's avbokningar: what each cancelled, whether it has been taken
 * back, and — for one still standing — lessons written into its days since
 * (a publish or a påfyllning after it), with "Tillämpa igen" to cancel those
 * too.
 *
 * TA TILLBAKA asks the gateway first what a reversal would do: how many
 * lessons come back, which stay cancelled because their room was booked or
 * given to another lesson meanwhile (named, so the admin can sort it out by
 * hand rather than find two classes in one room), how many have begun or
 * been changed since and are history, and the credits it deletes. Then it
 * reverses, once — a second reversal is refused.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { MessageLookup } from "@/lib/engine-message";
import { publicationErrorText } from "@/lib/publication-messages";
import type { CancellationBatch } from "@/lib/publication-types";
import type { AcademicYear, Room, StudentGroup } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useCancellationBatches,
  useReapplyBatch,
  useReverseBatch,
  useReversePreview,
} from "./use-cancellation-batches";

export function BatchesCard({
  year,
  groups,
  rooms,
}: {
  year: AcademicYear;
  groups: readonly StudentGroup[];
  rooms: readonly Room[];
}) {
  const t = useTranslations("cancellations");
  const tErrors = useTranslations("publishing.errors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const tGrades = useTranslations("grades");
  const batches = useCancellationBatches(year.id);
  const reapply = useReapplyBatch();
  const reverse = useReverseBatch();
  const [reversing, setReversing] = useState<CancellationBatch | null>(null);
  const reversePreview = useReversePreview(reversing?.id ?? null);

  const scopeLabel = (batch: CancellationBatch): string => {
    if (batch.scope === "SCHOOL") return t("scopes.SCHOOL");
    if (batch.scope === "GRADES") {
      const { minGradeLevel: min, maxGradeLevel: max } = batch;
      if (min === null || max === null) return t("scopes.GRADES");
      return min === max ? tGrades("grade", { grade: min }) : t("gradeRange", { min, max });
    }
    return batch.groupIds.map((id) => groups.find((group) => group.id === id)?.name ?? "?").join(", ");
  };
  const roomName = (id: string) => rooms.find((room) => room.id === id)?.name ?? "?";

  const doReapply = async (batch: CancellationBatch) => {
    try {
      const outcome = await reapply.mutateAsync(batch.id);
      toast.success(t("reapplied", { count: outcome.added }));
    } catch (error) {
      toast.error(publicationErrorText(tErrors, error, tCommon("error")));
    }
  };

  const doReverse = async () => {
    if (!reversing) return;
    try {
      const outcome = await reverse.mutateAsync(reversing.id);
      toast.success(t("reversed", { count: outcome.reinstate }));
      setReversing(null);
    } catch (error) {
      toast.error(publicationErrorText(tErrors, error, tCommon("error")));
    }
  };

  const plan = reversePreview.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("listTitle", { year: year.name })}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {batches.isLoading ? <Skeleton className="h-16 w-full" /> : null}
        {batches.isError ? (
          <p role="alert">{publicationErrorText(tErrors, batches.error, tCommon("error"))}</p>
        ) : null}
        {batches.data && batches.data.length === 0 ? <p>{t("listNone")}</p> : null}
        {batches.data && batches.data.length > 0 ? (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-foreground">{t("name")}</TableHead>
                  <TableHead className="text-foreground">{t("period")}</TableHead>
                  <TableHead className="text-foreground">{t("scope")}</TableHead>
                  <TableHead className="text-right text-foreground">{t("cancelledCount")}</TableHead>
                  <TableHead className="text-foreground">{t("state")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {batches.data.map((batch) => (
                  <TableRow key={batch.id}>
                    <TableCell>
                      {batch.name}
                      <span className="block text-xs">{t(`causes.${batch.cause}`)}</span>
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {batch.fromDate === batch.toDate ? batch.fromDate : `${batch.fromDate}–${batch.toDate}`}
                      {batch.startTime && batch.endTime ? ` ${batch.startTime}–${batch.endTime}` : ""}
                    </TableCell>
                    <TableCell>{scopeLabel(batch)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {batch.cancelled}
                      {batch.credits > 0 ? (
                        <span className="block text-xs">{t("creditsCount", { count: batch.credits })}</span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {batch.reversedAt ? (
                        <Badge variant="outline">
                          {t("stateReversed", { count: batch.reinstated, skipped: batch.skippedRoomTaken })}
                        </Badge>
                      ) : (
                        <Badge variant="secondary">{t("stateActive")}</Badge>
                      )}
                      {!batch.reversedAt && batch.addedSince > 0 ? (
                        <span className="mt-1 block text-xs">{t("addedSince", { count: batch.addedSince })}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="space-x-2 whitespace-nowrap text-right">
                      {!batch.reversedAt && batch.addedSince > 0 ? (
                        <Button variant="outline" size="sm" onClick={() => void doReapply(batch)} disabled={reapply.isPending}>
                          {t("reapply")}
                        </Button>
                      ) : null}
                      {batch.reversedAt ? null : (
                        <Button variant="outline" size="sm" onClick={() => setReversing(batch)}>
                          {t("reverse")}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </CardContent>

      <Dialog open={reversing !== null} onOpenChange={(open) => (open ? null : setReversing(null))}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("reverseTitle", { name: reversing?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("reverseBody")}</DialogDescription>
          </DialogHeader>
          {reversePreview.isLoading ? <Skeleton className="h-12 w-full" /> : null}
          {reversePreview.isError ? (
            <p role="alert" className="text-sm">
              {publicationErrorText(tErrors, reversePreview.error, tCommon("error"))}
            </p>
          ) : null}
          {plan ? (
            <div className="space-y-2 text-sm">
              <p>{t("reverseReinstate", { count: plan.reinstate })}</p>
              {plan.skippedRoomTaken.length > 0 ? (
                <div className="space-y-1">
                  <p>{t("reverseRoomTaken", { count: plan.skippedRoomTaken.length })}</p>
                  <ul className="list-disc pl-5 text-xs">
                    {plan.skippedRoomTaken.map((row) => (
                      <li key={row.lessonId}>
                        {row.date} · {roomName(row.roomId)} · {t(`takenBy.${row.by}`)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {plan.removedTemplateMoved.length > 0 ? (
                <div className="space-y-1">
                  <p>{t("reverseTemplateMoved", { count: plan.removedTemplateMoved.length })}</p>
                  <ul className="list-disc pl-5 text-xs">
                    {plan.removedTemplateMoved.map((row) => (
                      <li key={row.lessonId}>{row.date}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {plan.notReinstatable > 0 ? <p>{t("reverseHistory", { count: plan.notReinstatable })}</p> : null}
              {plan.creditsDeleted > 0 ? <p>{t("reverseCredits", { count: plan.creditsDeleted })}</p> : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReversing(null)}>
              {tCommon("cancel")}
            </Button>
            <Button onClick={doReverse} disabled={!plan || reverse.isPending}>
              {t("reverseConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
