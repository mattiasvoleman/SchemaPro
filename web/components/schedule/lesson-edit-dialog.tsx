"use client";

/*
 * The timetable's Justera lektion dialog: a placed lesson's day, clock, room,
 * teacher, weeks and lock, and the delete, duplicate and park buttons.
 *
 * Lifted out of app/[locale]/(app)/admin/timetable/page.tsx for the reason the
 * create, versions and room dialogs beside it were: the page carries the most
 * JavaScript in the app, and the grid on screen does not need a form that is
 * only ever drawn after a click. With this dialog and the three small ones in
 * placement-dialogs.tsx and publish-dialog.tsx gone, the route no longer
 * carries @radix-ui/react-dialog, the Switch or the date picker at all. It is
 * fetched in one chunk with them and Lägg till; see lesson-dialogs.ts.
 *
 * The draft and every action stay with the page, which opens the dialog from a
 * click on a card and saves through its undo history; they are passed in.
 *
 * RecurrenceFields is imported statically here: the whole chunk is already
 * fetched apart from the page, and one fetch beats a second one behind a
 * skeleton.
 */

import { useTranslations } from "next-intl";
import { Copy, Loader2, Lock, ParkingSquare, Trash2 } from "lucide-react";
import type { LessonRecurrence, Person, Room } from "@/lib/types";
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

/** A placed lesson's editable fields, as the dialog's controls hold them. */
export interface LessonEditDraft {
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  /** A room id, or the page's "no room" value. */
  roomId: string;
  /** A teacher id, or the page's "no teacher" value. */
  teacherId: string;
  isLocked: boolean;
  recurrence: LessonRecurrence;
  /** YYYY-MM-DD, or "" for the academic year's own boundary. */
  startDate: string;
  endDate: string;
}

export interface LessonEditDialogProps {
  open: boolean;
  /** Called with false when the dialog is dismissed (Escape, outside click, ×). */
  onOpenChange: (open: boolean) => void;
  /** WHICH lesson, for the description; null while nothing is being edited. */
  lessonName: string | null;
  draft: LessonEditDraft;
  onDraftChange: (draft: LessonEditDraft) => void;
  rooms: Room[];
  teachers: Person[];
  onDelete: () => void;
  deletePending: boolean;
  onDuplicate: () => void;
  onPark: () => void;
  onCancel: () => void;
  onSave: () => void;
  savePending: boolean;
  /** The page's "no room" / "no teacher" select value. */
  none: string;
}

export function LessonEditDialog({
  open,
  onOpenChange,
  lessonName,
  draft,
  onDraftChange,
  rooms,
  teachers,
  onDelete,
  deletePending,
  onDuplicate,
  onPark,
  onCancel,
  onSave,
  savePending,
  none,
}: LessonEditDialogProps) {
  const t = useTranslations("timetable");
  const tCommon = useTranslations("common");
  const tDays = useTranslations("days");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The component's own max-w-lg, not the max-w-md this used to narrow it
          to: two selects, two clocks and five buttons need the width, and a
          dialog narrower than its content scrolls sideways. */}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("editTitle")}</DialogTitle>
          {/* WHICH lesson. Three maths lessons on a Tuesday all opened on the
              same "Justera lektion", and the reader had to remember which one
              they had clicked. */}
          <DialogDescription>
            {lessonName !== null ? (
              <span className="block font-medium text-foreground">{lessonName}</span>
            ) : null}
            {t("editBody")}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-4 [&>*]:min-w-0">
          <div className="col-span-2 space-y-2">
            <Label>{t("editDay")}</Label>
            <Select
              value={draft.dayOfWeek}
              onValueChange={(dayOfWeek) => onDraftChange({ ...draft, dayOfWeek })}
            >
              <SelectTrigger>
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
            <Label htmlFor="edit-start">{t("editStart")}</Label>
            <Input
              id="edit-start"
              type="time"
              value={draft.startTime}
              onChange={(e) => onDraftChange({ ...draft, startTime: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-end">{t("editEnd")}</Label>
            <Input
              id="edit-end"
              type="time"
              value={draft.endTime}
              onChange={(e) => onDraftChange({ ...draft, endTime: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label>{t("editRoom")}</Label>
            <Select
              value={draft.roomId}
              onValueChange={(roomId) => onDraftChange({ ...draft, roomId })}
            >
              <SelectTrigger>
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
            <Label>{t("editTeacher")}</Label>
            <Select
              value={draft.teacherId}
              onValueChange={(teacherId) => onDraftChange({ ...draft, teacherId })}
            >
              <SelectTrigger>
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
          <RecurrenceFields
            idPrefix="edit"
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
                <div className="text-sm font-medium">{t("lockLabel")}</div>
                <div className="text-xs text-muted-foreground">{t("lockHint")}</div>
              </div>
            </div>
            <Switch
              checked={draft.isLocked}
              onCheckedChange={(isLocked) => onDraftChange({ ...draft, isLocked })}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t("propagateHint")}</p>
        <DialogFooter className="gap-2 sm:justify-between">
          {/* Both groups WRAP. Five buttons on one row is the overflow that
              put a sideways scrollbar on this dialog; a second row is what a
              narrow window gets instead. */}
          <div className="flex flex-wrap gap-2">
            <Button variant="destructive" size="sm" onClick={onDelete} disabled={deletePending}>
              <Trash2 />
              {t("deleteLesson")}
            </Button>
            <Button variant="outline" size="sm" onClick={onDuplicate}>
              <Copy />
              {t("duplicateLesson")}
            </Button>
            <Button variant="outline" size="sm" onClick={onPark}>
              <ParkingSquare />
              {t("park")}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={onCancel}>
              {tCommon("cancel")}
            </Button>
            <Button
              onClick={onSave}
              disabled={savePending || !draft.startTime || !draft.endTime}
            >
              {savePending ? (
                <>
                  <Loader2 className="animate-spin" />
                  {tCommon("saving")}
                </>
              ) : (
                tCommon("save")
              )}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
