"use client";

/*
 * Ta bort: asks the gateway first what a removal would do, then removes, once.
 *
 * A removal is an avbokning's reversal and more: the lessons the activity
 * cancelled that are ahead come back, its replacement lessons ahead and
 * without attendance are deleted, and the credits dated today or later go.
 * A replacement lesson that has begun or carries a register is the record of a
 * day that was held. It stays, and so do the lessons it replaced, because
 * putting them back beside it would give the class two lessons that day.
 * Lessons whose room was booked or given to another lesson meanwhile stay
 * cancelled, named by room, so the admin can sort them out by hand rather
 * than find two classes in one room.
 */

import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { ScheduleActivity } from "@/lib/schedule-activity-types";
import type { Room } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import { useFormats, useErrorText } from "./activity-format";
import { useRemoveActivity, useRemovePreview } from "./use-schedule-activities";

export function RemoveActivityDialog({
  activity,
  rooms,
  onClose,
}: {
  activity: ScheduleActivity | null;
  rooms: readonly Room[];
  onClose: () => void;
}) {
  const t = useTranslations("scheduleActivities");
  const tCommon = useTranslations("common");
  const errorText = useErrorText();
  const { dayText } = useFormats();
  const preview = useRemovePreview(activity?.id ?? null);
  const remove = useRemoveActivity();
  const plan = preview.data;
  const roomName = (id: string) => rooms.find((room) => room.id === id)?.name ?? "?";

  const doRemove = async () => {
    if (!activity) return;
    try {
      const outcome = await remove.mutateAsync(activity.id);
      // A lesson carried to its new time is back too.
      toast.success(t("removed", { count: outcome.reinstate + (outcome.relocated?.length ?? 0) }));
      onClose();
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  return (
    <Dialog
      open={activity !== null}
      onOpenChange={(open) => {
        if (!open && !remove.isPending) onClose();
      }}
    >
      <DialogContent className="max-w-lg" closeDisabled={remove.isPending}>
        <DialogHeader>
          <DialogTitle>{t("removeTitle", { name: activity?.name ?? "" })}</DialogTitle>
          <DialogDescription>{t("removeBody")}</DialogDescription>
        </DialogHeader>
        {preview.isLoading ? (
          <div aria-busy="true">
            <Skeleton className="h-12 w-full" />
          </div>
        ) : null}
        {preview.isError ? <Notice tone="destructive">{errorText(preview.error)}</Notice> : null}
        {plan ? (
          <div className="space-y-2 text-sm">
            <p>{t("removeReinstate", { count: plan.reinstate })}</p>
            <p>{t("removeReplacementsDeleted", { count: plan.replacementsDeleted })}</p>
            {plan.replacementsKept > 0 ? <p>{t("removeReplacementsKept", { count: plan.replacementsKept })}</p> : null}
            {plan.skippedRoomTaken.length > 0 ? (
              <div className="space-y-1">
                <p>{t("removeRoomTaken", { count: plan.skippedRoomTaken.length })}</p>
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
                <p>{t("removeTemplateMoved", { count: plan.removedTemplateMoved.length })}</p>
                <ul className="list-disc pl-5 text-xs">
                  {plan.removedTemplateMoved.map((row) => (
                    <li key={row.lessonId}>{dayText(row.date)}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {plan.relocated && plan.relocated.length > 0 ? (
              <div className="space-y-1">
                <p>{t("removeRelocated", { count: plan.relocated.length })}</p>
                <ul className="list-disc pl-5 text-xs">
                  {plan.relocated.map((row) => (
                    <li key={row.lessonId}>
                      {dayText(row.from)} → {dayText(row.to)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {plan.notReinstatable > 0 ? <p>{t("removeHistory", { count: plan.notReinstatable })}</p> : null}
            {plan.creditsDeleted > 0 ? <p>{t("removeCredits", { count: plan.creditsDeleted })}</p> : null}
            {plan.notify > 0 ? <p>{t("removeNotify", { count: plan.notify })}</p> : null}
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={remove.isPending}>
            {tCommon("cancel")}
          </Button>
          <Button variant="destructive" onClick={() => void doRemove()} disabled={!plan || remove.isPending} data-writes="DRIFT">
            {remove.isPending ? <Loader2 className="animate-spin" /> : null}
            {t("removeConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
