"use client";

/*
 * The session's steps as a list (E9): what the reader has done on the timetable since the page was opened, newest first, each with the clock it was taken
 * and a button that goes back to it (the steps after it are undone) or, for a step that has been undone, forward to it. The same undo and redo as the
 * toolbar's and Ctrl+Z, one step at a time through the gateway, so the judge, the audit trail and a colleague's change that makes a step impossible
 * answer as they do there; the first step that cannot be taken stops the walk and says why.
 *
 * Part of the Versioner dialog's chunk (versions-dialog.tsx), which is fetched the first time Versioner is pressed: the words for a step are here and
 * not in the page, which pushes them as data (HistoryEntry.meta).
 */

import { useCallback, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { History, Loader2 } from "lucide-react";
import type { MasterLesson, Person, Room, Subject } from "@/lib/types";
import type { HistoryEntry, HistoryLesson, ScheduleHistory } from "@/lib/use-schedule-history";
import { Button } from "@/components/ui/button";

export interface HistoryListProps {
  history: ScheduleHistory;
  subjectById: ReadonlyMap<string, Subject>;
  teacherById: ReadonlyMap<string, Person>;
  roomById: ReadonlyMap<string, Room>;
  groupLabel: (lesson: Pick<MasterLesson, "studentGroupId" | "extraGroupIds">) => string;
  showError: (error: unknown) => void;
}

/** One line of the list: a step, as it stands now. */
interface Line {
  entry: HistoryEntry;
  /** The number of steps that are done once this one is the last: where a click goes. */
  position: number;
  undone: boolean;
}

export function HistoryList({ history, subjectById, teacherById, roomById, groupLabel, showError }: HistoryListProps) {
  const t = useTranslations("timetable");
  const tDays = useTranslations("days");
  const locale = useLocale();
  const [walking, setWalking] = useState(false);
  const clock = new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "sv-SE", { timeStyle: "short" });

  const { done, undone } = history.steps();
  // Oldest first, as the steps were taken: the ones done, then the ones undone in the order a redo takes them.
  const lines: Line[] = [
    ...done.map((entry, index) => ({ entry, position: index + 1, undone: false })),
    ...undone.map((entry, index) => ({ entry, position: done.length + index + 1, undone: true })),
  ];

  const lessonName = useCallback(
    (lesson: HistoryLesson) => [subjectById.get(lesson.subjectId)?.name ?? "?", groupLabel({ studentGroupId: lesson.studentGroupId, extraGroupIds: [...(lesson.extraGroupIds ?? [])] }) || "?"].join(" "),
    [subjectById, groupLabel],
  );

  /** What a patch did to a lesson, in the words of the page: "flyttad till tisdag 10:00–11:00, sal A12, låst". */
  const changesOf = useCallback(
    (lesson: HistoryLesson, patch: Record<string, unknown>): string[] => {
      const parts: string[] = [];
      if ("dayOfWeek" in patch || "startTime" in patch || "endTime" in patch) {
        const day = Number(patch["dayOfWeek"] ?? lesson.dayOfWeek ?? 1);
        const start = String(patch["startTime"] ?? lesson.startTime ?? "").slice(0, 5);
        const end = String(patch["endTime"] ?? lesson.endTime ?? "").slice(0, 5);
        parts.push(t("historyMoved", { slot: `${tDays(String(day))} ${start}–${end}` }));
      }
      if ("roomId" in patch) parts.push(patch["roomId"] ? t("historyRoom", { room: roomById.get(String(patch["roomId"]))?.name ?? "?" }) : t("historyNoRoom"));
      if ("teacherId" in patch) {
        const teacher = patch["teacherId"] ? teacherById.get(String(patch["teacherId"])) : undefined;
        parts.push(patch["teacherId"] ? t("historyTeacher", { teacher: teacher ? `${teacher.firstName[0]}. ${teacher.lastName}` : "?" }) : t("historyNoTeacher"));
      }
      if ("isLocked" in patch) parts.push(t(patch["isLocked"] ? "historyLocked" : "historyUnlocked"));
      if ("isParked" in patch) parts.push(t(patch["isParked"] ? "historyParked" : "historyPlaced"));
      if ("recurrence" in patch || "startDate" in patch || "endDate" in patch) parts.push(t("historyWeeks"));
      return parts;
    },
    [t, tDays, roomById, teacherById],
  );

  const describe = (entry: HistoryEntry): string => {
    const meta = entry.meta;
    if (!meta) return entry.label === "lunch" ? t("historyLunch") : t("historyOther");
    switch (meta.what) {
      case "update": {
        const changes = changesOf(meta.lesson, meta.patch as Record<string, unknown>);
        return changes.length > 0 ? `${lessonName(meta.lesson)}: ${changes.join(", ")}` : lessonName(meta.lesson);
      }
      case "create":
        return t("historyCreate", { lesson: lessonName(meta.lesson) });
      case "delete":
        return t("historyDelete", { lesson: lessonName(meta.lesson) });
      case "bulk-lock":
        return t(meta.locked ? "historyBulkLock" : "historyBulkUnlock", { count: meta.count });
      case "bulk-delete":
        return t("historyBulkDelete", { count: meta.count });
    }
  };

  /**
   * Walks to `target`: the number of steps that are to be done. One undo or redo at a time, each through the gateway; the first that cannot be taken
   * stops the walk and is said (showError), and the steps already taken stand. A walk that is asked for while one is on its way is not started.
   */
  const walkTo = async (target: number) => {
    if (walking) return;
    setWalking(true);
    try {
      for (;;) {
        const now = history.steps().done.length;
        if (now === target) break;
        const moved = await (now > target ? history.undo() : history.redo());
        // The history is busy or has nothing more to give: there is nowhere further to walk.
        if (moved === null) break;
      }
    } catch (error) {
      showError(error);
    } finally {
      setWalking(false);
    }
  };

  const newest = lines.filter((line) => !line.undone).length;
  return (
    /* Closed until it is wanted: the dialog is for saving and restoring versions, and the session's steps are a second thing it keeps. */
    <details className="rounded-md border p-3 [&[open]>summary]:mb-2">
      <summary className="flex cursor-pointer items-center gap-1.5 text-sm font-semibold">
        <History className="size-4" aria-hidden="true" />
        {t("historyTitle", { count: lines.length })}
      </summary>
      <p className="mb-2 text-xs text-muted-foreground">{t("historyBody")}</p>
      {lines.length === 0 ? (
        <p className="py-1 text-xs text-muted-foreground">{t("historyEmpty")}</p>
      ) : (
        <ol className="max-h-60 space-y-1 overflow-y-auto pr-1 text-xs" aria-busy={walking}>
          {[...lines].reverse().map((line) => {
            const text = describe(line.entry);
            const isNow = line.position === newest && !line.undone;
            return (
              <li key={`${line.position}-${line.undone}`} className={`flex items-center justify-between gap-2 rounded px-2 py-1 ${line.undone ? "text-muted-foreground" : ""}`}>
                <span className="min-w-0 break-words">
                  <span className="tabular-nums text-muted-foreground">{line.entry.at ? clock.format(new Date(line.entry.at)) : ""}</span> {line.undone ? <span className="italic">{t("historyUndone")} · </span> : null}
                  {text}
                </span>
                {isNow ? (
                  <span className="shrink-0 text-muted-foreground">{t("historyNow")}</span>
                ) : (
                  <Button size="sm" variant="ghost" disabled={walking} onClick={() => void walkTo(line.position)} data-writes="SCHEMALAGGNING" aria-label={t(line.undone ? "historyForwardNamed" : "historyBackNamed", { step: text })}>
                    {walking ? <Loader2 className="animate-spin" /> : t(line.undone ? "historyForward" : "historyBack")}
                  </Button>
                )}
              </li>
            );
          })}
          {/* The start: the schedule as it was when the page was opened, which is all the steps undone. */}
          <li className="flex items-center justify-between gap-2 rounded px-2 py-1">
            <span className="text-muted-foreground">{t("historyStart")}</span>
            {newest === 0 ? (
              <span className="shrink-0 text-muted-foreground">{t("historyNow")}</span>
            ) : (
              <Button size="sm" variant="ghost" disabled={walking} onClick={() => void walkTo(0)} data-writes="SCHEMALAGGNING" aria-label={t("historyBackNamed", { step: t("historyStart") })}>
                {t("historyBack")}
              </Button>
            )}
          </li>
        </ol>
      )}
    </details>
  );
}
