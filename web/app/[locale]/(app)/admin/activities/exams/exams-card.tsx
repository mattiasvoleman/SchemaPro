"use client";

/*
 * The year's prov, in the order the gateway gives them (the window's first day,
 * then the order they were entered), with where each stands:
 *
 *   Lagt     the day, the time, and for each room how many write there and who
 *            keeps watch. Only names the gateway gave are shown: a teacher with
 *            a protected identity is on no list (the gateway leaves them out),
 *            and this page builds no list of teachers of its own.
 *   Ej lagt  and, once the planner has been asked, why not: the reason of the
 *            last run, in words, with the figures it was written from.
 *
 * A laid exam cannot be changed or removed (EXAM_IS_PLANNED): it offers
 * "Ta bort planeringen" instead, which takes the activity away (its lessons
 * come back) and leaves the exam as it was entered. An exam that is not laid
 * offers Ändra and Ta bort, and a box to include it in the next run.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { Exam } from "@/lib/exam-types";
import type { AcademicYear, StudentGroup, Subject } from "@/lib/types";
import { useReadOnly } from "@/components/profile-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCard } from "@/components/ui/table-card";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ExamFormBody } from "./exam-form";
import { useErrorText, useFormats, useReasonText } from "./exam-format";
import { useExams, useRemoveExam, useUnplanExam } from "./use-exams";

/** How many classes a row spells out before it says "och N till". */
const GROUPS_SHOWN = 6;

export function ExamsCard({
  year,
  groups,
  subjects,
  picked,
  onPick,
  canPick,
}: {
  year: AcademicYear;
  groups: readonly StudentGroup[];
  subjects: readonly Subject[];
  /** The exams ticked for the next run. */
  picked: ReadonlySet<string>;
  onPick: (examId: string, on: boolean) => void;
  /** Whether a run can be asked for at all: the planner is on and the person may. */
  canPick: boolean;
}) {
  const t = useTranslations("exams");
  const tCommon = useTranslations("common");
  const readOnly = useReadOnly();
  const errorText = useErrorText();
  const reasonText = useReasonText();
  const { dayText, periodText } = useFormats();
  const exams = useExams(year.id);
  const remove = useRemoveExam();
  const unplan = useUnplanExam();
  const [changing, setChanging] = useState<Exam | null>(null);
  const [removing, setRemoving] = useState<Exam | null>(null);
  const [unplanning, setUnplanning] = useState<Exam | null>(null);
  const [changeBusy, setChangeBusy] = useState(false);

  const groupNames = (exam: Exam): string => {
    const names = exam.groups.map((group) => group.name);
    return names.length > GROUPS_SHOWN
      ? `${names.slice(0, GROUPS_SHOWN).join(", ")} ${t("andMore", { count: names.length - GROUPS_SHOWN })}`
      : names.join(", ");
  };

  const doRemove = async (exam: Exam) => {
    try {
      await remove.mutateAsync(exam.id);
      toast.success(t("removed", { name: exam.name }));
    } catch (error) {
      toast.error(errorText(error));
    }
    setRemoving(null);
  };

  const doUnplan = async (exam: Exam) => {
    try {
      await unplan.mutateAsync(exam.id);
      toast.success(t("unplanned", { name: exam.name }));
    } catch (error) {
      toast.error(errorText(error));
    }
    setUnplanning(null);
  };

  const showPick = canPick && !readOnly;

  return (
    <SectionCard id="exam-list" title={t("listTitle", { year: year.name })} description={t("listIntro")}>
      {exams.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-16 w-full" />
        </div>
      ) : exams.isError ? (
        <LoadError variant="inline" title={t("listLoadFailed")} hint={t("loadFailedHint")} />
      ) : !exams.data || exams.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("listNone")}</p>
      ) : (
        <TableCard caption={t("listCaption", { year: year.name })}>
          <TableHeader>
            <TableRow>
              {showPick ? (
                <TableHead scope="col">
                  <span className="sr-only">{t("pickColumn")}</span>
                </TableHead>
              ) : null}
              <TableHead scope="col">{t("examColumn")}</TableHead>
              <TableHead scope="col">{t("groups")}</TableHead>
              <TableHead scope="col">{t("windowColumn")}</TableHead>
              <TableHead scope="col">{t("sizeColumn")}</TableHead>
              <TableHead scope="col">{t("stateColumn")}</TableHead>
              {readOnly ? null : (
                <TableHead scope="col">
                  <span className="sr-only">{tCommon("actions")}</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {exams.data.map((exam) => (
              <TableRow key={exam.id}>
                {showPick ? (
                  <TableCell>
                    {exam.plan ? null : (
                      <input
                        type="checkbox"
                        aria-label={t("pick", { name: exam.name })}
                        checked={picked.has(exam.id)}
                        onChange={(event) => onPick(exam.id, event.target.checked)}
                      />
                    )}
                  </TableCell>
                ) : null}
                <TableCell className="font-medium">
                  {exam.name}
                  <span className="block text-xs font-normal text-muted-foreground">{exam.subjectName}</span>
                </TableCell>
                <TableCell>{groupNames(exam)}</TableCell>
                <TableCell className="tabular-nums">
                  {exam.windowKind === "FIXED" ? (
                    <>
                      {dayText(exam.windowFrom)}
                      <span className="block text-xs text-muted-foreground">
                        {t("fixedAt", { start: exam.fixedStart ?? "" })}
                      </span>
                    </>
                  ) : (
                    <>
                      {periodText(exam.windowFrom, exam.windowTo)}
                      {exam.earliestStart || exam.latestEnd ? (
                        <span className="block text-xs text-muted-foreground">
                          {[
                            exam.earliestStart ? t("earliestAt", { time: exam.earliestStart }) : null,
                            exam.latestEnd ? t("latestAt", { time: exam.latestEnd }) : null,
                          ]
                            .filter(Boolean)
                            .join(", ")}
                        </span>
                      ) : null}
                    </>
                  )}
                </TableCell>
                <TableCell className="tabular-nums">
                  {t("lengthMinutes", { minutes: exam.lengthMinutes })}
                  <span className="block text-xs text-muted-foreground">{t("writersCount", { count: exam.writers })}</span>
                </TableCell>
                <TableCell>
                  {exam.plan ? (
                    <div className="space-y-1">
                      <Badge variant="success">{t("statePlaced")}</Badge>
                      <p className="tabular-nums">{t("placedAt", { date: dayText(exam.plan.date), start: exam.plan.start, end: exam.plan.end })}</p>
                      <ul className="space-y-0.5 text-xs text-muted-foreground">
                        {exam.plan.sittings.map((sitting) => (
                          <li key={sitting.roomId}>
                            {t("sitting", { room: sitting.roomName, writers: sitting.writers })}
                            {sitting.invigilators.length > 0
                              ? ` ${t("invigilators", { names: sitting.invigilators.map((one) => one.name).join(", ") })}`
                              : ""}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <Badge variant="outline">{t("stateNotPlaced")}</Badge>
                      <p className="max-w-xs text-xs text-muted-foreground">
                        {exam.lastReason
                          ? reasonText(exam.lastReason.code, exam.lastReason.params)
                          : t("notPlannedYet")}
                      </p>
                    </div>
                  )}
                </TableCell>
                {readOnly ? null : (
                  <TableCell className="text-right">
                    <div className="flex flex-wrap justify-end gap-2">
                      {exam.plan ? (
                        <Button
                          variant="outline"
                          size="sm"
                          data-writes="DRIFT"
                          aria-label={tCommon("actionNamed", { action: t("unplan"), name: exam.name })}
                          onClick={() => setUnplanning(exam)}
                        >
                          {t("unplan")}
                        </Button>
                      ) : (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            data-writes="DRIFT"
                            aria-label={tCommon("actionNamed", { action: t("change"), name: exam.name })}
                            // The form leaves out a class the year no longer holds, so it waits for the year's groups.
                            disabled={groups.length === 0}
                            onClick={() => setChanging(exam)}
                          >
                            {t("change")}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            data-writes="DRIFT"
                            aria-label={tCommon("actionNamed", { action: tCommon("delete"), name: exam.name })}
                            onClick={() => setRemoving(exam)}
                          >
                            {tCommon("delete")}
                          </Button>
                        </>
                      )}
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </TableCard>
      )}

      <Dialog
        open={changing !== null}
        onOpenChange={(open) => {
          if (!open && !changeBusy) setChanging(null);
        }}
      >
        <DialogContent
          className="max-w-3xl"
          closeDisabled={changeBusy}
          onEscapeKeyDown={(event) => {
            if (changeBusy) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (changeBusy) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("changeTitle", { name: changing?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("changeBody")}</DialogDescription>
          </DialogHeader>
          {changing ? (
            <ExamFormBody
              key={changing.id}
              year={year}
              groups={groups}
              subjects={subjects}
              exam={changing}
              idPrefix="exam-change"
              onDone={() => setChanging(null)}
              onCancel={() => setChanging(null)}
              onBusyChange={setChangeBusy}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open && !remove.isPending) setRemoving(null);
        }}
        title={t("removeTitle", { name: removing?.name ?? "" })}
        description={t("removeBody")}
        confirmLabel={tCommon("delete")}
        loading={remove.isPending}
        onConfirm={() => removing && void doRemove(removing)}
      />
      <ConfirmDialog
        open={unplanning !== null}
        onOpenChange={(open) => {
          if (!open && !unplan.isPending) setUnplanning(null);
        }}
        title={t("unplanTitle", { name: unplanning?.name ?? "" })}
        description={t("unplanBody")}
        confirmLabel={t("unplan")}
        loading={unplan.isPending}
        onConfirm={() => unplanning && void doUnplan(unplanning)}
      />
    </SectionCard>
  );
}
