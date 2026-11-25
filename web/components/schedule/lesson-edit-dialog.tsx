"use client";

/*
 * The timetable's Justera lektion dialog: a placed lesson's day, clock, room,
 * teacher, weeks and lock, and the delete, duplicate and park buttons.
 *
 * Lifted out of app/[locale]/(app)/admin/timetable/page.tsx for the reason the
 * create, versions and room dialogs beside it were: the page carries the most
 * JavaScript in the app, and the grid on screen does not need a form that is
 * only ever drawn after a click. With this dialog, the small ones in
 * placement-dialogs.tsx and the Publicera dialog
 * (components/publication/publish-review-dialog.tsx) gone, the route no longer
 * carries @radix-ui/react-dialog, the Switch or the date picker at all. It is
 * fetched in one chunk with them and Lägg till; see lesson-dialogs.ts.
 *
 * The draft and every action stay with the page, which opens the dialog from a
 * click on a card and saves through its undo history; they are passed in.
 *
 * While the fields are filled in, the dialog asks the gateway whether what they
 * say would be let through (lib/lesson-judgement.ts) and tells the reader the
 * reasons beside the fields, in the sentence a refused save is told in. Spara
 * stays allowed: the save is the judge, and the answer of a question is no
 * reason to hold the reader back (nor is the lack of one).
 *
 * RecurrenceFields is imported statically here: the whole chunk is already
 * fetched apart from the page, and one fetch beats a second one behind a
 * skeleton.
 */

import { useTranslations } from "next-intl";
import { ArrowLeftRight, Copy, Loader2, Lock, ParkingSquare, Trash2 } from "lucide-react";
import type { LessonRecurrence, MasterLesson, Person, Room } from "@/lib/types";
import { cn } from "@/lib/utils";
import { EXEMPT_RULES, exemptableReasons, type ExemptRule } from "@/lib/exemptions";
import { type MoveRefusal, moveOf, useLessonJudgement } from "@/lib/lesson-judgement";
import { problemSentence } from "@/lib/problem-codes";
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
  /**
   * Undantag med flit: the rules the reader has answered "Lägg ändå" to for the time the fields say (the lesson's own, when it has some).
   * Answering yes locks the lesson, as the gateway does, and the lock is held on while an exemption rests on it. Absent is none.
   */
  exempt?: ExemptRule[];
}

export interface LessonEditDialogProps {
  open: boolean;
  /** The lesson as it stands, which the fields are compared with to see what they would move; null or absent: nothing is asked. */
  lesson?: MasterLesson | null;
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
  /** Opens Byten och flyttar for this lesson (swap-dialog.tsx, fetched on the first press). */
  onSuggestSwaps: () => void;
  onCancel: () => void;
  onSave: () => void;
  savePending: boolean;
  /** The page's "no room" / "no teacher" select value. */
  none: string;
}

/** Which of the dialog's fields a refusal is about: the clock and the day, except where it names the room or the teacher. */
function marksOf(refusals: readonly MoveRefusal[]): { time: boolean; room: boolean; teacher: boolean } {
  const marks = { time: false, room: false, teacher: false };
  for (const { reason, params } of refusals) {
    const resource = reason === "ROOM" ? "ROOM" : reason === "AVAILABILITY" ? params["resource"] : undefined;
    if (resource === "ROOM") marks.room = true;
    else if (resource === "TEACHER") marks.teacher = true;
    else marks.time = true;
    if (reason === "TEACHER") marks.teacher = true;
  }
  return marks;
}

export function LessonEditDialog({
  open,
  lesson,
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
  onSuggestSwaps,
  onCancel,
  onSave,
  savePending,
  none,
}: LessonEditDialogProps) {
  const t = useTranslations("timetable");
  const tCommon = useTranslations("common");
  const tDays = useTranslations("days");
  const tSwaps = useTranslations("swaps");

  const judged = useLessonJudgement(open ? lesson : null, draft, none);
  const verdict = judged.status === "done" ? judged.judgement : null;
  const refusals = verdict?.refusals ?? [];
  const marks = marksOf(refusals);
  // A teacher the fields put on the lesson anew is asked of the staffing policy (behörighet) by the save and not by the judge, which a
  // school that refuses the unqualified answers 409 to: the "nothing in the way" must not be read as a promise about that.
  const newTeacher = lesson ? typeof moveOf(lesson, draft, none)?.teacherId === "string" : false;
  // One field is marked as the reason names it, and says which sentence to read: the status below the fields.
  const marked = (on: boolean) => ({
    "aria-invalid": on || undefined,
    "aria-describedby": on ? "edit-judgement" : undefined,
  });
  const markedClass = (on: boolean) => cn(on && "border-destructive");

  // UNDANTAG MED FLIT. The question is put under a no that is the ramtid and the class's meal and nothing else (the judge says so:
  // `exemptable`, and the reasons agree), never on a guess, and answering yes is one press that names exactly the rules refused. The
  // answer rides on the question the fields already ask (lib/lesson-judgement.ts moveOf), so the judge says what it would do before Spara.
  const exempt = draft.exempt ?? [];
  const exemptWords = (rules: readonly ExemptRule[]) => rules.map((rule) => t(`exemptRule${rule}` as never)).join(t("exemptAnd"));
  const refusedRules = verdict && !verdict.placed && verdict.exemptable === true ? exemptableReasons(refusals.map((refusal) => refusal.reason).join(",")) : null;
  const asksYes = refusedRules !== null && refusedRules.length > 0 && exempt.length === 0;
  const giving = verdict && !verdict.placed && refusals.length === 0 ? EXEMPT_RULES.filter((rule) => verdict.exempted?.includes(rule)) : [];
  const has = exempt.length > 0 && judged.status !== "checking" && (giving.length > 0 || judged.status === "idle");
  const takeBack = () => onDraftChange({ ...draft, exempt: [], isLocked: lesson?.isLocked ?? false });

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
          {/* Every Label points at its control, as in Lägg till: a Label
              beside a Radix trigger is not tied to it otherwise. */}
          <div className="col-span-2 space-y-2">
            <Label htmlFor="edit-day">{t("editDay")}</Label>
            <Select
              value={draft.dayOfWeek}
              onValueChange={(dayOfWeek) => onDraftChange({ ...draft, dayOfWeek })}
            >
              <SelectTrigger id="edit-day" {...marked(marks.time)} className={markedClass(marks.time)}>
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
              {...marked(marks.time)}
              className={markedClass(marks.time)}
              value={draft.startTime}
              onChange={(e) => onDraftChange({ ...draft, startTime: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-end">{t("editEnd")}</Label>
            <Input
              id="edit-end"
              type="time"
              {...marked(marks.time)}
              className={markedClass(marks.time)}
              value={draft.endTime}
              onChange={(e) => onDraftChange({ ...draft, endTime: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-room">{t("editRoom")}</Label>
            <Select
              value={draft.roomId}
              onValueChange={(roomId) => onDraftChange({ ...draft, roomId })}
            >
              <SelectTrigger id="edit-room" {...marked(marks.room)} className={markedClass(marks.room)}>
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
            <Label htmlFor="edit-teacher">{t("editTeacher")}</Label>
            <Select
              value={draft.teacherId}
              onValueChange={(teacherId) => onDraftChange({ ...draft, teacherId })}
            >
              <SelectTrigger id="edit-teacher" {...marked(marks.teacher)} className={markedClass(marks.teacher)}>
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
          {/* What the gateway says of the fields as they stand, before Spara: one live region, always in the tree, so that a
              screen reader that has it announces the answer when it arrives. The reasons are the refusal's own sentence
              (common.codes.MASTER_LESSON_REFUSED), with the other lesson named by class, subject, day and time. */}
          <div
            id="edit-judgement"
            role="status"
            aria-live="polite"
            // The region is there from the first render and keeps its row (one line, `min-h-5`) whether it is empty, checking or has found
            // nothing, so that the dialog does not change its height under the reader's hands as the answer comes (granskaren g462, L-5);
            // only a refusal, which has something to list, makes it taller. A live region that is not in the tree when its words arrive is
            // not announced either, so it is never taken out.
            className="col-span-2 min-h-5 text-sm"
          >
            {judged.status === "checking" ? (
              <p className="text-xs text-muted-foreground" aria-hidden="true">
                {t("judgeChecking")}
              </p>
            ) : null}
            {judged.status === "failed" ? <p className="text-xs text-muted-foreground">{t("judgeFailed")}</p> : null}
            {verdict?.placed ? <p className="rounded-md border border-destructive/60 px-3 py-2 text-destructive">{t("lessonIsPlaced")}</p> : null}
            {verdict && !verdict.placed && refusals.length > 0 ? (
              <div className="rounded-md border border-destructive/60 px-3 py-2 text-destructive">
                <p className="font-medium">{t("judgeRefused")}</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {refusals.map((refusal, index) => (
                    <li key={`${refusal.reason}-${index}`}>
                      {problemSentence("MASTER_LESSON_REFUSED", { reason: refusal.reason, ...refusal.params }, tCommon) ?? refusal.text}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {verdict && !verdict.placed && refusals.length === 0 && giving.length === 0 ? (
              <p className="text-xs text-muted-foreground">{newTeacher ? `${t("judgeOk")} ${t("judgeOkStaffing")}` : t("judgeOk")}</p>
            ) : null}
            {giving.length > 0 ? (
              <p className="rounded-md border px-3 py-2">{t("exemptGiven", { rules: exemptWords(giving) })}</p>
            ) : null}
            {judged.status === "idle" && exempt.length > 0 ? (
              <p className="rounded-md border px-3 py-2">{t("exemptHas", { rules: exemptWords(exempt) })}</p>
            ) : null}
          </div>
          {/* The question, and the way back. Outside the live region: a button inside it is read out as the answer arrives, and the
              question is the answer's own sentence above it. Only an administrator answers, and only the page's admin profiles reach here. */}
          {asksYes ? (
            <div className="col-span-2 flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
              <p className="min-w-0 text-sm">{t("exemptQuestion")}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-writes="SCHEMALAGGNING DRIFT"
                onClick={() => onDraftChange({ ...draft, exempt: refusedRules, isLocked: true })}
              >
                {t("exemptYes")}
              </Button>
            </div>
          ) : null}
          {has ? (
            <div className="col-span-2 flex justify-end">
              <Button type="button" variant="ghost" size="sm" onClick={takeBack}>
                {t("exemptTakeBack")}
              </Button>
            </div>
          ) : null}
          <div className="col-span-2 flex items-center justify-between rounded-md border px-3 py-2">
            <div className="flex items-center gap-2">
              <Lock className="size-4 text-muted-foreground" />
              <div>
                <label htmlFor="edit-lock" className="block text-sm font-medium">
                  {t("lockLabel")}
                </label>
                <div id="edit-lock-hint" className="text-xs text-muted-foreground">
                  {exempt.length > 0 ? t("lockHintExempt") : t("lockHint")}
                </div>
              </div>
            </div>
            <Switch
              id="edit-lock"
              aria-describedby="edit-lock-hint"
              checked={draft.isLocked || exempt.length > 0}
              // An exemption rests on the lock (the gateway locks the lesson with it, and refuses a request that says the opposite).
              disabled={exempt.length > 0}
              onCheckedChange={(isLocked) => onDraftChange({ ...draft, isLocked })}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{t("propagateHint")}</p>
        <DialogFooter className="gap-2 sm:justify-between">
          {/* Both groups WRAP. Five buttons on one row is the overflow that
              put a sideways scrollbar on this dialog; a second row is what a
              narrow window gets instead. */}
          <div className="flex flex-wrap gap-2" data-writes="SCHEMALAGGNING DRIFT">
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
            <Button variant="outline" size="sm" onClick={onSuggestSwaps}>
              <ArrowLeftRight />
              {tSwaps("openButton")}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={onCancel}>
              {tCommon("cancel")}
            </Button>
            <Button
              onClick={onSave}
              disabled={savePending || !draft.startTime || !draft.endTime}
              data-writes="SCHEMALAGGNING DRIFT"
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
