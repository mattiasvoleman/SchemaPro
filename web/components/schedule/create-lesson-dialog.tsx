"use client";

/*
 * The timetable's Lägg till lektion dialog: the new lesson's fields, and the
 * open-slot finder that proposes a time and a teacher for it.
 *
 * Lifted out of app/[locale]/(app)/admin/timetable/page.tsx and fetched apart
 * from it, in the lesson dialogs' chunk (lesson-dialogs.ts) that the page asks
 * for right after it mounts: the page carries the most JavaScript in the app,
 * and this is a form that is filled in a handful of times a week while the
 * grid is on screen all day. The draft and the search stay with the page — it opens the
 * dialog from a click on empty time, from Duplicera and from the toolbar, and
 * the search needs the page's placements, rules and rosters — and are passed
 * in. Only the pupil search box is the dialog's own.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Loader2, Lock, Sparkles } from "lucide-react";
import type { OpenSlotMatch } from "@/lib/placement-search";
import type { LessonRecurrence, Person, Room, StudentGroup, Subject } from "@/lib/types";
import { RecurrenceFields } from "@/components/schedule/recurrence-fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** A lesson being added, as the dialog's fields hold it. */
export interface CreateDraft {
  subjectId: string;
  studentGroupId: string;
  /** Additional classes attending the lesson (must also be free). */
  extraGroupIds: string[];
  /** Individual participating students from any class. */
  studentIds: string[];
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  roomId: string;
  teacherId: string;
  isLocked: boolean;
  recurrence: LessonRecurrence;
  startDate: string;
  endDate: string;
}

function minutesToHHMM(minutes: number): string {
  const h = String(Math.floor(minutes / 60)).padStart(2, "0");
  const m = String(minutes % 60).padStart(2, "0");
  return `${h}:${m}`;
}

export interface CreateLessonDialogProps {
  /** The lesson being added; null while the dialog is closed. */
  draft: CreateDraft | null;
  onDraftChange: (draft: CreateDraft) => void;
  onClose: () => void;
  subjects: Subject[];
  /** The groups of the year on screen — a lesson belongs to one year. */
  groups: StudentGroup[];
  rooms: Room[];
  teachers: Person[];
  /** Active pupils, with the home class the grid reads them in. */
  students: Person[];
  groupById: ReadonlyMap<string, StudentGroup>;
  teacherById: ReadonlyMap<string, Person>;
  slotMatches: OpenSlotMatch[] | null;
  onSlotMatchesChange: (matches: OpenSlotMatch[] | null) => void;
  onSearchSlots: () => void;
  onCreate: () => void;
  pending: boolean;
  /** The page's "no room" / "no teacher" select value. */
  none: string;
}

export function CreateLessonDialog({
  draft,
  onDraftChange,
  onClose,
  subjects,
  groups,
  rooms,
  teachers,
  students,
  groupById,
  teacherById,
  slotMatches,
  onSlotMatchesChange,
  onSearchSlots,
  onCreate,
  pending,
  none,
}: CreateLessonDialogProps) {
  const t = useTranslations("timetable");
  const tCommon = useTranslations("common");
  const tDays = useTranslations("days");
  const [studentFilter, setStudentFilter] = useState("");

  const applySlot = (match: OpenSlotMatch) => {
    if (!draft) return;
    onDraftChange({
      ...draft,
      dayOfWeek: String(match.dayOfWeek),
      startTime: minutesToHHMM(match.startMinutes),
      endTime: minutesToHHMM(match.endMinutes),
      teacherId: match.teacherId,
    });
  };

  const toggleExtraGroup = (groupId: string) => {
    if (!draft) return;
    onSlotMatchesChange(null);
    onDraftChange({
      ...draft,
      extraGroupIds: draft.extraGroupIds.includes(groupId)
        ? draft.extraGroupIds.filter((id) => id !== groupId)
        : [...draft.extraGroupIds, groupId],
    });
  };

  return (
    <Dialog
      open={draft !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("addTitle")}</DialogTitle>
          <DialogDescription>{t("addBody")}</DialogDescription>
        </DialogHeader>
        {draft ? (
          <div className="grid grid-cols-2 gap-4">
            {/* Every Label points at its control. A Label beside a Radix
                trigger is not tied to it otherwise, and a screen reader
                heard the value ("Måndag", "Ingen sal") but never the field. */}
            <div className="space-y-2">
              <Label htmlFor="create-subject">{t("addSubject")}</Label>
              <Select
                value={draft.subjectId || undefined}
                onValueChange={(value) =>
                  onDraftChange({ ...draft, subjectId: value })
                }
              >
                <SelectTrigger id="create-subject">
                  <SelectValue placeholder={t("addSubject")} />
                </SelectTrigger>
                <SelectContent>
                  {subjects.map((subject) => (
                    <SelectItem key={subject.id} value={subject.id}>
                      {subject.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-group">{t("addGroup")}</Label>
              <Select
                value={draft.studentGroupId || undefined}
                onValueChange={(value) =>
                  onDraftChange({ ...draft, studentGroupId: value })
                }
              >
                <SelectTrigger id="create-group">
                  <SelectValue placeholder={t("addGroup")} />
                </SelectTrigger>
                <SelectContent>
                  {groups.map((group) => (
                    <SelectItem key={group.id} value={group.id}>
                      {group.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2 space-y-3 rounded-md border p-3">
              <div>
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Sparkles className="h-4 w-4" />
                  {t("slotFinderTitle")}
                </div>
                <p className="text-xs text-muted-foreground">{t("slotFinderHint")}</p>
              </div>
              {groups.filter((group) => group.id !== draft.studentGroupId)
                .length > 0 ? (
                <div>
                  <div className="mb-1 text-xs text-muted-foreground">
                    {t("slotFinderAlsoFree")}
                  </div>
                  {/*
                    Capped like its two siblings below, which have had
                    `max-h` and a scroll all along — this list was the one
                    that did not, and it is the one that grows with the
                    school. Forty teaching groups made the dialog taller than
                    the window.
                  */}
                  <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
                    {groups
                      .filter((group) => group.id !== draft.studentGroupId)
                      .map((group) => (
                        <button
                          key={group.id}
                          type="button"
                          onClick={() => toggleExtraGroup(group.id)}
                          className={
                            draft.extraGroupIds.includes(group.id)
                              ? "rounded-full bg-primary px-2.5 py-0.5 text-xs font-medium text-primary-foreground"
                              : "rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground hover:bg-accent"
                          }
                        >
                          {group.name}
                        </button>
                      ))}
                  </div>
                </div>
              ) : null}
              <div>
                <div className="mb-1 text-xs text-muted-foreground">
                  {t("participantStudents")}
                </div>
                {draft.studentIds.length > 0 ? (
                  <div className="mb-1.5 flex flex-wrap gap-1">
                    {draft.studentIds.map((studentId) => {
                      const student = students.find((entry) => entry.id === studentId);
                      return (
                        <button
                          key={studentId}
                          type="button"
                          onClick={() =>
                            onDraftChange({
                              ...draft,
                              studentIds: draft.studentIds.filter(
                                (id) => id !== studentId,
                              ),
                            })
                          }
                          className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground"
                          title={tCommon("delete")}
                        >
                          {student
                            ? `${student.firstName} ${student.lastName} ×`
                            : "×"}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                <Input
                  placeholder={t("participantSearch")}
                  value={studentFilter}
                  onChange={(e) => setStudentFilter(e.target.value)}
                  className="mb-1 h-8"
                />
                {studentFilter.trim().length > 0 ? (
                  <div className="max-h-28 space-y-0.5 overflow-y-auto rounded-md border p-1">
                    {students
                      .filter(
                        (student) =>
                          !draft.studentIds.includes(student.id) &&
                          `${student.firstName} ${student.lastName}`
                            .toLowerCase()
                            .includes(studentFilter.trim().toLowerCase()),
                      )
                      .slice(0, 8)
                      .map((student) => (
                        <button
                          key={student.id}
                          type="button"
                          onClick={() => {
                            onSlotMatchesChange(null);
                            onDraftChange({
                              ...draft,
                              studentIds: [...draft.studentIds, student.id],
                            });
                            setStudentFilter("");
                          }}
                          className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs hover:bg-accent"
                        >
                          <span>
                            {student.firstName} {student.lastName}
                          </span>
                          <span className="text-muted-foreground">
                            {student.studentGroupId
                              ? (groupById.get(student.studentGroupId)?.name ?? "")
                              : ""}
                          </span>
                        </button>
                      ))}
                  </div>
                ) : null}
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={onSearchSlots}
                disabled={!draft.subjectId || !draft.studentGroupId}
              >
                {t("slotFinderSearch")}
              </Button>
              {slotMatches !== null ? (
                slotMatches.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {t("slotFinderNone")}
                  </p>
                ) : (
                  <div className="max-h-44 space-y-1 overflow-y-auto">
                    {slotMatches.map((match) => {
                      const teacher = teacherById.get(match.teacherId);
                      return (
                        <button
                          key={`${match.dayOfWeek}-${match.startMinutes}-${match.teacherId}`}
                          type="button"
                          onClick={() => applySlot(match)}
                          className="flex w-full items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                        >
                          <span className="font-medium">
                            {tDays(String(match.dayOfWeek))}{" "}
                            <span className="tabular-nums">
                              {minutesToHHMM(match.startMinutes)}–
                              {minutesToHHMM(match.endMinutes)}
                            </span>
                          </span>
                          <span className="flex items-center gap-1.5 text-muted-foreground">
                            {teacher
                              ? `${teacher.firstName[0]}. ${teacher.lastName}`
                              : "—"}
                            <span
                              className={
                                match.isFallback
                                  ? "rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-800"
                                  : "rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800"
                              }
                            >
                              {match.isFallback
                                ? t("slotFinderFallback")
                                : t("slotFinderAssigned")}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )
              ) : null}
            </div>
            <div className="col-span-2 space-y-2">
              <Label htmlFor="create-day">{t("editDay")}</Label>
              <Select
                value={draft.dayOfWeek}
                onValueChange={(value) =>
                  onDraftChange({ ...draft, dayOfWeek: value })
                }
              >
                <SelectTrigger id="create-day">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4, 5, 6, 7].map((day) => (
                    <SelectItem key={day} value={String(day)}>
                      {tDays(String(day))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-start">{t("editStart")}</Label>
              <Input
                id="create-start"
                type="time"
                value={draft.startTime}
                onChange={(e) =>
                  onDraftChange({ ...draft, startTime: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-end">{t("editEnd")}</Label>
              <Input
                id="create-end"
                type="time"
                value={draft.endTime}
                onChange={(e) =>
                  onDraftChange({ ...draft, endTime: e.target.value })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-room">{t("editRoom")}</Label>
              <Select
                value={draft.roomId}
                onValueChange={(value) =>
                  onDraftChange({ ...draft, roomId: value })
                }
              >
                <SelectTrigger id="create-room">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={none}>{t("noRoom")}</SelectItem>
                  {rooms.map((room) => (
                    <SelectItem key={room.id} value={room.id}>
                      {room.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="create-teacher">{t("editTeacher")}</Label>
              <Select
                value={draft.teacherId}
                onValueChange={(value) =>
                  onDraftChange({ ...draft, teacherId: value })
                }
              >
                <SelectTrigger id="create-teacher">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={none}>{t("noTeacher")}</SelectItem>
                  {teachers.map((teacher) => (
                    <SelectItem key={teacher.id} value={teacher.id}>
                      {teacher.firstName} {teacher.lastName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {/*
              Imported statically: the fields carry the 546-line date picker,
              but this dialog is already fetched apart from the page, in one
              chunk with Justera, which draws the same fields.
            */}
            <RecurrenceFields
              idPrefix="create"
              value={{
                recurrence: draft.recurrence,
                startDate: draft.startDate,
                endDate: draft.endDate,
              }}
              onChange={(next) => onDraftChange({ ...draft, ...next })}
            />
            <div className="col-span-2 flex items-center justify-between rounded-md border px-3 py-2">
              <div className="flex items-center gap-2">
                <Lock className="h-4 w-4 text-muted-foreground" />
                <div>
                  <label htmlFor="create-lock" className="block text-sm font-medium">
                    {t("lockLabel")}
                  </label>
                  <div id="create-lock-hint" className="text-xs text-muted-foreground">
                    {t("lockHint")}
                  </div>
                </div>
              </div>
              <Switch
                id="create-lock"
                aria-describedby="create-lock-hint"
                checked={draft.isLocked}
                onCheckedChange={(checked) =>
                  onDraftChange({ ...draft, isLocked: checked })
                }
              />
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tCommon("cancel")}
          </Button>
          <Button
            onClick={onCreate}
            disabled={
              pending ||
              !draft ||
              !draft.subjectId ||
              !draft.studentGroupId ||
              !draft.startTime ||
              !draft.endTime
            }
          >
            {pending ? (
              <>
                <Loader2 className="animate-spin" />
                {tCommon("saving")}
              </>
            ) : (
              t("addConfirm")
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
