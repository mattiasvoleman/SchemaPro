"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { CalendarDays, Loader2, Upload } from "lucide-react";
import {
  useActiveYear,
  useGroups,
  useMasterLessons,
  usePeople,
  usePublishSchedule,
  useRooms,
  useSubjects,
  useUpdateMasterLesson,
} from "@/lib/queries";
import { ApiError } from "@/lib/api";
import type { MasterLesson } from "@/lib/types";
import { subjectColor, timeToMinutes } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";
import {
  TimetableGrid,
  type TimetableLesson,
} from "@/components/schedule/timetable-grid";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

const ALL = "__all__";
const NONE = "__none__";

/** Normalizes DB time values ("HH:MM:SS") to input-friendly "HH:MM". */
function toHHMM(time: string): string {
  return time.slice(0, 5);
}

export default function TimetablePage() {
  const t = useTranslations("timetable");
  const tCommon = useTranslations("common");
  const tDays = useTranslations("days");
  const { activeYear } = useActiveYear();
  const { data: lessons, isLoading } = useMasterLessons(activeYear?.id ?? null);
  const { data: subjects } = useSubjects();
  const { data: groups } = useGroups();
  const { data: rooms } = useRooms();
  const { data: people } = usePeople();
  const publish = usePublishSchedule();
  const updateLesson = useUpdateMasterLesson();

  const [groupFilter, setGroupFilter] = useState<string>(ALL);
  const [teacherFilter, setTeacherFilter] = useState<string>(ALL);
  const [publishOpen, setPublishOpen] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  const [editing, setEditing] = useState<MasterLesson | null>(null);
  const [editDay, setEditDay] = useState("1");
  const [editStart, setEditStart] = useState("");
  const [editEnd, setEditEnd] = useState("");
  const [editRoom, setEditRoom] = useState(NONE);
  const [editTeacher, setEditTeacher] = useState(NONE);

  const teachers = useMemo(
    () => (people ?? []).filter((person) => person.role === "TEACHER"),
    [people],
  );

  const subjectById = useMemo(
    () => new Map((subjects ?? []).map((subject) => [subject.id, subject])),
    [subjects],
  );
  const groupById = useMemo(
    () => new Map((groups ?? []).map((group) => [group.id, group])),
    [groups],
  );
  const roomById = useMemo(
    () => new Map((rooms ?? []).map((room) => [room.id, room])),
    [rooms],
  );
  const teacherById = useMemo(
    () => new Map(teachers.map((teacher) => [teacher.id, teacher])),
    [teachers],
  );

  const filtered = useMemo(
    () =>
      (lessons ?? []).filter(
        (lesson) =>
          (groupFilter === ALL || lesson.studentGroupId === groupFilter) &&
          (teacherFilter === ALL || lesson.teacherId === teacherFilter),
      ),
    [lessons, groupFilter, teacherFilter],
  );

  const gridLessons: TimetableLesson[] = useMemo(
    () =>
      filtered.map((lesson) => {
        const subject = subjectById.get(lesson.subjectId);
        const group = groupById.get(lesson.studentGroupId);
        const teacher = lesson.teacherId ? teacherById.get(lesson.teacherId) : undefined;
        const room = lesson.roomId ? roomById.get(lesson.roomId) : undefined;
        return {
          id: lesson.id,
          dayOfWeek: lesson.dayOfWeek,
          startMinutes: timeToMinutes(lesson.startTime),
          endMinutes: timeToMinutes(lesson.endTime),
          title: subject?.name ?? "",
          subtitle: [
            group?.name,
            teacher ? `${teacher.firstName[0]}. ${teacher.lastName}` : null,
          ]
            .filter(Boolean)
            .join(" · "),
          room: room?.name,
          color: subjectColor(lesson.subjectId, subject?.color),
        };
      }),
    [filtered, subjectById, groupById, teacherById, roomById],
  );

  const openEditor = (lessonId: string) => {
    const lesson = (lessons ?? []).find((entry) => entry.id === lessonId);
    if (!lesson) return;
    setEditing(lesson);
    setEditDay(String(lesson.dayOfWeek));
    setEditStart(toHHMM(lesson.startTime));
    setEditEnd(toHHMM(lesson.endTime));
    setEditRoom(lesson.roomId ?? NONE);
    setEditTeacher(lesson.teacherId ?? NONE);
  };

  const doSaveEdit = async () => {
    if (!editing) return;
    try {
      const result = await updateLesson.mutateAsync({
        id: editing.id,
        dayOfWeek: Number(editDay),
        startTime: editStart,
        endTime: editEnd,
        roomId: editRoom === NONE ? null : editRoom,
        teacherId: editTeacher === NONE ? null : editTeacher,
      });
      toast.success(t("editSaved", { count: result.propagatedLessons }));
      setEditing(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        toast.error(`${t("editConflict")}: ${error.message}`);
      } else {
        toast.error(error instanceof Error ? error.message : tCommon("error"));
      }
    }
  };

  const doPublish = async () => {
    if (!activeYear) return;
    try {
      const result = await publish.mutateAsync({
        academicYearId: activeYear.id,
        ...(fromDate ? { fromDate } : {}),
        ...(toDate ? { toDate } : {}),
      });
      toast.success(t("published", { count: result.created }));
      setPublishOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  return (
    <div>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Button
            onClick={() => {
              setFromDate(activeYear?.startDate ?? "");
              setToDate(activeYear?.endDate ?? "");
              setPublishOpen(true);
            }}
            disabled={!lessons || lessons.length === 0}
          >
            <Upload />
            {t("publish")}
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Select value={groupFilter} onValueChange={setGroupFilter}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("allGroups")}</SelectItem>
            {(groups ?? []).map((group) => (
              <SelectItem key={group.id} value={group.id}>
                {group.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={teacherFilter} onValueChange={setTeacherFilter}>
          <SelectTrigger className="w-52">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("allTeachers")}</SelectItem>
            {teachers.map((teacher) => (
              <SelectItem key={teacher.id} value={teacher.id}>
                {teacher.firstName} {teacher.lastName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filtered.length > 0 ? (
          <span className="text-sm text-muted-foreground">
            {t("lessonCount", { count: filtered.length })}
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : !lessons || lessons.length === 0 ? (
        <EmptyState icon={CalendarDays} title={tCommon("noResults")} description={t("empty")} />
      ) : (
        <TimetableGrid
          lessons={gridLessons}
          onLessonClick={(lesson) => openEditor(lesson.id)}
        />
      )}

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("editTitle")}</DialogTitle>
            <DialogDescription>{t("editBody")}</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2 space-y-2">
              <Label>{t("editDay")}</Label>
              <Select value={editDay} onValueChange={setEditDay}>
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
                value={editStart}
                onChange={(e) => setEditStart(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-end">{t("editEnd")}</Label>
              <Input
                id="edit-end"
                type="time"
                value={editEnd}
                onChange={(e) => setEditEnd(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>{t("editRoom")}</Label>
              <Select value={editRoom} onValueChange={setEditRoom}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t("noRoom")}</SelectItem>
                  {(rooms ?? []).map((room) => (
                    <SelectItem key={room.id} value={room.id}>
                      {room.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t("editTeacher")}</Label>
              <Select value={editTeacher} onValueChange={setEditTeacher}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t("noTeacher")}</SelectItem>
                  {teachers.map((teacher) => (
                    <SelectItem key={teacher.id} value={teacher.id}>
                      {teacher.firstName} {teacher.lastName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{t("propagateHint")}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              {tCommon("cancel")}
            </Button>
            <Button
              onClick={doSaveEdit}
              disabled={updateLesson.isPending || !editStart || !editEnd}
            >
              {updateLesson.isPending ? (
                <>
                  <Loader2 className="animate-spin" />
                  {tCommon("saving")}
                </>
              ) : (
                tCommon("save")
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("publishTitle")}</DialogTitle>
            <DialogDescription>{t("publishBody")}</DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="publish-from">{t("publishFrom")}</Label>
              <Input
                id="publish-from"
                type="date"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="publish-to">{t("publishTo")}</Label>
              <Input
                id="publish-to"
                type="date"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPublishOpen(false)}>
              {tCommon("cancel")}
            </Button>
            <Button onClick={doPublish} disabled={publish.isPending}>
              {publish.isPending ? (
                <>
                  <Loader2 className="animate-spin" />
                  {t("publishing")}
                </>
              ) : (
                t("publishConfirm")
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
