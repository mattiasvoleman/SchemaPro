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
} from "@/lib/queries";
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

export default function TimetablePage() {
  const t = useTranslations("timetable");
  const tCommon = useTranslations("common");
  const { activeYear } = useActiveYear();
  const { data: lessons, isLoading } = useMasterLessons(activeYear?.id ?? null);
  const { data: subjects } = useSubjects();
  const { data: groups } = useGroups();
  const { data: rooms } = useRooms();
  const { data: people } = usePeople();
  const publish = usePublishSchedule();

  const [groupFilter, setGroupFilter] = useState<string>(ALL);
  const [teacherFilter, setTeacherFilter] = useState<string>(ALL);
  const [publishOpen, setPublishOpen] = useState(false);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

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
        <TimetableGrid lessons={gridLessons} />
      )}

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
