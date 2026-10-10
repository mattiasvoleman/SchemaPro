"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { MessageLookup } from "@/lib/engine-message";
import { useAbsenceActions } from "@/lib/cover-queries";
import type { Absence } from "@/lib/cover-types";
import { localParts } from "@/lib/cover-absence-form";
import { coverErrorText, errorCode, errorParams } from "@/lib/cover-view";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type EndProblem = "beforeStart" | "afterEnd" | "past";

/**
 * Where an end at `at` stands against the absence: an admin may end it in the
 * past ("came back yesterday", review amendment I.5) but not before it began
 * (that is a withdrawal); a teacher's own end is never before now.
 */
export function endProblem(absence: Pick<Absence, "startsAt" | "endsAt">, at: Date, mode: "ADMIN" | "TEACHER", now: Date): EndProblem | null {
  if (Number.isNaN(at.getTime())) return "afterEnd";
  if (at.getTime() >= new Date(absence.endsAt).getTime()) return "afterEnd";
  if (mode === "TEACHER" && at.getTime() < now.getTime() - 60_000) return "past";
  if (at.getTime() <= new Date(absence.startsAt).getTime()) return "beforeStart";
  return null;
}

/**
 * "Avsluta i förtid": the teacher is back from a moment on. Lessons after it
 * leave the board; a decision already made on one is undone only when the
 * admin says so (409 ABSENCE_HAS_DECISIONS → undoDecisions).
 */
export function AbsenceEndDialog({
  absence,
  mode,
  onOpenChange,
}: {
  absence: Absence | null;
  mode: "ADMIN" | "TEACHER";
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("absenceEnd");
  const tErrors = useTranslations("coverErrors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const { end } = useAbsenceActions();
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [shown, setShown] = useState(false);
  const [askUndo, setAskUndo] = useState<number | null>(null);

  useEffect(() => {
    if (!absence) return;
    const now = localParts(new Date().toISOString());
    setDate(now.date);
    setTime(now.time);
    setShown(false);
    setAskUndo(null);
  }, [absence]);

  const at = new Date(`${date}T${time || "00:00"}:00`);
  const problem = absence ? endProblem(absence, at, mode, new Date()) : null;

  const submit = async (undoDecisions = false) => {
    if (!absence) return;
    setShown(true);
    if (problem) return;
    try {
      await end.mutateAsync({ id: absence.id, at: at.toISOString(), undoDecisions });
      toast.success(t("done"));
      setAskUndo(null);
      onOpenChange(false);
    } catch (error) {
      if (errorCode(error) === "ABSENCE_HAS_DECISIONS" && !undoDecisions) {
        // Only an admin undoes decisions (the gateway ignores the flag from a
        // teacher), so a teacher is told whom to ask instead of being asked.
        if (mode === "TEACHER") {
          toast.error(t("teacherHasDecisions"));
          return;
        }
        const count = errorParams(error).count;
        setAskUndo(typeof count === "number" ? count : 1);
        return;
      }
      toast.error(coverErrorText(tErrors, error, tCommon("error")));
    }
  };

  return (
    <>
      <Dialog open={absence !== null} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{t("body")}</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="absence-end-date">{t("date")}</Label>
              <DateField id="absence-end-date" label={t("date")} value={date} onChange={setDate} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="absence-end-time">{t("time")}</Label>
              <Input id="absence-end-time" type="time" value={time} onChange={(event) => setTime(event.target.value)} />
            </div>
          </div>
          {shown && problem ? (
            <p role="alert" className="text-sm text-destructive">
              {t(`errors.${problem}`)}
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={end.isPending}>
              {tCommon("cancel")}
            </Button>
            <Button onClick={() => void submit()} disabled={end.isPending}>
              {end.isPending ? <Loader2 className="animate-spin" /> : null}
              {t("confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={askUndo !== null}
        onOpenChange={(next) => !next && setAskUndo(null)}
        title={t("undoTitle")}
        description={t("undoBody", { count: askUndo ?? 0 })}
        confirmLabel={t("undoConfirm")}
        loading={end.isPending}
        onConfirm={() => void submit(true)}
      />
    </>
  );
}

/**
 * "Återkalla": registered by mistake. A confirmation first; when decisions
 * already sit on its lessons, a second question undoes them
 * (ABSENCE_HAS_DECISIONS → undoDecisions). One on a lesson that has been held
 * cannot be undone — the gateway says to end the absence instead.
 */
export function AbsenceWithdrawDialog({
  absence,
  mode = "ADMIN",
  onOpenChange,
}: {
  absence: Absence | null;
  mode?: "ADMIN" | "TEACHER";
  onOpenChange: (open: boolean) => void;
}) {
  const tWithdraw = useTranslations("absenceWithdraw");
  const tErrors = useTranslations("coverErrors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const { withdraw } = useAbsenceActions();
  const [askUndo, setAskUndo] = useState<number | null>(null);

  useEffect(() => setAskUndo(null), [absence]);

  const submit = async (undoDecisions = false) => {
    if (!absence) return;
    try {
      await withdraw.mutateAsync({ id: absence.id, undoDecisions });
      toast.success(tWithdraw("done"));
      setAskUndo(null);
      onOpenChange(false);
    } catch (error) {
      if (errorCode(error) === "ABSENCE_HAS_DECISIONS" && !undoDecisions) {
        if (mode === "TEACHER") {
          toast.error(tWithdraw("teacherHasDecisions"));
          onOpenChange(false);
          return;
        }
        const count = errorParams(error).count;
        setAskUndo(typeof count === "number" ? count : 1);
        return;
      }
      toast.error(coverErrorText(tErrors, error, tCommon("error")));
    }
  };

  return (
    <ConfirmDialog
      open={absence !== null}
      onOpenChange={onOpenChange}
      title={askUndo === null ? tWithdraw("title") : tWithdraw("undoTitle")}
      description={askUndo === null ? tWithdraw("body") : tWithdraw("undoBody", { count: askUndo })}
      confirmLabel={askUndo === null ? tWithdraw("confirm") : tWithdraw("undoConfirm")}
      loading={withdraw.isPending}
      onConfirm={() => void submit(askUndo !== null)}
    />
  );
}
