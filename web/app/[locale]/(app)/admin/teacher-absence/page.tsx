"use client";

import { Suspense, lazy, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import type { MessageLookup } from "@/lib/engine-message";
import { savedToast } from "@/lib/staffing-warnings";
import { chainLookup } from "@/lib/cover-view";
import { cn, toDateString } from "@/lib/utils";
import {
  CalendarPlus,
  CalendarX2,
  Loader2,
  MapPin,
  UserPlus,
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
import type { LessonActionTarget } from "@/components/schedule/lesson-action-dialogs";
import { DialogLoadBoundary } from "@/components/schedule/dialog-load-boundary";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { AbsenceRegister } from "./absence-register";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DateField } from "@/components/ui/date-field";
import { FilterBar, FilterField } from "@/components/ui/filter-bar";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
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

/*
 * Ställ in, Tilldela vikarie and Byt sal, the same dialogs as Dagsplanering
 * (components/schedule/lesson-action-dialogs.tsx), fetched on the first
 * click. A chunk that does not arrive is said in a toast and fetched afresh
 * on the next click, as on Dagsplanering.
 */
const lazyLessonActionDialogs = () =>
  lazy(() =>
    import("@/components/schedule/lesson-action-dialogs").then((module) => ({
      default: module.LessonActionDialogs,
    })),
  );
let LessonActionDialogs = lazyLessonActionDialogs();

/*
 * The lessons sit inside their SectionCard, as the register's absences do,
 * so the table takes the same inner recipe (absence-register.tsx). Below sm
 * the subject keeps its column with the day and time under it, beside the
 * class and the actions; the room waits for a wider screen.
 */
const INNER_TH = "h-auto py-1.5 pr-3 text-xs";
const INNER_TD = "py-1.5 pr-3";
const WIDE = "hidden sm:table-cell";

export default function TeacherAbsencePage() {
  const t = useTranslations("teacherAbsence");
  const tDay = useTranslations("dayPlanner");
  const tCommon = useTranslations("common");
  const tEngine = useTranslations("engineMessages") as unknown as MessageLookup;
  // The vikarie's warnings mix the engine's STAFF_* with the cover's COVER_*.
  const tWarnings = chainLookup(useTranslations("coverErrors") as unknown as MessageLookup, tEngine);
  const locale = useLocale();

  // The school's own day, not UTC's: late in the evening toISOString() had
  // already moved on to tomorrow.
  const today = toDateString(new Date());
  const [teacherId, setTeacherId] = useState("");
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);

  const peopleQuery = usePeople();
  const subjectsQuery = useSubjects();
  const groupsQuery = useGroups();
  const roomsQuery = useRooms();
  const { cancel, substitute, changeRoom } = useLessonActions();
  const lookupsFailed =
    subjectsQuery.isError || groupsQuery.isError || roomsQuery.isError || peopleQuery.isError;

  const lessonsQuery = useTeacherAbsenceLessons(teacherId || null, from, to);
  const lessons = lessonsQuery.data;

  const [target, setTarget] = useState<LessonActionTarget | null>(null);
  const [dialogsMounted, setDialogsMounted] = useState(false);
  const [dialogLoad, setDialogLoad] = useState(0);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [registerOpened, setRegisterOpened] = useState(false);

  const substituteFor = target?.action === "substitute" ? target.lesson.id : null;
  const suggestionsQuery = useSubstituteSuggestions(substituteFor);

  const teachers = useMemo(
    () => (peopleQuery.data ?? []).filter((p) => p.role === "TEACHER" && p.isActive),
    [peopleQuery.data],
  );
  const teacherOptions = useMemo(
    () => teachers.map((teacher) => ({ id: teacher.id, name: `${teacher.firstName} ${teacher.lastName}` })),
    [teachers],
  );
  const subjectById = useMemo(
    () => new Map((subjectsQuery.data ?? []).map((s) => [s.id, s.name])),
    [subjectsQuery.data],
  );
  const groupById = useMemo(
    () => new Map((groupsQuery.data ?? []).map((g) => [g.id, g.name])),
    [groupsQuery.data],
  );
  const roomById = useMemo(
    () => new Map((roomsQuery.data ?? []).map((r) => [r.id, r.name])),
    [roomsQuery.data],
  );

  const clock = useMemo(
    () => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
    [locale],
  );
  // A lesson's date is a calendar day (yyyy-mm-dd), read at UTC midnight so
  // no time zone moves it to the day before.
  const day = useMemo(
    () => new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }),
    [locale],
  );
  const timeText = (lesson: DayLessonRow) =>
    `${clock.format(new Date(lesson.startsAt))}–${clock.format(new Date(lesson.endsAt))}`;
  const dateText = (date: string) => day.format(new Date(`${date}T00:00:00.000Z`));

  /** The row's name in its buttons' labels: "Ställ in lektion mån 12 okt. 08:00–09:00 Matematik 7A". */
  const named = (action: string, lesson: DayLessonRow) =>
    tCommon("actionNamed", {
      action,
      name: [
        dateText(lesson.date),
        timeText(lesson),
        subjectById.get(lesson.subjectId),
        groupById.get(lesson.studentGroupId),
      ]
        .filter(Boolean)
        .join(" "),
    });

  const open = (action: LessonActionTarget["action"], lesson: DayLessonRow) => {
    setDialogsMounted(true);
    setTarget({ action, lesson });
  };

  const doCancel = async (lesson: DayLessonRow, reason: string) => {
    try {
      // TEACHER_UNAVAILABLE: this page is where a teacher's absence after
      // publishing is handled, and Täckning splits lost time by cause — the
      // cause Skolinspektionen asks about most. The reason stays free text.
      await cancel.mutateAsync({
        id: lesson.id,
        cause: "TEACHER_UNAVAILABLE",
        ...(reason ? { reason } : {}),
      });
      toast.success(tDay("cancelledToast"));
      setTarget(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const doSubstitute = async (lesson: DayLessonRow, teacher: string, note: string) => {
    try {
      const result = await substitute.mutateAsync({
        id: lesson.id,
        teacherId: teacher,
        ...(note ? { note } : {}),
      });
      // A vikarie is never refused, only warned: the warning is the rektor's
      // one signal that the cover lacks behörighet, so it is said here.
      savedToast(tWarnings, tDay("substitutedToast"), result.warnings);
      setTarget(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const doChangeRoom = async (lesson: DayLessonRow, roomId: string | null) => {
    try {
      await changeRoom.mutateAsync({ id: lesson.id, roomId });
      toast.success(tDay("roomChangedToast"));
      setTarget(null);
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
    setConfirmingAll(false);
    if (failed === 0) {
      toast.success(t("cancelAllDone", { count: lessons.length }));
    } else {
      toast.error(t("cancelAllPartial", { failed }));
    }
  };

  const shown = teacherId && lessons ? lessons.length : 0;

  return (
    <Page>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Button
            onClick={() => {
              setRegisterOpened(true);
              setRegistering(true);
            }}
            data-writes="DRIFT"
          >
            <CalendarPlus />
            {t("register")}
          </Button>
        }
      />

      {lookupsFailed ? (
        <LoadError variant="inline" title={tDay("lookupsFailed")} hint={tDay("lookupsFailedHint")} />
      ) : null}

      {/*
       * The register: absences as entities, whose lessons land on the cover
       * board (Vikarietavla). Below it the preview this page always had — a
       * teacher and a range, the lessons, and the per-lesson actions — kept
       * exactly, with "Registrera frånvaro" turning the range into an absence.
       */}
      <AbsenceRegister teachers={teacherOptions} />

      <SectionCard id="absence-lessons" title={t("previewTitle")} description={t("previewBody")}>
        <FilterBar>
          {/* Its own id: the register dialog's teacher field is "absence-teacher". */}
          <FilterField id="absence-preview-teacher" label={t("selectTeacher")}>
            <Select value={teacherId} onValueChange={setTeacherId}>
              <SelectTrigger id="absence-preview-teacher" className="w-64">
                <SelectValue placeholder={t("selectTeacherPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {teacherOptions.map((teacher) => (
                  <SelectItem key={teacher.id} value={teacher.id}>
                    {teacher.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FilterField>
          <FilterField id="from-date" label={t("from")}>
            <DateField
              label={t("from")}
              id="from-date"
              className="w-40"
              value={from}
              onChange={(value) => value && setFrom(value)}
            />
          </FilterField>
          <FilterField id="to-date" label={t("to")}>
            <DateField
              label={t("to")}
              id="to-date"
              className="w-40"
              value={to}
              onChange={(value) => value && setTo(value)}
            />
          </FilterField>
          {shown > 0 ? (
            // Neutral: the confirmation it opens names the count and carries the red.
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              onClick={() => setConfirmingAll(true)}
              disabled={bulkBusy || cancel.isPending}
              data-writes="DRIFT"
            >
              {bulkBusy ? <Loader2 className="animate-spin" /> : <CalendarX2 />}
              {t("cancelAll")}
            </Button>
          ) : null}
        </FilterBar>

        {!teacherId ? (
          <p className="text-sm text-muted-foreground">{t("chooseBody")}</p>
        ) : lessonsQuery.isLoading ? (
          <div aria-busy="true">
            <Skeleton className="h-24 w-full" />
          </div>
        ) : lessonsQuery.isError ? (
          <LoadError variant="inline" title={t("loadFailed")} hint={t("loadFailedHint")} />
        ) : !lessons || lessons.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {t("affectedCount", { count: lessons.length })}
            </p>
            <div className="overflow-x-auto">
              <Table>
                <caption className="sr-only">{t("tableCaption")}</caption>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead scope="col" className={cn(INNER_TH, WIDE, "pl-0")}>
                      {t("date")}
                    </TableHead>
                    <TableHead scope="col" className={cn(INNER_TH, WIDE)}>
                      {tCommon("time")}
                    </TableHead>
                    <TableHead scope="col" className={cn(INNER_TH, "pl-0 sm:pl-3")}>
                      {tCommon("subject")}
                    </TableHead>
                    <TableHead scope="col" className={INNER_TH}>
                      {tCommon("group")}
                    </TableHead>
                    <TableHead scope="col" className={cn(INNER_TH, WIDE)}>
                      {tCommon("room")}
                    </TableHead>
                    <TableHead scope="col" className={cn(INNER_TH, "pr-0 text-right")}>
                      {tCommon("actions")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lessons.map((lesson) => (
                    <TableRow key={lesson.id}>
                      <TableCell className={cn(INNER_TD, WIDE, "whitespace-nowrap pl-0 tabular-nums")}>
                        {dateText(lesson.date)}
                      </TableCell>
                      <TableCell className={cn(INNER_TD, WIDE, "whitespace-nowrap tabular-nums")}>
                        {timeText(lesson)}
                      </TableCell>
                      <TableCell className={cn(INNER_TD, "pl-0 font-medium sm:pl-3")}>
                        {subjectById.get(lesson.subjectId) ?? "—"}
                        <span className="block whitespace-nowrap text-xs font-normal tabular-nums text-muted-foreground sm:hidden">
                          {`${dateText(lesson.date)} · ${timeText(lesson)}`}
                        </span>
                      </TableCell>
                      <TableCell className={INNER_TD}>{groupById.get(lesson.studentGroupId) ?? "—"}</TableCell>
                      <TableCell className={cn(INNER_TD, WIDE)}>
                        {lesson.roomId ? (roomById.get(lesson.roomId) ?? "—") : "—"}
                      </TableCell>
                      <TableCell className={cn(INNER_TD, "pr-0 text-right")}>
                        <div className="flex flex-wrap justify-end gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={named(tDay("substituteAction"), lesson)}
                            onClick={() => open("substitute", lesson)}
                            data-writes="DRIFT"
                          >
                            <UserPlus />
                            {tDay("substituteAction")}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={named(tDay("roomChangeAction"), lesson)}
                            onClick={() => open("room", lesson)}
                            data-writes="DRIFT"
                          >
                            <MapPin />
                            {tDay("roomChangeAction")}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={named(tDay("cancelAction"), lesson)}
                            onClick={() => open("cancel", lesson)}
                            data-writes="DRIFT"
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
      </SectionCard>

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

      {/* Every lesson in the list is cancelled and every class told: asked
          first, with the count, as the cover board asks before a bulk cancel. */}
      <ConfirmDialog
        open={confirmingAll}
        onOpenChange={(next) => !bulkBusy && setConfirmingAll(next)}
        title={t("cancelAllTitle", { count: shown })}
        description={t("cancelAllBody")}
        confirmLabel={t("cancelAllConfirm", { count: shown })}
        loading={bulkBusy}
        onConfirm={() => void cancelAll()}
      />

      {dialogsMounted ? (
        <DialogLoadBoundary
          key={dialogLoad}
          onError={() => {
            toast.error(tDay("dialogLoadFailed"));
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
              onSubstitute={(lesson, teacher, note) => void doSubstitute(lesson, teacher, note)}
              onChangeRoom={(lesson, roomId) => void doChangeRoom(lesson, roomId)}
              suggestions={{
                loading: suggestionsQuery.isLoading,
                items: suggestionsQuery.data ?? [],
              }}
            />
          </Suspense>
        </DialogLoadBoundary>
      ) : null}
    </Page>
  );
}
