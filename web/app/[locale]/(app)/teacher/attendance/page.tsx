"use client";

import { useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ChevronRight, ClipboardCheck } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { useProfile } from "@/components/profile-context";
import {
  useGroups,
  useRooms,
  useSubjects,
  useTeacherLessons,
} from "@/lib/queries";
import { subjectColor, toDateString } from "@/lib/utils";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";

export default function TeacherAttendancePage() {
  const t = useTranslations("teacherAttendance");
  const tStatus = useTranslations("lessonStatus");
  const locale = useLocale();
  const { profile } = useProfile();

  const now = new Date();
  const today = toDateString(now);
  const { data: lessons, isLoading, isError } = useTeacherLessons(profile.id, today, today);
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

  // 24-hour clock times and today's date as the reader's locale writes them.
  const tag = locale === "en" ? "en-GB" : "sv-SE";
  const time = useMemo(() => new Intl.DateTimeFormat(tag, { hour: "2-digit", minute: "2-digit" }), [tag]);
  const dateText = new Intl.DateTimeFormat(tag, { weekday: "long", day: "numeric", month: "long" }).format(now);

  const header = <PageHeader title={t("title")} subtitle={t("subtitle", { date: dateText })} />;

  return (
    <Page width="narrow">
      {header}

      {isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : isError ? (
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      ) : !lessons || lessons.length === 0 ? (
        <EmptyState icon={ClipboardCheck} title={t("noLessonsToday")} headingLevel={2} />
      ) : (
        // One link per lesson, the whole row its target: a teacher on a
        // shared tablet taps the lesson, not a word in it.
        <ul className="divide-y overflow-hidden rounded-lg border bg-card" aria-label={t("lessonsLabel")}>
          {lessons.map((lesson) => {
            const subject = subjectById.get(lesson.subjectId);
            const group = groupById.get(lesson.studentGroupId);
            const room = lesson.roomId ? roomById.get(lesson.roomId) : undefined;
            const color = subjectColor(lesson.subjectId, subject?.color);
            return (
              <li key={lesson.id}>
                <Link
                  href={`/teacher/attendance/${lesson.id}`}
                  className="flex min-h-16 items-center gap-4 px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <span
                    aria-hidden="true"
                    className="h-10 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                  <span className="min-w-0 flex-1 space-y-0.5">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{subject?.name ?? ""}</span>
                      {lesson.status !== "SCHEDULED" ? (
                        <Badge variant="outline">{tStatus(lesson.status)}</Badge>
                      ) : null}
                    </span>
                    <span className="block text-sm text-muted-foreground">
                      <span className="tabular-nums">
                        {time.format(new Date(lesson.startsAt))}–{time.format(new Date(lesson.endsAt))}
                      </span>
                      {group ? ` · ${group.name}` : ""}
                      {room ? ` · ${room.name}` : ""}
                    </span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Page>
  );
}
