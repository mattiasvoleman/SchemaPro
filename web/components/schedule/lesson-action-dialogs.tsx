"use client";

/*
 * The three things an admin does to one calendar lesson after publishing —
 * Ställ in, Tilldela vikarie and Byt sal — shared by Dagsplanering
 * (/admin/lessons) and Lärarfrånvaro (/admin/teacher-absence), which drew the
 * same three dialogs twice.
 *
 * ONE MODULE, FETCHED ON THE FIRST CLICK. Both pages import it with
 * React.lazy, so a page that only reads the day never downloads the forms,
 * and the three share one copy of Select and Textarea in one chunk
 * (lesson-dialogs.ts gives the reason a chunk per dialog would copy them).
 *
 * The dialogs hold their own fields and hand the result up. Each page keeps
 * its own mutation, because the two differ in what they send: Lärarfrånvaro
 * cancels with cause TEACHER_UNAVAILABLE and reads the vikarie's warnings
 * against the cover catalogue too. Lärarfrånvaro also passes the ranked
 * suggestions for a vikarie; Dagsplanering has none.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { CalendarX2, Loader2, MapPin, Sparkles, UserPlus } from "lucide-react";
import type { DayLessonRow } from "@/lib/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
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

// Sentinel for "no room" — Radix Select forbids an empty-string item value.
const NO_ROOM = "__none__";

export type LessonAction = "cancel" | "substitute" | "room";

/** Which dialog is open, on which lesson; null when none is. */
export interface LessonActionTarget {
  action: LessonAction;
  lesson: DayLessonRow;
}

/** The ranked vikarier for the open lesson (Lärarfrånvaro only). */
export interface SubstituteSuggestions {
  loading: boolean;
  items: { teacherId: string; isPrimary: boolean }[];
}

export interface LessonActionDialogsProps {
  target: LessonActionTarget | null;
  onClose: () => void;
  /** The active teachers a vikarie can be chosen from. */
  teachers: { id: string; name: string }[];
  rooms: { id: string; name: string }[];
  /** Whether each mutation is in flight: its confirm spins and is disabled. */
  pending: Record<LessonAction, boolean>;
  /** "" when no message was written. */
  onCancel: (lesson: DayLessonRow, reason: string) => void;
  /** "" when no note was written. */
  onSubstitute: (lesson: DayLessonRow, teacherId: string, note: string) => void;
  /** null takes the lesson out of its room. */
  onChangeRoom: (lesson: DayLessonRow, roomId: string | null) => void;
  suggestions?: SubstituteSuggestions;
}

/** Ställ in, Tilldela vikarie and Byt sal for one lesson. Only the target's dialog is open. */
export function LessonActionDialogs({
  target,
  onClose,
  teachers,
  rooms,
  pending,
  onCancel,
  onSubstitute,
  onChangeRoom,
  suggestions,
}: LessonActionDialogsProps) {
  const t = useTranslations("dayPlanner");
  const tCommon = useTranslations("common");

  const [reason, setReason] = useState("");
  const [teacherId, setTeacherId] = useState("");
  const [note, setNote] = useState("");
  const [roomId, setRoomId] = useState(NO_ROOM);

  // A new target starts with empty fields (the room field on the lesson's
  // own room), set while rendering so no frame shows the last lesson's values.
  const [seen, setSeen] = useState<LessonActionTarget | null>(null);
  if (target !== seen) {
    setSeen(target);
    if (target) {
      setReason("");
      setTeacherId("");
      setNote("");
      setRoomId(target.lesson.roomId ?? NO_ROOM);
    }
  }

  const lesson = target?.lesson ?? null;
  const close = (open: boolean) => {
    if (!open) onClose();
  };
  const teacherName = (id: string) => teachers.find((teacher) => teacher.id === id)?.name ?? "—";
  // Not the teachers already on the lesson: a vikarie replaces them.
  const candidates =
    target?.action === "substitute"
      ? teachers.filter(
          (teacher) => !target.lesson.teachers.some((assignment) => assignment.teacherId === teacher.id),
        )
      : teachers;

  return (
    <>
      <Dialog open={target?.action === "cancel"} onOpenChange={close}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("cancelTitle")}</DialogTitle>
            <DialogDescription>{t("cancelBody")}</DialogDescription>
          </DialogHeader>
          <FormField id="lesson-cancel-reason" label={t("reason")}>
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={t("reasonPlaceholder")}
              rows={2}
            />
          </FormField>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {tCommon("cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => lesson && onCancel(lesson, reason)}
              disabled={pending.cancel}
            >
              {pending.cancel ? <Loader2 className="animate-spin" /> : <CalendarX2 />}
              {t("cancelAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={target?.action === "substitute"} onOpenChange={close}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("substituteTitle")}</DialogTitle>
            <DialogDescription>{t("substituteBody")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {suggestions ? (
              <div className="space-y-1.5" role="group" aria-labelledby="lesson-sub-suggestions">
                <p id="lesson-sub-suggestions" className="flex items-center gap-1.5 text-sm font-medium">
                  <Sparkles className="size-3.5" aria-hidden="true" />
                  {t("suggestions")}
                </p>
                {suggestions.loading ? (
                  <Skeleton className="h-8 w-full" />
                ) : suggestions.items.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("suggestionsEmpty")}</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {suggestions.items.map((suggestion) => (
                      <Button
                        key={suggestion.teacherId}
                        type="button"
                        variant={teacherId === suggestion.teacherId ? "default" : "outline"}
                        size="sm"
                        aria-pressed={teacherId === suggestion.teacherId}
                        onClick={() => setTeacherId(suggestion.teacherId)}
                      >
                        {teacherName(suggestion.teacherId)}
                        {suggestion.isPrimary ? (
                          <Badge variant="secondary" className="ml-1.5">
                            {t("suggestionsPrimary")}
                          </Badge>
                        ) : null}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
            <FormField id="lesson-sub-teacher" label={t("substituteSelect")}>
              {(control) => (
                <Select value={teacherId} onValueChange={setTeacherId}>
                  <SelectTrigger {...control}>
                    <SelectValue placeholder={tCommon("select")} />
                  </SelectTrigger>
                  <SelectContent>
                    {candidates.map((teacher) => (
                      <SelectItem key={teacher.id} value={teacher.id}>
                        {teacher.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </FormField>
            <FormField id="lesson-sub-note" label={t("substituteNote")} optional>
              <Input value={note} onChange={(event) => setNote(event.target.value)} />
            </FormField>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {tCommon("cancel")}
            </Button>
            <Button
              onClick={() => lesson && teacherId && onSubstitute(lesson, teacherId, note)}
              disabled={!teacherId || pending.substitute}
            >
              {pending.substitute ? <Loader2 className="animate-spin" /> : <UserPlus />}
              {t("substituteAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={target?.action === "room"} onOpenChange={close}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("roomChangeTitle")}</DialogTitle>
            <DialogDescription>{t("roomChangeBody")}</DialogDescription>
          </DialogHeader>
          <FormField id="lesson-room" label={t("roomSelect")}>
            {(control) => (
              <Select value={roomId} onValueChange={setRoomId}>
                <SelectTrigger {...control}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_ROOM}>{t("roomNone")}</SelectItem>
                  {rooms.map((room) => (
                    <SelectItem key={room.id} value={room.id}>
                      {room.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {tCommon("cancel")}
            </Button>
            <Button
              onClick={() => lesson && onChangeRoom(lesson, roomId === NO_ROOM ? null : roomId)}
              disabled={pending.room}
            >
              {pending.room ? <Loader2 className="animate-spin" /> : <MapPin />}
              {t("roomChangeAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
