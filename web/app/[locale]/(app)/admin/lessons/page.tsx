"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  CalendarX2,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MapPin,
  UserPlus,
} from "lucide-react";
import {
  useDayLessons,
  useGroups,
  useLessonActions,
  usePeople,
  useRooms,
  useSubjects,
  type DayLessonRow,
} from "@/lib/queries";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateField } from "@/components/ui/date-field";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Sentinel for "no room" — Radix Select forbids an empty-string item value.
const NO_ROOM = "__none__";

function toDateInput(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return toDateInput(d);
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export default function DayPlannerPage() {
  const t = useTranslations("dayPlanner");
  const tCommon = useTranslations("common");
  const tStatus = useTranslations("lessonStatus");

  const [date, setDate] = useState(() => toDateInput(new Date()));
  const { data: lessons, isLoading } = useDayLessons(date);
  const { data: subjects } = useSubjects();
  const { data: groups } = useGroups();
  const { data: rooms } = useRooms();
  const { data: people } = usePeople();
  const { cancel, reinstate, substitute, changeRoom } = useLessonActions();

  const [cancelTarget, setCancelTarget] = useState<DayLessonRow | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [subTarget, setSubTarget] = useState<DayLessonRow | null>(null);
  const [subTeacher, setSubTeacher] = useState("");
  const [subNote, setSubNote] = useState("");
  const [roomTarget, setRoomTarget] = useState<DayLessonRow | null>(null);
  const [roomValue, setRoomValue] = useState("");

  const subjectById = useMemo(
    () => new Map((subjects ?? []).map((subject) => [subject.id, subject.name])),
    [subjects],
  );
  const groupById = useMemo(
    () => new Map((groups ?? []).map((group) => [group.id, group.name])),
    [groups],
  );
  const roomById = useMemo(
    () => new Map((rooms ?? []).map((room) => [room.id, room.name])),
    [rooms],
  );
  const teachers = useMemo(
    () => (people ?? []).filter((person) => person.role === "TEACHER" && person.isActive),
    [people],
  );
  const teacherById = useMemo(
    () => new Map(teachers.map((teacher) => [teacher.id, teacher])),
    [teachers],
  );

  const teacherLabel = (lesson: DayLessonRow) => {
    if (lesson.teachers.length === 0) {
      return <span className="text-muted-foreground">{t("noTeacher")}</span>;
    }
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        {lesson.teachers.map((assignment) => {
          const teacher = teacherById.get(assignment.teacherId);
          const name = teacher
            ? `${teacher.firstName} ${teacher.lastName}`
            : "—";
          return (
            <span key={assignment.teacherId} className="inline-flex items-center gap-1">
              {name}
              {assignment.role === "SUBSTITUTE" ? (
                <Badge variant="secondary">{t("substituteBadge")}</Badge>
              ) : null}
            </span>
          );
        })}
      </span>
    );
  };

  const doCancel = async () => {
    if (!cancelTarget) return;
    try {
      await cancel.mutateAsync({
        id: cancelTarget.id,
        ...(cancelReason ? { reason: cancelReason } : {}),
      });
      toast.success(t("cancelledToast"));
      setCancelTarget(null);
      setCancelReason("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const doReinstate = async (id: string) => {
    try {
      await reinstate.mutateAsync(id);
      toast.success(t("reinstatedToast"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const doSubstitute = async () => {
    if (!subTarget || !subTeacher) return;
    try {
      await substitute.mutateAsync({
        id: subTarget.id,
        teacherId: subTeacher,
        ...(subNote ? { note: subNote } : {}),
      });
      toast.success(t("substitutedToast"));
      setSubTarget(null);
      setSubTeacher("");
      setSubNote("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const doChangeRoom = async () => {
    if (!roomTarget) return;
    try {
      await changeRoom.mutateAsync({
        id: roomTarget.id,
        roomId: roomValue === NO_ROOM ? null : roomValue,
      });
      toast.success(t("roomChangedToast"));
      setRoomTarget(null);
      setRoomValue("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  return (
    <div>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <div className="mb-4 flex items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          onClick={() => setDate(shiftDate(date, -1))}
          aria-label={tCommon("back")}
        >
          <ChevronLeft />
        </Button>
        {/*
          The only date field in the app with no visible <Label>: it sits
          between two chevrons as a day navigator, and a label above it would
          push the row apart for a word the layout already says. So it carries
          its name instead of borrowing one — without it the box announced as
          nothing at all, and its calendar button as a second "Öppna kalender"
          with no way to tell which field it belonged to.
        */}
        <DateField
          className="w-44"
          aria-label={tCommon("date")}
          label={tCommon("date")}
          value={date}
          onChange={(value) => value && setDate(value)}
        />
        <Button
          variant="outline"
          size="icon"
          onClick={() => setDate(shiftDate(date, 1))}
          aria-label={tCommon("next")}
        >
          <ChevronRight />
        </Button>
        <Button variant="ghost" onClick={() => setDate(toDateInput(new Date()))}>
          {tCommon("today")}
        </Button>
      </div>

      {isLoading ? (
        <Skeleton className="h-72 w-full" />
      ) : !lessons || lessons.length === 0 ? (
        <EmptyState icon={CalendarX2} title={tCommon("noResults")} description={t("empty")} />
      ) : (
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tCommon("time")}</TableHead>
                <TableHead>{tCommon("subject")}</TableHead>
                <TableHead>{tCommon("group")}</TableHead>
                <TableHead>{tCommon("room")}</TableHead>
                <TableHead>{tCommon("teacher")}</TableHead>
                <TableHead>{tCommon("status")}</TableHead>
                <TableHead className="text-right">{tCommon("actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lessons.map((lesson) => (
                <TableRow
                  key={lesson.id}
                  className={lesson.status === "CANCELLED" ? "opacity-60" : undefined}
                >
                  <TableCell className="tabular-nums">
                    {formatTime(lesson.startsAt)}–{formatTime(lesson.endsAt)}
                  </TableCell>
                  <TableCell className="font-medium">
                    {subjectById.get(lesson.subjectId) ?? "—"}
                  </TableCell>
                  <TableCell>{groupById.get(lesson.studentGroupId) ?? "—"}</TableCell>
                  <TableCell>
                    {lesson.roomId ? (roomById.get(lesson.roomId) ?? "—") : "—"}
                  </TableCell>
                  <TableCell>{teacherLabel(lesson)}</TableCell>
                  <TableCell>
                    <Badge
                      variant={lesson.status === "CANCELLED" ? "destructive" : "secondary"}
                    >
                      {tStatus(lesson.status)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      {lesson.status === "SCHEDULED" ? (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setSubTarget(lesson);
                              setSubTeacher("");
                              setSubNote("");
                            }}
                          >
                            <UserPlus />
                            {t("substituteAction")}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              setRoomTarget(lesson);
                              setRoomValue(lesson.roomId ?? NO_ROOM);
                            }}
                          >
                            <MapPin />
                            {t("roomChangeAction")}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-destructive"
                            onClick={() => {
                              setCancelTarget(lesson);
                              setCancelReason("");
                            }}
                          >
                            <CalendarX2 />
                            {t("cancelAction")}
                          </Button>
                        </>
                      ) : lesson.status === "CANCELLED" ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => doReinstate(lesson.id)}
                          disabled={reinstate.isPending}
                        >
                          {t("reinstateAction")}
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Cancel dialog */}
      <Dialog
        open={cancelTarget !== null}
        onOpenChange={(open) => !open && setCancelTarget(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("cancelTitle")}</DialogTitle>
            <DialogDescription>{t("cancelBody")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="cancel-reason">{t("reason")}</Label>
            <Textarea
              id="cancel-reason"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder={t("reasonPlaceholder")}
              rows={2}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelTarget(null)}>
              {tCommon("cancel")}
            </Button>
            <Button variant="destructive" onClick={doCancel} disabled={cancel.isPending}>
              {cancel.isPending ? <Loader2 className="animate-spin" /> : null}
              {t("cancelAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Substitute dialog */}
      <Dialog open={subTarget !== null} onOpenChange={(open) => !open && setSubTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("substituteTitle")}</DialogTitle>
            <DialogDescription>{t("substituteBody")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t("substituteSelect")}</Label>
              <Select value={subTeacher} onValueChange={setSubTeacher}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {teachers
                    .filter(
                      (teacher) =>
                        !subTarget?.teachers.some(
                          (assignment) => assignment.teacherId === teacher.id,
                        ),
                    )
                    .map((teacher) => (
                      <SelectItem key={teacher.id} value={teacher.id}>
                        {teacher.firstName} {teacher.lastName}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="sub-note">
                {t("substituteNote")}{" "}
                <span className="text-muted-foreground">({tCommon("optional")})</span>
              </Label>
              <Input
                id="sub-note"
                value={subNote}
                onChange={(e) => setSubNote(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSubTarget(null)}>
              {tCommon("cancel")}
            </Button>
            <Button onClick={doSubstitute} disabled={!subTeacher || substitute.isPending}>
              {substitute.isPending ? <Loader2 className="animate-spin" /> : null}
              {t("substituteAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Room-change dialog */}
      <Dialog open={roomTarget !== null} onOpenChange={(open) => !open && setRoomTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("roomChangeTitle")}</DialogTitle>
            <DialogDescription>{t("roomChangeBody")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>{t("roomSelect")}</Label>
            <Select value={roomValue} onValueChange={setRoomValue}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_ROOM}>{t("roomNone")}</SelectItem>
                {(rooms ?? []).map((room) => (
                  <SelectItem key={room.id} value={room.id}>
                    {room.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRoomTarget(null)}>
              {tCommon("cancel")}
            </Button>
            <Button onClick={doChangeRoom} disabled={changeRoom.isPending}>
              {changeRoom.isPending ? <Loader2 className="animate-spin" /> : null}
              {t("roomChangeAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
