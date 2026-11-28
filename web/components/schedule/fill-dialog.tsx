"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";
import { apiErrorText } from "@/lib/api-error-text";
import { applyFill, clockOf, FILL_LEFT_REASONS, fillFailureOf, fillFigures, proposeFill, type FillProposal, type FillRequest, type FillScope } from "@/lib/board-fill";
import { fetchTray } from "@/lib/board-tray";
import { fillPreview } from "@/lib/fill-store";

/*
 * LÄGG DET SOM GÅR (E7a): the dialog that asks the gateway to lay the bricks of Att lägga, and takes the answer in.
 *
 * What is asked: a class, a year or the school. What comes back is a PROPOSAL: how many of the bricks fitted ("Lade 31 av 36. Ingenting annat flyttades."),
 * which did not and why, and the lessons themselves as dashed outlines on the board (components/schedule/fill-layer.tsx), which the dialog does not cover:
 * it is not modal, and sits in the corner. Nothing is written until "Ta in i schemat", which saves a version first and writes every lesson in one
 * transaction, locked; "Kasta" leaves the schedule as it was.
 *
 * Who answered is said, and what that is worth: the fill proves nothing. A brick it did not lay is "not laid by this", never "cannot be laid": that word
 * is the engine's when it has proved it. The dialog decides nothing, it says what the gateway answered.
 */

const TRAY_KEY = "boardTray";

export interface FillDialogProps {
  open: boolean;
  onClose: () => void;
  yearId: string;
  /** When the page last read the grundschema's lessons: the tray is read again with it. */
  revision: number;
  groupById: ReadonlyMap<string, { name: string; gradeLevel?: number | null }>;
  subjectById: ReadonlyMap<string, { name: string }>;
  /**
   * The question before a change in Direkt that reaches families (P5, beslut 8; lib/use-direct-reach-ask.tsx `ask`): laying a lesson back from the
   * parking moves published lessons, and the gateway refuses it until the school has answered. Left out, Ta in is run as it is.
   */
  guard?: <T>(run: () => Promise<T>) => Promise<T>;
  /** Whether an error of `guard` is the reader's no to its question (Avbryt): not a failure, and nothing is said. */
  declined?: (error: unknown) => boolean;
  /**
   * Called when Ta in has written. The page lets go of the undo steps it holds (as after a swap or a room optimisation): lessons laid back from the parking are
   * lessons a step holds a snapshot of, and replaying the step would put one back where it stood before the fill, with no word of it.
   */
  onApplied?: () => void;
}

const REASONS = [...FILL_LEFT_REASONS, "OTHER"] as const;

export function FillDialog({ open, onClose, yearId, revision, groupById, subjectById, guard, declined, onApplied }: FillDialogProps) {
  const t = useTranslations("fillDialog");
  const tDays = useTranslations("days");
  const tCommon = useTranslations("common");
  const queryClient = useQueryClient();
  const tTray = useTranslations("boardTray");
  const { data: tray, isLoading: trayLoading, isError: trayFailed, refetch: readTrayAgain } = useQuery({ queryKey: [TRAY_KEY, yearId, revision], queryFn: () => fetchTray(yearId), staleTime: 30_000, enabled: open, placeholderData: (previous) => previous });

  const [scope, setScope] = useState<FillScope>("CLASS");
  const [classId, setClassId] = useState("");
  const [grade, setGrade] = useState("");
  const [phase, setPhase] = useState<"idle" | "asking" | "taking">("idle");
  const [proposal, setProposal] = useState<FillProposal | null>(null);
  const [error, setError] = useState<{ text: string; stale: boolean } | null>(null);
  const asking = useRef<AbortController | null>(null);

  // The classes that have a brick left, and the years they are in, with their counts: what the gateway counts for each, read from the tray.
  const classes = useMemo(
    () =>
      (tray?.groups ?? [])
        .filter((group) => group.left > 0)
        .map((group) => ({ id: group.studentGroupId, name: groupById.get(group.studentGroupId)?.name ?? "", left: group.left, grade: groupById.get(group.studentGroupId)?.gradeLevel ?? null }))
        .sort((a, b) => a.name.localeCompare(b.name, "sv")),
    [tray, groupById],
  );
  const grades = useMemo(() => {
    const byGrade = new Map<number, number>();
    for (const entry of classes) if (entry.grade !== null) byGrade.set(entry.grade, (byGrade.get(entry.grade) ?? 0) + entry.left);
    return [...byGrade].sort((a, b) => a[0] - b[0]);
  }, [classes]);
  const chosenClass = classes.some((entry) => entry.id === classId) ? classId : (classes[0]?.id ?? "");
  const chosenGrade = grades.some(([value]) => String(value) === grade) ? grade : String(grades[0]?.[0] ?? "");
  const left = tray?.tally.left ?? 0;

  // Whatever is drawn on the board goes when the dialog does, and a request still on its way is let go.
  useEffect(
    () => () => {
      fillPreview.set(null);
      asking.current?.abort();
    },
    [],
  );

  const labelOf = (subjectId: string, groupId: string) => `${subjectById.get(subjectId)?.name ?? ""} ${groupById.get(groupId)?.name ?? ""}`.trim();

  const request = (): FillRequest | null => {
    if (scope === "CLASS") return chosenClass === "" ? null : { academicYearId: yearId, scope, studentGroupId: chosenClass };
    if (scope === "GRADE") return chosenGrade === "" ? null : { academicYearId: yearId, scope, gradeLevel: Number(chosenGrade) };
    return { academicYearId: yearId, scope };
  };

  const show = (next: FillProposal | null) => {
    setProposal(next);
    fillPreview.set(
      next ? { proposal: next, labels: new Map([...next.placed, ...next.left].map((entry) => [entry.key, labelOf(entry.subjectId, entry.studentGroupId)])) } : null,
    );
  };

  const propose = async () => {
    const body = request();
    if (body === null || phase !== "idle") return;
    asking.current?.abort();
    const controller = new AbortController();
    asking.current = controller;
    setPhase("asking");
    setError(null);
    show(null);
    try {
      const answer = await proposeFill(body, controller.signal);
      if (controller.signal.aborted) return;
      if (answer === null) setError({ text: t("errors.proposeFailed"), stale: false });
      else show(answer);
    } catch (failure) {
      if (!controller.signal.aborted) setError({ text: apiErrorText(failure, tCommon), stale: false });
    } finally {
      if (!controller.signal.aborted) setPhase("idle");
    }
  };

  const discard = () => {
    asking.current?.abort();
    show(null);
    setError(null);
    setPhase("idle");
  };

  /** What a refused or unanswered write leaves stale: the tray and the lessons the board draws. */
  const readBoardAgain = () => {
    for (const key of [TRAY_KEY, "masterLessons", "calendarLessons", "teacherLessons", "scheduleVersions"]) void queryClient.invalidateQueries({ queryKey: [key] });
  };

  const take = async () => {
    if (!proposal || phase !== "idle") return;
    setPhase("taking");
    setError(null);
    try {
      const answer = await (guard ? guard(() => applyFill(proposal)) : applyFill(proposal));
      toast.success(t("taken", { count: answer.laid.length }));
      for (const key of [TRAY_KEY, "masterLessons", "calendarLessons", "teacherLessons", "scheduleVersions"]) void queryClient.invalidateQueries({ queryKey: [key] });
      show(null);
      onApplied?.();
      onClose();
    } catch (failure) {
      // The reader said no to the question before a change in Direkt: the proposal stands as it was, and nothing is said.
      if (declined?.(failure)) return;
      const found = fillFailureOf(failure);
      if (found.kind === "UNKNOWN") {
        // No answer: what was written, if anything, is on the board, and the proposal is no picture of it. The board is read again, and the reader asks again.
        show(null);
        readBoardAgain();
        setError({ text: t("errors.unknown"), stale: true });
      } else if (found.kind === "STALE" || found.kind === "REFUSED") {
        // The schedule is not the one the proposal was made on: the board is read again too, or the next proposal is drawn over lessons it does not show.
        show(null);
        readBoardAgain();
        setError({ text: found.kind === "STALE" ? t("errors.stale") : t("errors.refused"), stale: true });
      } else {
        setError({ text: apiErrorText(failure, tCommon), stale: false });
      }
    } finally {
      setPhase("idle");
    }
  };

  const figures = proposal ? fillFigures(proposal) : null;
  const reasonCounts = figures ? REASONS.flatMap((reason) => (figures.byReason[reason] ? [[reason, figures.byReason[reason]!] as const] : [])) : [];

  return (
    // While Ta in is on its way the dialog stays (Escape, the X): closing it would not take the write back, and a failure would be said to nobody.
    <Dialog open={open} modal={false} onOpenChange={(next) => (next || phase === "taking" ? undefined : (discard(), onClose()))}>
      <DialogContent
        className="bottom-4 left-4 right-4 top-auto w-auto max-w-none translate-x-0 translate-y-0 sm:left-auto sm:w-96"
        closeDisabled={phase === "taking"}
        onInteractOutside={(event) => event.preventDefault()}
        data-fill-dialog=""
      >
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {left === 0 && tray ? <p className="text-sm font-medium">{t("nothingLeft")}</p> : null}
        {trayLoading ? <p className="text-sm text-muted-foreground">{tTray("loading")}</p> : null}
        {trayFailed && !tray ? (
          <Notice tone="warning" action={<Button size="sm" variant="outline" onClick={() => void readTrayAgain()}>{tTray("retry")}</Button>}>
            {tTray("failed")}
          </Notice>
        ) : null}

        {left > 0 ? (
          <fieldset className="grid gap-1 text-sm" disabled={phase !== "idle"}>
            <legend className="mb-1 font-medium">{t("scopeLegend")}</legend>
            <label className="flex min-h-9 items-center gap-2">
              <input type="radio" name="fill-scope" checked={scope === "CLASS"} onChange={() => setScope("CLASS")} />
              {t("scopeClass")}
            </label>
            {scope === "CLASS" ? (
              <NativeSelect aria-label={t("classLabel")} className="ml-6 h-11 w-auto" value={chosenClass} onChange={(event) => setClassId(event.target.value)}>
                {classes.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {t("classOption", { name: entry.name, count: entry.left })}
                  </option>
                ))}
              </NativeSelect>
            ) : null}
            {grades.length > 0 ? (
              <label className="flex min-h-9 items-center gap-2">
                <input type="radio" name="fill-scope" checked={scope === "GRADE"} onChange={() => setScope("GRADE")} />
                {t("scopeGrade")}
              </label>
            ) : null}
            {scope === "GRADE" ? (
              <NativeSelect aria-label={t("gradeLabel")} className="ml-6 h-11 w-auto" value={chosenGrade} onChange={(event) => setGrade(event.target.value)}>
                {grades.map(([value, count]) => (
                  <option key={value} value={value}>
                    {t("gradeOption", { grade: value, count })}
                  </option>
                ))}
              </NativeSelect>
            ) : null}
            <label className="flex min-h-9 items-center gap-2">
              <input type="radio" name="fill-scope" checked={scope === "SCHOOL"} onChange={() => setScope("SCHOOL")} />
              {t("scopeSchool", { count: left })}
            </label>
            <div>
              <Button type="button" size="sm" className="min-h-11" onClick={() => void propose()} disabled={phase !== "idle" || request() === null} data-writes="SCHEMALAGGNING DRIFT">
                {phase === "asking" ? <Loader2 className="animate-spin" /> : null}
                {phase === "asking" ? t("proposing") : proposal ? t("proposeAgain") : t("propose")}
              </Button>
            </div>
          </fieldset>
        ) : null}

        <div aria-live="polite" className="grid gap-2 text-sm">
          {figures && proposal ? (
            <>
              <p role="status" className="font-medium">
                {figures.laid === 0 ? t("resultNone", { asked: figures.asked }) : t("result", { laid: figures.laid, asked: figures.asked })}
              </p>
              {figures.laid > 0 ? <p className="text-muted-foreground">{t("drawn")}</p> : null}
              {reasonCounts.length > 0 ? (
                <div>
                  <p className="font-medium">{t("leftTitle")}</p>
                  <ul className="list-disc pl-5 text-muted-foreground">
                    {reasonCounts.map(([reason, count]) => (
                      // The time ran out: a second proposal starts again from the first brick on the same schedule and runs out in the same place, so when something was laid the way on is to take it in first.
                      <li key={reason}>{t(`reasons.${reason === "TIME" && proposal.placed.length > 0 ? "TIME_TAKE_FIRST" : reason}`, { count })}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {proposal.placed.length > 0 ? (
                <details>
                  <summary className="cursor-pointer font-medium">{t("showPlaced", { count: proposal.placed.length })}</summary>
                  <ul className="mt-1 max-h-48 overflow-y-auto pl-1 text-muted-foreground">
                    {proposal.placed.map((entry) => (
                      <li key={entry.key}>
                        {t(entry.noRoom ? "placedLineNoRoom" : "placedLine", {
                          lesson: labelOf(entry.subjectId, entry.studentGroupId),
                          day: tDays(String(entry.dayOfWeek)),
                          from: clockOf(entry.startMinutes),
                          to: clockOf(entry.endMinutes),
                        })}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              <p className="text-xs text-muted-foreground">{t("answeredBy")}</p>
            </>
          ) : null}
          {error ? (
            <Notice tone="warning" role="alert">
              {error.text}
            </Notice>
          ) : null}
        </div>

        <div className="flex flex-wrap justify-end gap-2">
          {proposal && proposal.placed.length > 0 ? (
            <Button type="button" className="min-h-11" onClick={() => void take()} disabled={phase !== "idle"} data-writes="SCHEMALAGGNING DRIFT">
              {phase === "taking" ? <Loader2 className="animate-spin" /> : null}
              {phase === "taking" ? t("taking") : t("take")}
            </Button>
          ) : null}
          {proposal ? (
            <Button type="button" variant="outline" className="min-h-11" onClick={discard} disabled={phase !== "idle"}>
              {t("discard")}
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
