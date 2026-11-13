"use client";

import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Eraser, Undo2 } from "lucide-react";
import { coverErrorText } from "@/lib/cover-view";
import type { LessonMoveEntry } from "@/lib/lesson-moves";
import { useLessonMoves, useUndoMove } from "@/lib/lesson-moves-queries";
import { useLessonAttendance, useReportAttendance } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";
import { MovePupilDialog } from "./move-pupil-dialog";

/**
 * The pupils a lesson lost to a parallel lesson for the day, and the ones it
 * gained, on its register: the source's list shows the pupil as moved, not
 * as absent, and says where to; the target's says where from. Ångra is for
 * whoever may move the pupil (the gateway decides, and says so if not).
 * Also holds the dialog the register's "Flytta elev" opens.
 *
 * A pupil who has a mark on the lesson they were moved to cannot be moved
 * back (LM415), and the register offers no way to take a mark away: its four
 * buttons are the four marks. "Rensa markering" on the arrival's row is that
 * way, for whoever may save this register (the gateway decides, as it does
 * for any mark): it saves UNKNOWN, the value that is no mark, and that is what
 * lets the move be undone.
 */
export function LessonMovesSection({
  lessonId,
  moving,
  onMovingChange,
  onMarkCleared,
}: {
  lessonId: string;
  moving: boolean;
  onMovingChange: (open: boolean) => void;
  /** The register page forgets what the teacher had chosen for the pupil, which a later save would put back. */
  onMarkCleared?: (studentId: string) => void;
}) {
  const t = useTranslations("lessonMoves");
  const tErrors = useTranslations("lessonMoves.errors");
  const tCommon = useTranslations("common");
  const moves = useLessonMoves(lessonId);
  const undo = useUndoMove();
  // The register already reads this (same query key); what is asked here is which pupils hold a mark.
  const attendance = useLessonAttendance(lessonId);
  const clear = useReportAttendance();
  const marked = new Set((attendance.data ?? []).filter((record) => record.status !== "UNKNOWN").map((record) => record.studentId));
  const departures = moves.data?.departures ?? [];
  const arrivals = moves.data?.arrivals ?? [];

  const take = async (entry: LessonMoveEntry) => {
    try {
      await undo.mutateAsync(entry.moveId);
      toast.success(t("undone"));
    } catch (error) {
      toast.error(coverErrorText(tErrors, error, tCommon("error")));
    }
  };

  const clearMark = async (entry: LessonMoveEntry) => {
    try {
      await clear.mutateAsync({ calendarLessonId: lessonId, records: [{ studentId: entry.studentId, status: "UNKNOWN" }] });
      onMarkCleared?.(entry.studentId);
      toast.success(t("markCleared", { name: entry.studentName }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  return (
    <>
      <MovePupilDialog lessonId={lessonId} open={moving} onOpenChange={onMovingChange} />
      {departures.length + arrivals.length > 0 ? (
        <SectionCard id="lesson-moves" title={t("sectionTitle")} description={t("sectionDescription")}>
          <ul className="divide-y">
            {departures.map((entry) => (
              <MoveRow key={entry.moveId} entry={entry} kind="departure" onUndo={() => void take(entry)} pending={undo.isPending} />
            ))}
            {arrivals.map((entry) => (
              <MoveRow
                key={entry.moveId}
                entry={entry}
                kind="arrival"
                onUndo={() => void take(entry)}
                pending={undo.isPending}
                onClearMark={marked.has(entry.studentId) ? () => void clearMark(entry) : undefined}
                clearing={clear.isPending}
              />
            ))}
          </ul>
        </SectionCard>
      ) : null}
    </>
  );
}

function MoveRow({
  entry,
  kind,
  onUndo,
  pending,
  onClearMark,
  clearing,
}: {
  entry: LessonMoveEntry;
  kind: "departure" | "arrival";
  onUndo: () => void;
  pending: boolean;
  /** Only for an arrival that holds a mark on this lesson. */
  onClearMark?: () => void;
  clearing?: boolean;
}) {
  const t = useTranslations("lessonMoves");
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0">
        <p className="font-medium">{entry.studentName}</p>
        <p className="text-sm text-muted-foreground">
          {t(kind === "departure" ? "departure" : "arrival", {
            subject: entry.other.subject,
            className: entry.other.className,
            start: entry.other.start,
            end: entry.other.end,
          })}
          {entry.movedByName ? ` · ${t("movedBy", { name: entry.movedByName })}` : ""}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {onClearMark ? (
          <Button variant="outline" size="sm" data-writes="DRIFT" disabled={clearing} onClick={onClearMark}>
            <Eraser aria-hidden="true" />
            {t("clearMark")}
          </Button>
        ) : null}
        <Button variant="outline" size="sm" data-writes="DRIFT" disabled={pending} onClick={onUndo}>
          <Undo2 aria-hidden="true" />
          {t("undo")}
        </Button>
      </div>
    </li>
  );
}
