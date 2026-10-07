"use client";

/*
 * The timetable's Versioner dialog: save the grundschema under a name, restore
 * one, and compare one with what is on screen.
 *
 * Lifted out of app/[locale]/(app)/admin/timetable/page.tsx and fetched the
 * first time Versioner is pressed, for the same reason as the room
 * optimisation dialog beside it: the page carries the most JavaScript in the
 * app, and this is a part of it a school opens a few times a term. The diff
 * — its key, its counting and its line — is most of the code, and nothing on
 * the grid needs it. The page keeps what it shares with the grid (the maps,
 * the group label, the undo stack) and passes them in.
 */

import { useCallback, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { GitCompareArrows, Loader2, Trash2 } from "lucide-react";
import {
  useScheduleVersionActions,
  useScheduleVersionDetail,
  useScheduleVersions,
  type VersionLesson,
} from "@/lib/queries";
import type { LessonRecurrence, MasterLesson, Person, Room, Subject } from "@/lib/types";
import { recurrenceBadge } from "@/components/schedule/recurrence-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

/** A lesson on either side of the version diff. */
type DiffLesson = VersionLesson | MasterLesson;

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
}: VersionsDialogProps) {
  const t = useTranslations("timetable");
  const tDays = useTranslations("days");
  const [versionName, setVersionName] = useState("");
  const { data: versions } = useScheduleVersions(open ? academicYearId : null);
  const versionActions = useScheduleVersionActions();
  const [comparingId, setComparingId] = useState<string | null>(null);
  const { data: comparing } = useScheduleVersionDetail(comparingId);

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

  const doRestoreVersion = async (id: string) => {
    try {
      const result = await versionActions.restore.mutateAsync(id);
      onRestored(); // full replace — the local command stack no longer applies
      toast.success(t("versionRestored", { count: result.restoredLessons }));
    } catch (error) {
      showError(error);
    }
  };

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
      const period =
        startDate && endDate
          ? `${startDate}–${endDate}`
          : startDate
            ? t("diffFrom", { date: startDate })
            : endDate
              ? t("diffUntil", { date: endDate })
              : null;
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
    [subjectById, groupLabel, teacherById, roomById, personById, t, tDays],
  );

  const versionDiff = useMemo(() => {
    if (!comparing || !lessons) return null;
    // A slot is part of a lesson's identity only on the grid. On the tray it
    // is a memory, so two versions whose parked lessons remember different
    // hours hold the same timetable — while a lesson parked in one and placed
    // at its remembered hour in the other is a change, the one a restore makes.
    //
    // Everything else a restore writes that says who is in the room, and in
    // which weeks, is in the key too, each read the way restore reads a key
    // the snapshot lacks. Without them a lesson moved to odd weeks, or cut to
    // half a term, came out identical to a snapshot that restoring would
    // change. The classes and pupils are sets, so they are compared sorted.
    // `pupils` false leaves the pupils out, to find pairs differing in nothing
    // else.
    const key = (l: DiffLesson, pupils = true) =>
      [
        l.subjectId,
        l.studentGroupId,
        l.teacherId ?? "",
        l.coTeacherId ?? "",
        l.roomId ?? "",
        ...(isOnTray(l)
          ? ["tray"]
          : [l.dayOfWeek, toHHMM(l.startTime), toHHMM(l.endTime)]),
        weeksOf(l),
        dayOf(l.startDate) ?? "",
        dayOf(l.endDate) ?? "",
        [...(l.extraGroupIds ?? [])].sort().join(","),
        pupils ? [...(l.studentIds ?? [])].sort().join(",") : "",
      ].join("|");
    // Counted rather than put in a map: without the slot, two lessons of one
    // class and teacher on the tray share a key, and a map keeps only one of
    // them — parking a second would read as no change at all.
    const unmatched = (side: DiffLesson[], other: DiffLesson[]) => {
      const left = new Map<string, number>();
      for (const l of other) left.set(key(l), (left.get(key(l)) ?? 0) + 1);
      return side.filter((l) => {
        const k = key(l);
        const n = left.get(k) ?? 0;
        if (n > 0) left.set(k, n - 1);
        return n === 0;
      });
    };
    const added = unmatched(lessons, comparing.lessons);
    const removed = unmatched(comparing.lessons, lessons);
    // An added and a removed line never share a whole key, so two that agree
    // on everything but the pupils differ in the pupils alone. Counted, such a
    // pair would print alike; those lines name them.
    const lines = (side: DiffLesson[], other: DiffLesson[]) => {
      const rest = new Set(other.map((l) => key(l, false)));
      return side.map((lesson) => ({ lesson, namePupils: rest.has(key(lesson, false)) }));
    };
    return { added: lines(added, removed), removed: lines(removed, added) };
  }, [comparing, lessons]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("versionsTitle")}</DialogTitle>
          <DialogDescription>{t("versionsBody")}</DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input
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
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {(versions ?? []).length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              {t("versionsEmpty")}
            </p>
          ) : (
            (versions ?? []).map((version) => (
              <div
                key={version.id}
                className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{version.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(version.createdAt).toLocaleString()} ·{" "}
                    {t("lessonCount", { count: version.lessonCount })}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setComparingId(comparingId === version.id ? null : version.id)
                    }
                    title={t("versionCompare")}
                  >
                    <GitCompareArrows />
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void doRestoreVersion(version.id)}
                    disabled={versionActions.restore.isPending}
                  >
                    {t("versionRestore")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void versionActions.remove.mutateAsync(version.id)}
                    disabled={versionActions.remove.isPending}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>

        {comparingId && versionDiff ? (
          <div className="rounded-md border p-3">
            <h4 className="mb-2 text-sm font-semibold">
              {t("diffTitle", { name: comparing?.name ?? "" })}
            </h4>
            {versionDiff.added.length === 0 && versionDiff.removed.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("diffIdentical")}</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <div className="mb-1 text-xs font-medium text-emerald-700">
                    {t("diffAdded", { count: versionDiff.added.length })}
                  </div>
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    {versionDiff.added.slice(0, 8).map(({ lesson, namePupils }, index) => (
                      <li key={index}>+ {lessonLabel(lesson, namePupils)}</li>
                    ))}
                    {versionDiff.added.length > 8 ? <li>…</li> : null}
                  </ul>
                </div>
                <div>
                  <div className="mb-1 text-xs font-medium text-red-700">
                    {t("diffRemoved", { count: versionDiff.removed.length })}
                  </div>
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    {versionDiff.removed.slice(0, 8).map(({ lesson, namePupils }, index) => (
                      <li key={index}>− {lessonLabel(lesson, namePupils)}</li>
                    ))}
                    {versionDiff.removed.length > 8 ? <li>…</li> : null}
                  </ul>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
