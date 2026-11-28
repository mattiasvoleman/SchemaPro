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

import { useCallback, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
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
  const summary = useRef<HTMLElement>(null);
  const t = useTranslations("timetable");
  const tDays = useTranslations("days");
  const locale = useLocale();
  const [walking, setWalking] = useState(false);
  const clock = new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "sv-SE", { timeStyle: "short" });

  const { done, undone, lost = 0 } = history.steps();
  // Oldest first, as the steps were taken: the ones done, then the ones undone in the order a redo takes them.
  const lines: Line[] = [
    ...done.map((entry, index) => ({ entry, position: index + 1, undone: false })),
    ...undone.map((entry, index) => ({ entry, position: done.length + index + 1, undone: true })),
  ];

  const lessonName = useCallback(
    (lesson: HistoryLesson) => [subjectById.get(lesson.subjectId)?.name ?? "?", groupLabel({ studentGroupId: lesson.studentGroupId, extraGroupIds: [...(lesson.extraGroupIds ?? [])] }) || "?"].join(" "),
    [subjectById, groupLabel],
  );

  /**
   * What a patch did to a lesson, in the words of the page: "flyttad till tisdag 10:00–11:00, sal A12, låst". Only what differs from the lesson as it stood:
   * a save of the edit dialog carries every field of the dialog (page.tsx doSaveEdit), and the ones the reader did not touch are restated, not changed,
   * so that a room change would otherwise read "flyttad till …, låst, andra veckor". A field the step does not know the old value of counts as changed.
   */
  const changesOf = useCallback(
    (lesson: HistoryLesson, patch: Record<string, unknown>): string[] => {
      const was: Record<string, unknown> = { ...lesson };
      const changed = (field: string) => was[field] === undefined || (/Time$/.test(field) ? String(patch[field]).slice(0, 5) !== String(was[field]).slice(0, 5) : patch[field] !== was[field]);
      const parts: string[] = [];
      if (["dayOfWeek", "startTime", "endTime"].some((field) => field in patch && changed(field))) {
        const day = Number(patch["dayOfWeek"] ?? lesson.dayOfWeek ?? 1);
        const start = String(patch["startTime"] ?? lesson.startTime ?? "").slice(0, 5);
        const end = String(patch["endTime"] ?? lesson.endTime ?? "").slice(0, 5);
        // A weekday is written in lower case in the middle of a Swedish sentence ("flyttad till tisdag"), and with a capital in English.
        const name = tDays(String(day));
        parts.push(t("historyMoved", { slot: `${locale === "sv" ? name.toLocaleLowerCase("sv") : name} ${start}–${end}` }));
      }
      if ("roomId" in patch && changed("roomId")) parts.push(patch["roomId"] ? t("historyRoom", { room: roomById.get(String(patch["roomId"]))?.name ?? "?" }) : t("historyNoRoom"));
      if ("teacherId" in patch && changed("teacherId")) {
        const teacher = patch["teacherId"] ? teacherById.get(String(patch["teacherId"])) : undefined;
        parts.push(patch["teacherId"] ? t("historyTeacher", { teacher: teacher ? `${teacher.firstName[0]}. ${teacher.lastName}` : "?" }) : t("historyNoTeacher"));
      }
      if ("isLocked" in patch && changed("isLocked")) parts.push(t(patch["isLocked"] ? "historyLocked" : "historyUnlocked"));
      if ("isParked" in patch && changed("isParked")) parts.push(t(patch["isParked"] ? "historyParked" : "historyPlaced"));
      if (["recurrence", "startDate", "endDate"].some((field) => field in patch && changed(field))) parts.push(t("historyWeeks"));
      return parts;
    },
    [t, tDays, locale, roomById, teacherById],
  );

  const describe = (entry: HistoryEntry): string => {
    const meta = entry.meta;
    if (!meta) return entry.label === "lunch" ? t("historyLunch") : t("historyOther");
    /** "tisdag 10:00–11:00": a weekday is written in lower case in the middle of a Swedish sentence, and with a capital in English. */
    const slotOf = (day: number, start: string, end?: string) => {
      const name = tDays(String(day));
      return `${locale === "sv" ? name.toLocaleLowerCase("sv") : name} ${start}${end ? `–${end}` : ""}`;
    };
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
      case "block-move":
        return t("historyBlockMove", { name: meta.name, slot: slotOf(meta.dayOfWeek, meta.startTime, meta.endTime) });
      case "block-lock":
        return t(meta.locked ? "historyBlockLock" : "historyBlockUnlock", { name: meta.name });
      case "lunch":
        return t(meta.kind === "place" ? "historyLunchPlace" : meta.kind === "move" ? "historyLunchMove" : "historyLunchRemove", { slot: slotOf(meta.dayOfWeek, meta.startTime) });
    }
  };

  /**
   * Walks to `target`: the number of steps that are to be done. One undo or redo at a time, each through the gateway; the first that cannot be taken
   * stops the walk and is said (showError), and the steps already taken stand. A walk that is asked for while one is on its way is not started.
   * A walk that gets there is said as the toolbar's Ångra says it (a toast, which a screen reader reads), and the focus, which the button that was pressed
   * has lost by turning into "Nu", goes to the heading of the list.
   */
  const walkTo = async (target: number) => {
    if (walking) return;
    setWalking(true);
    let reached = false;
    try {
      for (;;) {
        const now = history.steps().done.length;
        if (now === target) {
          reached = true;
          break;
        }
        const moved = await (now > target ? history.undo() : history.redo());
        // The history is busy or has nothing more to give: there is nowhere further to walk.
        if (moved === null) break;
      }
    } catch (error) {
      showError(error);
    } finally {
      setWalking(false);
    }
    if (!reached) return;
    toast.info(target === 0 ? t("historyWalkedStart") : t(lines[target - 1]!.undone ? "historyWalkedForward" : "historyWalkedBack", { step: describe(lines[target - 1]!.entry) }));
    summary.current?.focus();
  };

  const newest = lines.filter((line) => !line.undone).length;
  return (
    /* Closed until it is wanted: the dialog is for saving and restoring versions, and the session's steps are a second thing it keeps. */
    <details className="rounded-md border p-3 [&[open]>summary]:mb-2">
      <summary ref={summary} className="flex cursor-pointer items-center gap-1.5 text-sm font-semibold">
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
          {/* The start: the schedule as it was when the page was opened, which is all the steps undone. Not when a step has left the list without being undone
              (the oldest past the depth the history keeps, one that could not be undone for good): what it did stands, and the row says it is as far back as the list goes. */}
          <li className="flex items-center justify-between gap-2 rounded px-2 py-1">
            <span className="text-muted-foreground">{t(lost > 0 ? "historyStartCut" : "historyStart")}</span>
            {newest === 0 ? (
              <span className="shrink-0 text-muted-foreground">{t("historyNow")}</span>
            ) : (
              <Button size="sm" variant="ghost" disabled={walking} onClick={() => void walkTo(0)} data-writes="SCHEMALAGGNING" aria-label={t("historyBackNamed", { step: t(lost > 0 ? "historyStartCut" : "historyStart") })}>
                {t("historyBack")}
              </Button>
            )}
          </li>
        </ol>
      )}
    </details>
  );
}
