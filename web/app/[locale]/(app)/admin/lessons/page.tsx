"use client";

import { Suspense, lazy, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import type { MessageLookup } from "@/lib/engine-message";
import { savedToast } from "@/lib/staffing-warnings";
import { chainLookup } from "@/lib/chain-lookup";
import { shiftDate } from "@/lib/cover-absence-form";
import { toDateString } from "@/lib/utils";
import {
  CalendarX2,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MapPin,
  RotateCcw,
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
import type { LessonActionTarget } from "@/components/schedule/lesson-action-dialogs";
import { DialogLoadBoundary } from "@/components/schedule/dialog-load-boundary";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar, FilterField } from "@/components/ui/filter-bar";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCard } from "@/components/ui/table-card";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/*
 * Ställ in, Tilldela vikarie and Byt sal, fetched on the first click and
 * shared with Lärarfrånvaro (components/schedule/lesson-action-dialogs.tsx).
 * A chunk that does not arrive is caught by the DialogLoadBoundary, said in a
 * toast, and the lazy wrapper made again so the next click fetches afresh.
 */
const lazyLessonActionDialogs = () =>
  lazy(() =>
    import("@/components/schedule/lesson-action-dialogs").then((module) => ({
      default: module.LessonActionDialogs,
    })),
  );
let LessonActionDialogs = lazyLessonActionDialogs();

export default function DayPlannerPage() {
  const t = useTranslations("dayPlanner");
  const tCommon = useTranslations("common");
  const tEngine = useTranslations("engineMessages") as unknown as MessageLookup;
  // The vikarie's warnings mix the engine's STAFF_* with the cover's COVER_*
  // (lunch, rest, the cap, the days, a walk between sites too short), as on
  // Lärarfrånvaro and the cover board.
  const tWarnings = chainLookup(useTranslations("coverErrors") as unknown as MessageLookup, tEngine);
  const tStatus = useTranslations("lessonStatus");
  const locale = useLocale();

  // "Today" on the school's wall clock, not in UTC: before 02:00 in summer,
  // toISOString() still named yesterday.
  const [date, setDate] = useState(() => toDateString(new Date()));
  const lessonsQuery = useDayLessons(date);
  const lessons = lessonsQuery.data;
  const subjectsQuery = useSubjects();
  const groupsQuery = useGroups();
  const roomsQuery = useRooms();
  const peopleQuery = usePeople();
  const { cancel, reinstate, substitute, changeRoom } = useLessonActions();
  const lookupsFailed =
    subjectsQuery.isError || groupsQuery.isError || roomsQuery.isError || peopleQuery.isError;

  const [target, setTarget] = useState<LessonActionTarget | null>(null);
  const [dialogsMounted, setDialogsMounted] = useState(false);
  const [dialogLoad, setDialogLoad] = useState(0);
  const open = (action: LessonActionTarget["action"], lesson: DayLessonRow) => {
    setDialogsMounted(true);
    setTarget({ action, lesson });
  };

  const clock = useMemo(
    () => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
    [locale],
  );
  const timeText = (lesson: DayLessonRow) =>
    `${clock.format(new Date(lesson.startsAt))}–${clock.format(new Date(lesson.endsAt))}`;

  const subjectById = useMemo(
    () => new Map((subjectsQuery.data ?? []).map((subject) => [subject.id, subject.name])),
    [subjectsQuery.data],
  );
  const groupById = useMemo(
    () => new Map((groupsQuery.data ?? []).map((group) => [group.id, group.name])),
    [groupsQuery.data],
  );
  const roomById = useMemo(
    () => new Map((roomsQuery.data ?? []).map((room) => [room.id, room.name])),
    [roomsQuery.data],
  );
  const teachers = useMemo(
    () => (peopleQuery.data ?? []).filter((person) => person.role === "TEACHER" && person.isActive),
    [peopleQuery.data],
  );
  const teacherOptions = useMemo(
    () => teachers.map((teacher) => ({ id: teacher.id, name: `${teacher.firstName} ${teacher.lastName}` })),
    [teachers],
  );
  const teacherById = useMemo(
    () => new Map(teachers.map((teacher) => [teacher.id, teacher])),
    [teachers],
  );

  /** The row's name in its buttons' labels: "Ställ in lektion 08:00–09:00 Matematik 7A". */
  const lessonName = (lesson: DayLessonRow) =>
    [timeText(lesson), subjectById.get(lesson.subjectId), groupById.get(lesson.studentGroupId)]
      .filter(Boolean)
      .join(" ");
  const named = (action: string, lesson: DayLessonRow) =>
    tCommon("actionNamed", { action, name: lessonName(lesson) });

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

  const doCancel = async (lesson: DayLessonRow, reason: string) => {
    try {
      await cancel.mutateAsync({
        id: lesson.id,
        ...(reason ? { reason } : {}),
      });
      toast.success(t("cancelledToast"));
      setTarget(null);
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

  const doSubstitute = async (lesson: DayLessonRow, teacherId: string, note: string) => {
    try {
      const result = await substitute.mutateAsync({
        id: lesson.id,
        teacherId,
        ...(note ? { note } : {}),
      });
      // A vikarie is never refused, only warned: the warning is the rektor's
      // one signal that the cover lacks behörighet, so it is said here.
      savedToast(tWarnings, t("substitutedToast"), result.warnings);
      setTarget(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const doChangeRoom = async (lesson: DayLessonRow, roomId: string | null) => {
    try {
      await changeRoom.mutateAsync({ id: lesson.id, roomId });
      toast.success(t("roomChangedToast"));
      setTarget(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  return (
    <Page>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      {/*
        A day navigator: the date field carries a visible label like every
        other field in a filter bar, and the chevrons and "Idag" sit on its
        baseline. Without a name the box announced as nothing at all, and its
        calendar button as a second "Öppna kalender" nobody could place.
      */}
      <FilterBar>
        <div className="flex items-end gap-2">
          <Button
            variant="outline"
            size="icon"
            onClick={() => setDate(shiftDate(date, -1))}
            aria-label={t("previousDay")}
          >
            <ChevronLeft />
          </Button>
          <FilterField id="day-planner-date" label={tCommon("date")}>
            <DateField
              id="day-planner-date"
              className="w-40"
              label={tCommon("date")}
              value={date}
              onChange={(value) => value && setDate(value)}
            />
          </FilterField>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setDate(shiftDate(date, 1))}
            aria-label={t("nextDay")}
          >
            <ChevronRight />
          </Button>
          <Button variant="ghost" onClick={() => setDate(toDateString(new Date()))}>
            {tCommon("today")}
          </Button>
        </div>
      </FilterBar>

      {lookupsFailed ? (
        <LoadError variant="inline" title={t("lookupsFailed")} hint={t("lookupsFailedHint")} />
      ) : null}

      {lessonsQuery.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : lessonsQuery.isError ? (
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      ) : !lessons || lessons.length === 0 ? (
        <EmptyState icon={CalendarX2} title={t("emptyTitle")} description={t("emptyHint")} headingLevel={2} />
      ) : (
        <TableCard caption={t("tableCaption")}>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{tCommon("time")}</TableHead>
              <TableHead scope="col">{tCommon("subject")}</TableHead>
              <TableHead scope="col">{tCommon("group")}</TableHead>
              <TableHead scope="col">{tCommon("room")}</TableHead>
              <TableHead scope="col">{tCommon("teacher")}</TableHead>
              <TableHead scope="col">{tCommon("status")}</TableHead>
              <TableHead scope="col" className="text-right">
                {tCommon("actions")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lessons.map((lesson) => (
              <TableRow
                key={lesson.id}
                // Muted ink, not a fade: at 60 % opacity the row's "Inställd"
                // badge measured 2.69:1, the one word the row is about.
                className={lesson.status === "CANCELLED" ? "text-muted-foreground" : undefined}
              >
                <TableCell className="whitespace-nowrap tabular-nums">{timeText(lesson)}</TableCell>
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
                  {/* Text buttons, each named after its row: these verbs have
                      no icon a reader would recognise on its own. */}
                  <div className="flex flex-wrap justify-end gap-2">
                    {lesson.status === "SCHEDULED" ? (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={named(t("substituteAction"), lesson)}
                          onClick={() => open("substitute", lesson)}
                          data-writes="DRIFT"
                        >
                          <UserPlus />
                          {t("substituteAction")}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={named(t("roomChangeAction"), lesson)}
                          onClick={() => open("room", lesson)}
                          data-writes="DRIFT"
                        >
                          <MapPin />
                          {t("roomChangeAction")}
                        </Button>
                        {/* Neutral: the dialog it opens is the confirmation, and carries the red. */}
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={named(t("cancelAction"), lesson)}
                          onClick={() => open("cancel", lesson)}
                          data-writes="DRIFT"
                        >
                          <CalendarX2 />
                          {t("cancelAction")}
                        </Button>
                      </>
                    ) : lesson.status === "CANCELLED" ? (
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={named(t("reinstateAction"), lesson)}
                        onClick={() => doReinstate(lesson.id)}
                        disabled={reinstate.isPending}
                        data-writes="DRIFT"
                      >
                        {reinstate.isPending && reinstate.variables === lesson.id ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <RotateCcw />
                        )}
                        {t("reinstateAction")}
                      </Button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </TableCard>
      )}

      {dialogsMounted ? (
        <DialogLoadBoundary
          key={dialogLoad}
          onError={() => {
            toast.error(t("dialogLoadFailed"));
            LessonActionDialogs = lazyLessonActionDialogs();
            setTarget(null);
            setDialogsMounted(false);
            setDialogLoad((attempt) => attempt + 1);
          }}
        >
          <Suspense fallback={null}>
            <LessonActionDialogs
              target={target}
              onClose={() => setTarget(null)}
              teachers={teacherOptions}
              rooms={roomsQuery.data ?? []}
              pending={{
                cancel: cancel.isPending,
                substitute: substitute.isPending,
                room: changeRoom.isPending,
              }}
              onCancel={(lesson, reason) => void doCancel(lesson, reason)}
              onSubstitute={(lesson, teacherId, note) => void doSubstitute(lesson, teacherId, note)}
              onChangeRoom={(lesson, roomId) => void doChangeRoom(lesson, roomId)}
            />
          </Suspense>
        </DialogLoadBoundary>
      ) : null}
    </Page>
  );
}
