"use client";

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { ChevronRight, ClipboardCheck } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { useProfile } from "@/components/profile-context";
import {
  useGroups,
  useRooms,
  useSubjects,
  useTeacherLessons,
} from "@/lib/queries";
import { formatTime, subjectColor, toDateString } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

export default function TeacherAttendancePage() {
  const t = useTranslations("teacherAttendance");
  const tStatus = useTranslations("lessonStatus");
  const { profile } = useProfile();

  const today = toDateString(new Date());
  const { data: lessons, isLoading } = useTeacherLessons(profile.id, today, today);
  const { data: subjects } = useSubjects();
  const { data: groups } = useGroups();
  const { data: rooms } = useRooms();

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

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : !lessons || lessons.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title={t("noLessonsToday")} />
      ) : (
        <div className="space-y-3">
          {lessons.map((lesson) => {
            const subject = subjectById.get(lesson.subjectId);
            const group = groupById.get(lesson.studentGroupId);
            const room = lesson.roomId ? roomById.get(lesson.roomId) : undefined;
            const color = subjectColor(lesson.subjectId, subject?.color);
            return (
              <Link key={lesson.id} href={`/teacher/attendance/${lesson.id}`}>
                <Card className="mb-3 transition-colors hover:border-primary/50">
                  <CardContent className="flex items-center gap-4 p-4">
                    <div
                      className="h-12 w-1.5 shrink-0 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{subject?.name ?? ""}</span>
                        {lesson.status !== "SCHEDULED" ? (
                          <Badge variant="outline">{tStatus(lesson.status)}</Badge>
                        ) : null}
                      </div>
                      <div className="mt-0.5 text-sm text-muted-foreground">
                        {formatTime(lesson.startsAt)}–{formatTime(lesson.endsAt)}
                        {group ? ` · ${group.name}` : ""}
                        {room ? ` · ${room.name}` : ""}
                      </div>
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
