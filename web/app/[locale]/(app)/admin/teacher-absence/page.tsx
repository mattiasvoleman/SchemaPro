"use client";

import { Suspense, lazy, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { MessageLookup } from "@/lib/engine-message";
import { savedToast } from "@/lib/staffing-warnings";
import { chainLookup } from "@/lib/cover-view";
import {
  CalendarPlus,
  CalendarX2,
  Loader2,
  MapPin,
  Sparkles,
  UserPlus,
  UserX,
} from "lucide-react";
import {
  useGroups,
  useLessonActions,
  usePeople,
  useRooms,
  useSubjects,
  useSubstituteSuggestions,
  useTeacherAbsenceLessons,
  type DayLessonRow,
} from "@/lib/queries";
import { PageHeader } from "@/components/layout/page-header";
import { AbsenceRegister } from "./absence-register";
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

/** Registrera frånvaro: the form is loaded on its first click (React.lazy). */
const AbsenceDialog = lazy(() =>
  import("@/components/cover/absence-dialog").then((module) => ({ default: module.AbsenceDialog })),
);

// Sentinel for "no room" — Radix Select forbids an empty-string item value.
const NO_ROOM = "__none__";

function toDateInput(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(iso: string): string {
  return new Date(`${iso}T00:00:00.000Z`).toLocaleDateString([], {
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  });
}

export default function TeacherAbsencePage() {
  const t = useTranslations("teacherAbsence");
  const tDay = useTranslations("dayPlanner");
  const tCommon = useTranslations("common");
  const tEngine = useTranslations("engineMessages") as unknown as MessageLookup;
  // The vikarie's warnings mix the engine's STAFF_* with the cover's COVER_*.
  const tWarnings = chainLookup(useTranslations("coverErrors") as unknown as MessageLookup, tEngine);

  const today = toDateInput(new Date());
  const [teacherId, setTeacherId] = useState("");
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);

  const { data: people } = usePeople();
  const { data: subjects } = useSubjects();
  const { data: groups } = useGroups();
  const { data: rooms } = useRooms();
  const { cancel, substitute, changeRoom } = useLessonActions();

  const { data: lessons, isLoading } = useTeacherAbsenceLessons(
    teacherId || null,
    from,
    to,
  );

  const [cancelTarget, setCancelTarget] = useState<DayLessonRow | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [subTarget, setSubTarget] = useState<DayLessonRow | null>(null);
  const [subTeacher, setSubTeacher] = useState("");
  const [subNote, setSubNote] = useState("");
  const [roomTarget, setRoomTarget] = useState<DayLessonRow | null>(null);
  const [roomValue, setRoomValue] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [registerOpened, setRegisterOpened] = useState(false);

  const { data: suggestions, isLoading: suggestionsLoading } =
    useSubstituteSuggestions(subTarget?.id ?? null);

  const teachers = useMemo(
    () => (people ?? []).filter((p) => p.role === "TEACHER" && p.isActive),
    [people],
  );
  const teacherOptions = useMemo(
    () => teachers.map((teacher) => ({ id: teacher.id, name: `${teacher.firstName} ${teacher.lastName}` })),
    [teachers],
  );
  const teacherById = useMemo(
    () => new Map(teachers.map((teacher) => [teacher.id, teacher])),
    [teachers],
  );
  const subjectById = useMemo(
    () => new Map((subjects ?? []).map((s) => [s.id, s.name])),
    [subjects],
  );
  const groupById = useMemo(
    () => new Map((groups ?? []).map((g) => [g.id, g.name])),
    [groups],
  );
  const roomById = useMemo(
    () => new Map((rooms ?? []).map((r) => [r.id, r.name])),
    [rooms],
  );

  const teacherName = (id: string) => {
    const teacher = teacherById.get(id);
    return teacher ? `${teacher.firstName} ${teacher.lastName}` : "—";
  };

  const doCancel = async () => {
    if (!cancelTarget) return;
    try {
      // TEACHER_UNAVAILABLE: this page is where a teacher's absence after
      // publishing is handled, and Täckning splits lost time by cause — the
      // cause Skolinspektionen asks about most. The reason stays free text.
      await cancel.mutateAsync({
        id: cancelTarget.id,
        cause: "TEACHER_UNAVAILABLE",
        ...(cancelReason ? { reason: cancelReason } : {}),
      });
      toast.success(tDay("cancelledToast"));
      setCancelTarget(null);
      setCancelReason("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const doSubstitute = async () => {
    if (!subTarget || !subTeacher) return;
    try {
      const result = await substitute.mutateAsync({
        id: subTarget.id,
        teacherId: subTeacher,
        ...(subNote ? { note: subNote } : {}),
      });
      // A vikarie is never refused, only warned: the warning is the rektor's
      // one signal that the cover lacks behörighet, so it is said here.
      savedToast(tWarnings, tDay("substitutedToast"), result.warnings);
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
      toast.success(tDay("roomChangedToast"));
      setRoomTarget(null);
      setRoomValue("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const cancelAll = async () => {
    if (!lessons || lessons.length === 0) return;
    setBulkBusy(true);
    let failed = 0;
    for (const lesson of lessons) {
      try {
        await cancel.mutateAsync({ id: lesson.id, cause: "TEACHER_UNAVAILABLE" });
      } catch {
        failed += 1;
      }
    }
    setBulkBusy(false);
    if (failed === 0) {
      toast.success(t("cancelAllDone", { count: lessons.length }));
    } else {
      toast.error(t("cancelAllPartial", { failed }));
    }
  };

  return (
    <div>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      {/*
       * The register: absences as entities, whose lessons land on the cover
       * board (Vikarietavla). Below it the preview this page always had — a
       * teacher and a range, the lessons, and the per-lesson actions — kept
       * exactly, with "Registrera frånvaro" turning the range into an absence.
       */}
      <AbsenceRegister teachers={teacherOptions} />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label>{t("selectTeacher")}</Label>
          <Select value={teacherId} onValueChange={setTeacherId}>
            <SelectTrigger className="w-64">
              <SelectValue placeholder={t("selectTeacherPlaceholder")} />
            </SelectTrigger>
            <SelectContent>
              {teachers.map((teacher) => (
                <SelectItem key={teacher.id} value={teacher.id}>
                  {teacher.firstName} {teacher.lastName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="from-date">{t("from")}</Label>
          <DateField
            label={t("from")}
            id="from-date"
            className="w-40"
            value={from}
            onChange={(value) => value && setFrom(value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="to-date">{t("to")}</Label>
          <DateField
            label={t("to")}
            id="to-date"
            className="w-40"
            value={to}
            onChange={(value) => value && setTo(value)}
          />
        </div>
        <Button
          onClick={() => {
            setRegisterOpened(true);
            setRegistering(true);
          }}
        >
          <CalendarPlus />
          {t("register")}
        </Button>
        {teacherId && lessons && lessons.length > 0 ? (
          <Button
            variant="outline"
            className="text-destructive"
            onClick={cancelAll}
            disabled={bulkBusy || cancel.isPending}
          >
            {bulkBusy ? <Loader2 className="animate-spin" /> : <CalendarX2 />}
            {t("cancelAll")}
          </Button>
        ) : null}
      </div>

      {!teacherId ? (
        <EmptyState icon={UserX} title={t("chooseTitle")} description={t("chooseBody")} />
      ) : isLoading ? (
        <Skeleton className="h-72 w-full" />
      ) : !lessons || lessons.length === 0 ? (
        <EmptyState icon={CalendarX2} title={tCommon("noResults")} description={t("empty")} />
      ) : (
        <>
          <p className="mb-2 text-sm text-muted-foreground">
            {t("affectedCount", { count: lessons.length })}
          </p>
          <div className="rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("date")}</TableHead>
                  <TableHead>{tCommon("time")}</TableHead>
                  <TableHead>{tCommon("subject")}</TableHead>
                  <TableHead>{tCommon("group")}</TableHead>
                  <TableHead>{tCommon("room")}</TableHead>
                  <TableHead className="text-right">{tCommon("actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lessons.map((lesson) => (
                  <TableRow key={lesson.id}>
                    <TableCell className="whitespace-nowrap">
                      {formatDate(lesson.date)}
                    </TableCell>
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
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
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
                          {tDay("substituteAction")}
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
                          {tDay("roomChangeAction")}
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
                          {tDay("cancelAction")}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}

      {registerOpened ? (
        <Suspense fallback={null}>
          <AbsenceDialog
            open={registering}
            onOpenChange={setRegistering}
            mode="ADMIN"
            teachers={teacherOptions}
            initial={{ userId: teacherId, from, to: to < from ? from : to }}
          />
        </Suspense>
      ) : null}

      {/* Cancel dialog */}
      <Dialog
        open={cancelTarget !== null}
        onOpenChange={(open) => !open && setCancelTarget(null)}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{tDay("cancelTitle")}</DialogTitle>
            <DialogDescription>{tDay("cancelBody")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="cancel-reason">{tDay("reason")}</Label>
            <Textarea
              id="cancel-reason"
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder={tDay("reasonPlaceholder")}
              rows={2}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCancelTarget(null)}>
              {tCommon("cancel")}
            </Button>
            <Button variant="destructive" onClick={doCancel} disabled={cancel.isPending}>
              {cancel.isPending ? <Loader2 className="animate-spin" /> : null}
              {tDay("cancelAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Substitute dialog with suggestions */}
      <Dialog open={subTarget !== null} onOpenChange={(open) => !open && setSubTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{tDay("substituteTitle")}</DialogTitle>
            <DialogDescription>{tDay("substituteBody")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5">
                <Sparkles className="h-3.5 w-3.5" />
                {tDay("suggestions")}
              </Label>
              {suggestionsLoading ? (
                <Skeleton className="h-8 w-full" />
              ) : (suggestions ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {tDay("suggestionsEmpty")}
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {(suggestions ?? []).map((suggestion) => (
                    <Button
                      key={suggestion.teacherId}
                      type="button"
                      variant={
                        subTeacher === suggestion.teacherId ? "default" : "outline"
                      }
                      size="sm"
                      onClick={() => setSubTeacher(suggestion.teacherId)}
                    >
                      {teacherName(suggestion.teacherId)}
                      {suggestion.isPrimary ? (
                        <Badge variant="secondary" className="ml-1.5">
                          {tDay("suggestionsPrimary")}
                        </Badge>
                      ) : null}
                    </Button>
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-2">
              <Label>{tDay("substituteSelect")}</Label>
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
                {tDay("substituteNote")}{" "}
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
              {tDay("substituteAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Room-change dialog */}
      <Dialog open={roomTarget !== null} onOpenChange={(open) => !open && setRoomTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{tDay("roomChangeTitle")}</DialogTitle>
            <DialogDescription>{tDay("roomChangeBody")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label>{tDay("roomSelect")}</Label>
            <Select value={roomValue} onValueChange={setRoomValue}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_ROOM}>{tDay("roomNone")}</SelectItem>
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
              {tDay("roomChangeAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
