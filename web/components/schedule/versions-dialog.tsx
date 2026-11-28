"use client";

/*
 * The timetable's Versioner dialog: save the grundschema under a name, rename
 * one, restore one (after being asked), and compare one with what is on screen
 * or with another version, class by class, a lesson that moved shown as moved
 * (lib/version-diff.ts).
 *
 * Lifted out of app/[locale]/(app)/admin/timetable/page.tsx and fetched the
 * first time Versioner is pressed, for the same reason as the room
 * optimisation dialog beside it: the page carries the most JavaScript in the
 * app, and this is a part of it a school opens a few times a term. The diff
 * — its key, its counting and its line — is most of the code, and nothing on
 * the grid needs it. The page keeps what it shares with the grid (the maps,
 * the group label, the undo stack) and passes them in.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { GitCompareArrows, Loader2, Pencil, Trash2 } from "lucide-react";
import { useScheduleVersionActions, useScheduleVersionDetail, useScheduleVersions } from "@/lib/queries";
import { ApiError } from "@/lib/api";
import { classOf, countsOf, diffLessons, KIND_ORDER, type Aspect, type DiffEntry, type DiffLesson } from "@/lib/version-diff";
import type { LessonRecurrence, MasterLesson, Person, Room, Subject } from "@/lib/types";
import { recurrenceBadge } from "@/components/schedule/recurrence-badge";
import { HistoryList } from "@/components/schedule/history-list";
import type { ScheduleHistory } from "@/lib/use-schedule-history";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
// Both already on the timetable page itself, so this chunk adds no copy.
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** Normalizes DB time values ("HH:MM:SS") to input-friendly "HH:MM". */
function toHHMM(time: string): string {
  return time.slice(0, 5);
}

/**
 * Whether a lesson is on the tray. A snapshot stored before the gateway
 * carried the flag has no key, read as false: restore gives an absent key the
 * same reading, so a diff against such a snapshot still says what restoring it
 * would do.
 */
function isOnTray(lesson: { isParked?: boolean }): boolean {
  return lesson.isParked ?? false;
}

/**
 * Which weeks a lesson runs. A snapshot stored before the gateway carried it
 * has no key, and restore writes ALL_WEEKS for that — so the diff reads it so.
 */
function weeksOf(lesson: { recurrence?: LessonRecurrence }): LessonRecurrence {
  return lesson.recurrence ?? "ALL_WEEKS";
}

/**
 * One end of a lesson's date window, read the way restore reads it: the first
 * ten characters, and null for an absent or empty value. Both sides send
 * YYYY-MM-DD, but restore takes a full timestamp too, and the diff must not
 * call a snapshot different for how it spelled a date restore reads the same.
 */
function dayOf(value: string | null | undefined): string | null {
  return value ? value.slice(0, 10) : null;
}

export interface VersionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The year whose grundschema is saved, listed and compared. */
  academicYearId: string | null;
  /** The grundschema on screen, which a version is compared with. */
  lessons: MasterLesson[] | undefined;
  subjectById: ReadonlyMap<string, Subject>;
  teacherById: ReadonlyMap<string, Person>;
  roomById: ReadonlyMap<string, Room>;
  /** Everyone, pupils who have left included: a saved version still names them. */
  personById: ReadonlyMap<string, Person>;
  /** "4.2 + 4.1" — the page's own, shared with the card, the ICS and the PDF. */
  groupLabel: (lesson: Pick<MasterLesson, "studentGroupId" | "extraGroupIds">) => string;
  /** A restore replaced every lesson: the page drops its undo stack and selection. */
  onRestored: () => void;
  showError: (error: unknown) => void;
  /** The session's steps, listed with a way back to each (E9). Absent, the list is not shown. */
  history?: ScheduleHistory;
}

export function VersionsDialog({
  open,
  onOpenChange,
  academicYearId,
  lessons,
  subjectById,
  teacherById,
  roomById,
  personById,
  groupLabel,
  onRestored,
  showError,
  history,
}: VersionsDialogProps) {
  const t = useTranslations("timetable");
  const tDays = useTranslations("days");
  const locale = useLocale();
  /** When a version was saved, in the app's language — not the browser's. */
  const savedAt = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "sv-SE", {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [locale],
  );
  const [versionName, setVersionName] = useState("");
  const versionsQuery = useScheduleVersions(open ? academicYearId : null);
  const versions = versionsQuery.data;
  const versionActions = useScheduleVersionActions();
  const [comparingId, setComparingId] = useState<string | null>(null);
  /** What the version is compared with: the grid on screen, or another version. */
  const [againstId, setAgainstId] = useState<string>("live");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  /** The version whose pencil gets focus back once its field has gone (saved or let be): the field had it, and focus must not fall to the top of the dialog. */
  const [refocusId, setRefocusId] = useState<string | null>(null);
  useEffect(() => {
    if (refocusId === null) return;
    document.getElementById(`version-rename-${refocusId}`)?.focus();
    setRefocusId(null);
  }, [refocusId]);
  const stopRenaming = () => {
    setRefocusId(renamingId);
    setRenamingId(null);
  };
  /** The version a restore is asked about (E9): nothing is replaced before the reader has said yes. */
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // A comparison belongs to the läsår it was picked in. The dialog stays
  // mounted while the page switches between this year and next, and a
  // version of one diffed against the other's grid lists every lesson as
  // added or removed — so a new year drops it (reset during render, as
  // React has it for state that follows a prop). So does a rename or a
  // question that was open: the version it names is another year's.
  const [comparedYear, setComparedYear] = useState(academicYearId);
  if (comparedYear !== academicYearId) {
    setComparedYear(academicYearId);
    setComparingId(null);
    setAgainstId("live");
    setRenamingId(null);
    setConfirmingId(null);
  }
  // A version that is deleted (here or in another tab) is no longer a comparison: its detail stays in the query cache, and the dialog would go on saying
  // "changes since" a version that is gone, or beside a list that already shows the grid.
  if (versions) {
    if (comparingId !== null && !versions.some((version) => version.id === comparingId)) {
      setComparingId(null);
      setAgainstId("live");
    } else if (againstId !== "live" && !versions.some((version) => version.id === againstId)) {
      setAgainstId("live");
    }
  }
  const { data: comparing } = useScheduleVersionDetail(comparingId);
  const { data: against } = useScheduleVersionDetail(againstId === "live" ? null : againstId);
  const { data: confirming } = useScheduleVersionDetail(confirmingId);

  const doSaveVersion = async () => {
    if (!academicYearId || !versionName.trim()) return;
    try {
      await versionActions.save.mutateAsync({
        academicYearId,
        name: versionName.trim(),
      });
      setVersionName("");
      toast.success(t("versionSaved"));
    } catch (error) {
      showError(error);
    }
  };

  const doRenameVersion = async () => {
    const name = renameDraft.trim();
    if (!renamingId || !name) return;
    try {
      await versionActions.rename.mutateAsync({ id: renamingId, name });
      stopRenaming();
      toast.success(t("versionRenamed", { name }));
    } catch (error) {
      showError(error);
    }
  };

  const doRestoreVersion = async (id: string) => {
    try {
      const result = await versionActions.restore.mutateAsync(id);
      setConfirmingId(null);
      onRestored(); // full replace — the local command stack no longer applies
      toast.success(t("versionRestored", { count: result.restoredLessons }));
    } catch (error) {
      setConfirmingId(null);
      // The year's regeneration lock (Schemaförslag): a Generera, an apply of
      // a schemaförslag or another restore is rewriting the year right now.
      if (error instanceof ApiError && error.code === "SCHEDULE_BUSY") toast.error(t("versionRestoreBusy"));
      else showError(error);
    }
  };

  /** The dates a lesson runs between, when it has any: the part of its weeks that a badge cannot say. */
  const periodText = useCallback(
    (l: DiffLesson): string | null => {
      const startDate = dayOf(l.startDate);
      const endDate = dayOf(l.endDate);
      return startDate && endDate
        ? `${startDate}–${endDate}`
        : startDate
          ? t("diffFrom", { date: startDate })
          : endDate
            ? t("diffUntil", { date: endDate })
            : null;
    },
    [t],
  );

  /**
   * One line of the version diff. Every part of the diff's key shows here:
   * a part the key holds and the line leaves out turns a teacher swap into a
   * + and a − that read the same, a difference reported and then hidden.
   *
   * The pupils are counted unless `namePupils`. A list of them is too long for
   * every line, so they are named only where they are what differs.
   */
  const lessonLabel = useCallback(
    (l: DiffLesson, namePupils: boolean) => {
      const nameOf = (id: string) => {
        const teacher = teacherById.get(id);
        return teacher ? `${teacher.firstName[0]}. ${teacher.lastName}` : "?";
      };
      const startDate = dayOf(l.startDate);
      const endDate = dayOf(l.endDate);
      const period = periodText(l);
      const pupils = l.studentIds ?? [];
      const pupilNames = () =>
        pupils
          .map((id) => {
            const pupil = personById.get(id);
            return pupil ? `${pupil.firstName} ${pupil.lastName}` : "?";
          })
          .sort()
          .join(", ");
      return [
        subjectById.get(l.subjectId)?.name ?? "?",
        groupLabel({
          studentGroupId: l.studentGroupId,
          extraGroupIds: l.extraGroupIds ?? [],
        }) || "?",
        // Where a parked lesson was is not where it is: the tray is.
        isOnTray(l)
          ? t("diffOnTray")
          : `${tDays(String(l.dayOfWeek))} ${toHHMM(l.startTime)}–${toHHMM(l.endTime)}`,
        l.teacherId ? nameOf(l.teacherId) : null,
        l.coTeacherId ? t("diffCoTeacher", { name: nameOf(l.coTeacherId) }) : null,
        l.roomId ? t("diffRoom", { name: roomById.get(l.roomId)?.name ?? "?" }) : null,
        recurrenceBadge({ recurrence: weeksOf(l), startDate, endDate }, t),
        period,
        pupils.length === 0
          ? null
          : namePupils
            ? `⊕ ${pupilNames()}`
            : `⊕${pupils.length}`,
      ]
        .filter(Boolean)
        .join(" · ");
    },
    [subjectById, groupLabel, teacherById, roomById, personById, t, tDays, periodText],
  );

  /**
   * What the version says that the other side does not, by class. `from` is the version and `to` what it is compared with, so a lesson the grid has
   * and the version lacks is "added" and one the version has and the grid lacks is "removed" (the direction the dialog has always read).
   */
  const versionDiff = useMemo(() => {
    const other = againstId === "live" ? lessons : against?.lessons;
    if (!comparing || !other) return null;
    return byClass(diffLessons(comparing.lessons, other));
  }, [comparing, lessons, againstId, against]);

  /** What restoring the version would do to the grid on screen: the grid is where it starts and the version where it ends. */
  const restoreCounts = useMemo(() => (confirming && lessons ? countsOf(diffLessons(lessons, confirming.lessons)) : null), [confirming, lessons]);

  const nameOfTeacher = useCallback(
    (id: string | null | undefined) => {
      const teacher = id ? teacherById.get(id) : undefined;
      return id ? (teacher ? `${teacher.firstName[0]}. ${teacher.lastName}` : "?") : t("diffNobody");
    },
    [teacherById, t],
  );
  const slotText = useCallback((lesson: DiffLesson) => (isOnTray(lesson) ? t("diffOnTray") : `${tDays(String(lesson.dayOfWeek))} ${toHHMM(lesson.startTime)}–${toHHMM(lesson.endTime)}`), [t, tDays]);
  const roomText = useCallback((id: string | null) => (id ? (roomById.get(id)?.name ?? "?") : t("diffNoRoom")), [roomById, t]);

  /** What changed in a lesson that stands where it stood, one part at a time: "lärare: A. Ek → B. Lind". */
  const aspectText = useCallback(
    (aspect: Aspect, from: DiffLesson, to: DiffLesson): string => {
      // The badge and the dates both: "period" alone would say the same of two windows that are not the same.
      const weeks = (lesson: DiffLesson) =>
        [recurrenceBadge({ recurrence: weeksOf(lesson), startDate: dayOf(lesson.startDate), endDate: dayOf(lesson.endDate) }, t), periodText(lesson)].filter(Boolean).join(" · ") || t("diffEveryWeek");
      const pupilName = (id: string) => {
        const pupil = personById.get(id);
        return pupil ? `${pupil.firstName} ${pupil.lastName}` : "?";
      };
      const before = new Set(from.studentIds ?? []);
      const after = new Set(to.studentIds ?? []);
      switch (aspect) {
        case "teacher":
          return `${t("diffAspectTeacher")}: ${nameOfTeacher(from.teacherId)} → ${nameOfTeacher(to.teacherId)}`;
        case "coTeacher":
          return `${t("diffAspectCoTeacher")}: ${nameOfTeacher(from.coTeacherId)} → ${nameOfTeacher(to.coTeacherId)}`;
        case "room":
          return `${t("diffAspectRoom")}: ${roomText(from.roomId)} → ${roomText(to.roomId)}`;
        case "weeks":
          return `${t("diffAspectWeeks")}: ${weeks(from)} → ${weeks(to)}`;
        case "groups":
          return `${t("diffAspectGroups")}: ${groupLabel({ studentGroupId: from.studentGroupId, extraGroupIds: from.extraGroupIds ?? [] })} → ${groupLabel({ studentGroupId: to.studentGroupId, extraGroupIds: to.extraGroupIds ?? [] })}`;
        case "locked":
          return `${t("diffAspectLocked")}: ${from.isLocked ? t("diffLocked") : t("diffUnlocked")} → ${to.isLocked ? t("diffLocked") : t("diffUnlocked")}`;
        case "exempt": {
          const rules = (lesson: DiffLesson) => (lesson.exemptFrom ?? []).map((rule) => t(`exemptRule${rule}`)).join(t("exemptAnd")) || t("diffExemptNone");
          return `${t("diffAspectExempt")}: ${rules(from)} → ${rules(to)}`;
        }
        case "pupils":
          return `${t("diffAspectPupils")}: ${[...[...after].filter((id) => !before.has(id)).map((id) => `+${pupilName(id)}`), ...[...before].filter((id) => !after.has(id)).map((id) => `−${pupilName(id)}`)].sort().join(", ")}`;
      }
    },
    [t, nameOfTeacher, roomText, groupLabel, personById, periodText],
  );

  /**
   * The classes of a lesson that more than one class has, on the line that says it moved or changed: the line stands under the lesson's own class, and the other
   * classes would otherwise not know it is theirs too ("Idrott · 4.2 + 4.1"). A lesson of one class says nothing, as the heading says it.
   */
  const sharedText = useCallback(
    (lesson: DiffLesson): string[] => ((lesson.extraGroupIds ?? []).length === 0 ? [] : [groupLabel({ studentGroupId: lesson.studentGroupId, extraGroupIds: lesson.extraGroupIds ?? [] })]),
    [groupLabel],
  );

  /** One entry of the diff as a line. A lesson that moved is told once, from where to where. */
  const entryText = useCallback(
    (entry: DiffEntry): string => {
      switch (entry.kind) {
        case "added":
          return lessonLabel(entry.to, false);
        case "removed":
          return lessonLabel(entry.from, false);
        case "moved":
          return [
            subjectById.get(entry.to.subjectId)?.name ?? "?",
            ...sharedText(entry.to),
            `${slotText(entry.from)} → ${slotText(entry.to)}`,
            ...(entry.room ? [`${t("diffAspectRoom")}: ${roomText(entry.from.roomId)} → ${roomText(entry.to.roomId)}`] : []),
          ].join(" · ");
        case "changed":
          return [
            subjectById.get(entry.to.subjectId)?.name ?? "?",
            ...(entry.aspects.includes("groups") ? [] : sharedText(entry.to)),
            slotText(entry.to),
            ...entry.aspects.map((aspect) => aspectText(aspect, entry.from, entry.to)),
          ].join(" · ");
      }
    },
    [lessonLabel, subjectById, sharedText, slotText, roomText, aspectText, t],
  );

  /** The classes of a diff, in their own order ("7A" before "7B" before "8A"), each with its entries in the order moved, changed, added, removed. */
  function byClass(entries: DiffEntry[]) {
    const classes = new Map<string, DiffEntry[]>();
    for (const entry of entries) classes.set(classOf(entry), [...(classes.get(classOf(entry)) ?? []), entry]);
    return {
      total: countsOf(entries),
      classes: [...classes.entries()]
        .map(([groupId, list]) => ({
          groupId,
          label: groupLabel({ studentGroupId: groupId, extraGroupIds: [] }) || "?",
          entries: [...list].sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)),
          counts: countsOf(list),
        }))
        .sort((a, b) => a.label.localeCompare(b.label, "sv", { numeric: true })),
    };
  }

  /** "2 flyttade, 1 tillagd": the kinds that are there, in words. */
  const countsText = useCallback(
    (counts: Record<DiffEntry["kind"], number>) =>
      KIND_ORDER.filter((kind) => counts[kind] > 0)
        .map((kind) => t(`diffCount.${kind}`, { count: counts[kind] }))
        .join(", "),
    [t],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg"
        // Escape lets a rename be, and only that: Radix listens on the document before the field does, so a field's own handler cannot keep the whole dialog from closing.
        onEscapeKeyDown={(event) => {
          if (renamingId === null) return;
          event.preventDefault();
          stopRenaming();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("versionsTitle")}</DialogTitle>
          <DialogDescription>{t("versionsBody")}</DialogDescription>
        </DialogHeader>
        {history ? <HistoryList history={history} subjectById={subjectById} teacherById={teacherById} roomById={roomById} groupLabel={groupLabel} showError={showError} /> : null}
        <div className="flex gap-2" data-writes="SCHEMALAGGNING">
          {/* Named for a screen reader: the placeholder is an example, and
              it is gone as soon as a name is typed. */}
          <Input
            aria-label={t("versionNameLabel")}
            placeholder={t("versionNamePlaceholder")}
            value={versionName}
            onChange={(e) => setVersionName(e.target.value)}
          />
          <Button
            onClick={doSaveVersion}
            disabled={versionActions.save.isPending || !versionName.trim()}
          >
            {versionActions.save.isPending ? (
              <Loader2 className="animate-spin" />
            ) : (
              t("versionSave")
            )}
          </Button>
        </div>
        {/* The list's own ladder: "no versions yet" only once the list has
            answered, and a failed read said as one rather than as none. */}
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {versionsQuery.isLoading ? (
            <div aria-busy="true">
              <Skeleton className="h-16 w-full" />
            </div>
          ) : versionsQuery.isError ? (
            <Notice tone="destructive" title={t("versionsLoadFailed")}>
              {t("versionsLoadFailedHint")}
            </Notice>
          ) : (versions ?? []).length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {t("versionsEmpty")}
            </p>
          ) : (
            (versions ?? []).map((version) => (
              <div
                key={version.id}
                className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
              >
                {renamingId === version.id ? (
                  /* The name is the one thing a version lets be changed: it is a snapshot. Enter saves it and Escape lets it be. */
                  <form
                    className="flex min-w-0 flex-1 gap-1.5"
                    data-writes="SCHEMALAGGNING"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void doRenameVersion();
                    }}
                  >
                    <Input
                      autoFocus
                      aria-label={t("versionRenameLabel")}
                      maxLength={120}
                      value={renameDraft}
                      onChange={(event) => setRenameDraft(event.target.value)}
                    />
                    <Button type="submit" size="sm" disabled={versionActions.rename.isPending || !renameDraft.trim()}>
                      {versionActions.rename.isPending ? <Loader2 className="animate-spin" /> : t("versionRenameSave")}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={stopRenaming}>
                      {t("versionRenameCancel")}
                    </Button>
                  </form>
                ) : (
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">{version.name}</div>
                    <div className="text-xs tabular-nums text-muted-foreground">
                      {savedAt.format(new Date(version.createdAt))} ·{" "}
                      {t("lessonCount", { count: version.lessonCount })}
                    </div>
                  </div>
                )}
                {/* Each button names its version: a list of rows that all
                    say "Återställ" is one question asked many times. */}
                <div className="flex shrink-0 gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setComparingId(comparingId === version.id ? null : version.id);
                      setAgainstId("live");
                    }}
                    title={t("versionCompare")}
                    aria-label={t("versionCompareNamed", { name: version.name })}
                    aria-pressed={comparingId === version.id}
                  >
                    <GitCompareArrows />
                  </Button>
                  <Button
                    id={`version-rename-${version.id}`}
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setRenamingId(version.id);
                      setRenameDraft(version.name);
                    }}
                    data-writes="SCHEMALAGGNING"
                    title={t("versionRename")}
                    aria-label={t("versionRenameNamed", { name: version.name })}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setConfirmingId(version.id)}
                    disabled={versionActions.restore.isPending}
                    data-writes="SCHEMALAGGNING"
                    aria-label={t("versionRestoreNamed", { name: version.name })}
                  >
                    {t("versionRestore")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void versionActions.remove.mutateAsync(version.id)}
                    disabled={versionActions.remove.isPending}
                    data-writes="SCHEMALAGGNING"
                    title={t("versionDelete")}
                    aria-label={t("versionDeleteNamed", { name: version.name })}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>

        {comparingId ? (
          <section aria-labelledby="version-diff-title" className="space-y-2 rounded-md border p-3">
            <h3 id="version-diff-title" className="text-sm font-semibold">
              {againstId === "live"
                ? t("diffTitle", { name: comparing?.name ?? "" })
                : t("diffBetween", { from: comparing?.name ?? "", to: against?.name ?? "" })}
            </h3>
            {/* A version is compared with the grid on screen, or with another version: what was done between two Saturdays. */}
            <div className="flex items-center gap-2 text-xs">
              <label htmlFor="version-against" className="shrink-0 text-muted-foreground">
                {t("diffAgainst")}
              </label>
              <NativeSelect id="version-against" value={againstId} onChange={(event) => setAgainstId(event.target.value)}>
                <option value="live">{t("diffAgainstLive")}</option>
                {(versions ?? [])
                  .filter((version) => version.id !== comparingId)
                  .map((version) => (
                    <option key={version.id} value={version.id}>
                      {version.name} · {savedAt.format(new Date(version.createdAt))}
                    </option>
                  ))}
              </NativeSelect>
            </div>
            {!versionDiff ? (
              <p className="text-sm text-muted-foreground" aria-busy="true">
                {t("diffLoading")}
              </p>
            ) : versionDiff.classes.length === 0 ? (
              <p className="text-sm text-muted-foreground">{againstId === "live" ? t("diffIdentical") : t("diffIdenticalVersions")}</p>
            ) : (
              /* Every class on its own, and every entry in it: a list cut at eight lines hid what the reader came to see. The ↔, ~, + and −
                 are for the eye, and the word before each is for the ear. */
              <div className="space-y-3">
                <p className="text-xs font-medium text-foreground">{countsText(versionDiff.total)}</p>
                <div className="max-h-80 space-y-3 overflow-y-auto pr-1">
                  {versionDiff.classes.map((group) => (
                    <div key={group.groupId} className="space-y-1">
                      <h4 className="text-xs font-semibold text-foreground">
                        {group.label} <span className="font-normal text-muted-foreground">· {countsText(group.counts)}</span>
                      </h4>
                      <ul className="space-y-1 text-xs text-muted-foreground">
                        {group.entries.map((entry, index) => (
                          <li key={index} className="min-w-0 break-words">
                            <span aria-hidden="true">{KIND_MARK[entry.kind]} </span>
                            <span className="sr-only">{t(`diffKind.${entry.kind}`)}: </span>
                            {entryText(entry)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        ) : null}
      </DialogContent>
      {/* Restoring replaces the whole grundschema (E9): the reader is asked first, and told what changes and that a safety copy is saved. */}
      <ConfirmDialog
        open={confirmingId !== null}
        onOpenChange={(next) => {
          if (!next) setConfirmingId(null);
        }}
        title={t("versionRestoreConfirmTitle", { name: (versions ?? []).find((version) => version.id === confirmingId)?.name ?? "" })}
        description={[
          t("versionRestoreConfirmBody"),
          restoreCounts === null
            ? ""
            : countsText(restoreCounts)
              ? t("versionRestoreConfirmCounts", { counts: countsText(restoreCounts) })
              : t("versionRestoreConfirmSame"),
        ]
          .filter(Boolean)
          .join(" ")}
        confirmLabel={t("versionRestore")}
        destructive={false}
        loading={versionActions.restore.isPending}
        onConfirm={() => confirmingId && void doRestoreVersion(confirmingId)}
      />
    </Dialog>
  );
}

/** What stands before an entry of the diff. */
const KIND_MARK: Record<DiffEntry["kind"], string> = { moved: "↔", changed: "~", added: "+", removed: "−" };
