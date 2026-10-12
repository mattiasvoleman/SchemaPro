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

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { MessageLookup } from "@/lib/engine-message";
import { publicationErrorText } from "@/lib/publication-messages";
import type { CancellationBatch } from "@/lib/publication-types";
import type { AcademicYear, Room, StudentGroup } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCard } from "@/components/ui/table-card";
import {
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
  const locale = useLocale();
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
  // A batch's days are calendar days (yyyy-mm-dd), read at UTC midnight so no
  // time zone moves one to the day before.
  const dayFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }),
    [locale],
  );
  const dayOf = (date: string) => new Date(`${date}T00:00:00.000Z`);
  const dayText = (date: string) => dayFormat.format(dayOf(date));
  const periodText = (batch: CancellationBatch) =>
    batch.fromDate === batch.toDate
      ? dayText(batch.fromDate)
      : dayFormat.formatRange(dayOf(batch.fromDate), dayOf(batch.toDate));

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
    <SectionCard id="cancel-batches" title={t("listTitle", { year: year.name })}>
      {batches.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-16 w-full" />
        </div>
      ) : batches.isError ? (
        <LoadError variant="inline" title={t("listLoadFailed")} hint={t("listLoadFailedHint")} />
      ) : !batches.data || batches.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("listNone")}</p>
      ) : (
        <TableCard caption={t("listCaption", { year: year.name })}>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t("name")}</TableHead>
              <TableHead scope="col">{t("period")}</TableHead>
              <TableHead scope="col">{t("scope")}</TableHead>
              <TableHead scope="col" className="text-right">
                {t("cancelledCount")}
              </TableHead>
              <TableHead scope="col">{t("state")}</TableHead>
              <TableHead scope="col">
                <span className="sr-only">{tCommon("actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {batches.data.map((batch) => (
              <TableRow key={batch.id}>
                <TableCell className="font-medium">
                  {batch.name}
                  <span className="block text-xs font-normal text-muted-foreground">{t(`causes.${batch.cause}`)}</span>
                </TableCell>
                <TableCell className="whitespace-nowrap tabular-nums">
                  {periodText(batch)}
                  {batch.startTime && batch.endTime ? (
                    <span className="block text-xs text-muted-foreground">{`${batch.startTime}–${batch.endTime}`}</span>
                  ) : null}
                </TableCell>
                <TableCell>{scopeLabel(batch)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {batch.cancelled}
                  {batch.credits > 0 ? (
                    <span className="block text-xs text-muted-foreground">
                      {t("creditsCount", { count: batch.credits })}
                    </span>
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
                    <span className="block pt-1 text-xs text-muted-foreground">
                      {t("addedSince", { count: batch.addedSince })}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex flex-wrap justify-end gap-2">
                    {!batch.reversedAt && batch.addedSince > 0 ? (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={tCommon("actionNamed", { action: t("reapply"), name: batch.name })}
                        onClick={() => void doReapply(batch)}
                        disabled={reapply.isPending}
                      >
                        {reapply.isPending && reapply.variables === batch.id ? <Loader2 className="animate-spin" /> : null}
                        {t("reapply")}
                      </Button>
                    ) : null}
                    {batch.reversedAt ? null : (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={tCommon("actionNamed", { action: t("reverse"), name: batch.name })}
                        onClick={() => setReversing(batch)}
                      >
                        {t("reverse")}
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </TableCard>
      )}

      {/* The reversal's own confirmation: ConfirmDialog's rules (a named
          question, what happens, the verb, held open while it runs), with the
          gateway's preview of what comes back and what stays cancelled. */}
      <Dialog
        open={reversing !== null}
        onOpenChange={(open) => {
          if (!open && !reverse.isPending) setReversing(null);
        }}
      >
        <DialogContent className="max-w-lg" closeDisabled={reverse.isPending}>
          <DialogHeader>
            <DialogTitle>{t("reverseTitle", { name: reversing?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("reverseBody")}</DialogDescription>
          </DialogHeader>
          {reversePreview.isLoading ? <Skeleton className="h-12 w-full" /> : null}
          {reversePreview.isError ? (
            <Notice tone="destructive">{publicationErrorText(tErrors, reversePreview.error, tCommon("error"))}</Notice>
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
                        {dayText(row.date)} · {roomName(row.roomId)} · {t(`takenBy.${row.by}`)}
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
                      <li key={row.lessonId}>{dayText(row.date)}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {plan.notReinstatable > 0 ? <p>{t("reverseHistory", { count: plan.notReinstatable })}</p> : null}
              {plan.creditsDeleted > 0 ? <p>{t("reverseCredits", { count: plan.creditsDeleted })}</p> : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReversing(null)} disabled={reverse.isPending}>
              {tCommon("cancel")}
            </Button>
            <Button onClick={doReverse} disabled={!plan || reverse.isPending}>
              {reverse.isPending ? <Loader2 className="animate-spin" /> : null}
              {t("reverseConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}
