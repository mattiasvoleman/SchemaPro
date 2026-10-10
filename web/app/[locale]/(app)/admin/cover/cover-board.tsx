"use client";

import { Fragment, Suspense, lazy, useEffect, useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  CalendarClock,
  CalendarX2,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  Sparkles,
  Undo2,
  UserPlus,
  Users,
} from "lucide-react";
import type { MessageLookup } from "@/lib/engine-message";
import { savedToast } from "@/lib/staffing-warnings";
import { useGroups, usePeople, useRooms, useSubjects } from "@/lib/queries";
import { useCoverActions, useCoverBoard, useCoverCounter } from "@/lib/cover-queries";
import type { BoardItem, BulkInput, CounterRow, CoverDecisionKind } from "@/lib/cover-types";
import { shiftDate } from "@/lib/cover-absence-form";
import {
  absentIds,
  bulkEligible,
  bulkItems,
  chainLookup,
  coverErrorText,
  errorCode,
  groupByDate,
  groupByLesson,
  pairActions,
  pairKey,
  statusKey,
  weekOf,
  type StatusKey,
} from "@/lib/cover-view";
import { formatTime, isoWeek, toDateString } from "@/lib/utils";
import { useCoverRealtime } from "./use-cover-realtime";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DateField } from "@/components/ui/date-field";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/*
 * The candidates and the day proposal are React.lazy and mounted on their
 * first click (not next/dynamic, whose loader costs 1.4KB of its own): an
 * admin reading the board downloads neither, and the socket is a further
 * import() inside use-cover-realtime.ts.
 */
const CandidatesDialog = lazy(() =>
  import("./candidates-dialog").then((module) => ({ default: module.CandidatesDialog })),
);
const ProposalDialog = lazy(() =>
  import("./proposal-dialog").then((module) => ({ default: module.ProposalDialog })),
);

const STATUS_VARIANT: Record<StatusKey, "warning" | "success" | "secondary" | "outline" | "destructive"> = {
  OPEN: "warning",
  COVERED: "success",
  CANCELLED: "secondary",
  HANDLED_SUPERVISED_STUDY: "secondary",
  HANDLED_CO_TEACHER: "secondary",
  PASSED: "destructive",
};

/** The clock the buttons follow, a minute at a time: a lesson that starts closes its cancel. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function CounterPanel({ date, nameOf }: { date: string; nameOf: (id: string) => string }) {
  const t = useTranslations("coverBoard");
  const { data } = useCoverCounter(date);
  const rows = [...(data?.rows ?? [])].sort(
    (a: CounterRow, b: CounterRow) =>
      b.weekLessons - a.weekLessons || b.termLessons - a.termLessons || a.userId.localeCompare(b.userId),
  );
  const weekLessons = rows.reduce((sum, row) => sum + row.weekLessons, 0);
  const weekMinutes = rows.reduce((sum, row) => sum + row.weekMinutes, 0);
  return (
    <aside className="space-y-2 rounded-lg border bg-card p-3" aria-label={t("counterTitle")}>
      <h2 className="flex items-center gap-1.5 text-sm font-semibold">
        <Users className="h-4 w-4" />
        {t("counterTitle")}
      </h2>
      <p className="text-xs text-muted-foreground">{t("counterBody")}</p>
      <p className="text-sm font-medium">{t("weekHours", { lessons: weekLessons, minutes: weekMinutes })}</p>
      {rows.length === 0 ? (
        <p className="text-sm italic text-muted-foreground">{t("counterEmpty")}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="font-normal">{t("counterName")}</th>
              <th className="text-right font-normal">{t("counterWeek")}</th>
              <th className="text-right font-normal">{t("counterTerm")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 12).map((row) => (
              <tr key={row.userId}>
                <td className="py-0.5">
                  {nameOf(row.userId)}
                  {row.kind === "POOL" ? (
                    <Badge variant="outline" className="ml-1">
                      {t("pool")}
                    </Badge>
                  ) : null}
                </td>
                <td className="text-right tabular-nums">{row.weekLessons}</td>
                <td className="text-right tabular-nums">{row.termLessons}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </aside>
  );
}

/**
 * Vikarietavla: every lesson that needs cover across all absences, a day or
 * an ISO week at a time, with a status per absent person and the decisions
 * the gateway allows — tillsätt, ställ in (TEACHER_UNAVAILABLE, no reason
 * sent), självstudier under tillsyn, medläraren håller, ångra — one at a time
 * or in bulk, and "Fördela dagen" for the whole day.
 *
 * Nothing here says why anyone is away. The board's rows carry no reason, no
 * reasonId and no note (the gateway's BoardItem); the register is where an
 * admin reads one.
 */
export function CoverBoard({ initialDate, initialView }: { initialDate: string | null; initialView: "day" | "week" }) {
  const t = useTranslations("coverBoard");
  const tStatus = useTranslations("coverStatus");
  const tErrors = useTranslations("coverErrors") as unknown as MessageLookup;
  const tEngine = useTranslations("engineMessages") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const tWarnings = chainLookup(tErrors, tEngine);

  const [date, setDate] = useState(() => initialDate ?? toDateString(new Date()));
  const [view, setView] = useState<"day" | "week">(initialView);
  const range = view === "day" ? { from: date, to: date } : weekOf(date);
  const now = useMinuteClock();

  const { data: board, isLoading, dataUpdatedAt } = useCoverBoard(range.from, range.to);
  const { data: people } = usePeople();
  const { data: subjects } = useSubjects();
  const { data: groups } = useGroups();
  const { data: rooms } = useRooms();
  const { decide, undo, bulk } = useCoverActions();
  useCoverRealtime(range);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [candidatesFor, setCandidatesFor] = useState<BoardItem | null>(null);
  const [candidatesMounted, setCandidatesMounted] = useState(false);
  const [proposalOpen, setProposalOpen] = useState(false);
  const [proposalMounted, setProposalMounted] = useState(false);
  const [cancelling, setCancelling] = useState<BoardItem | null>(null);
  const [confirmingBulk, setConfirmingBulk] = useState<"CANCELLED" | "UNDO" | null>(null);
  // When a write met a DRAFT publish in progress (0 = no banner). The banner
  // goes with the next read of the board after it — a realtime refetch on
  // master_timetable_updated, the poll, another day — or the next write.
  const [publishingSince, setPublishingSince] = useState(0);
  const publishing = publishingSince > 0;
  const setPublishing = (on: boolean) => setPublishingSince(on ? Date.now() : 0);
  useEffect(() => {
    if (publishingSince > 0 && dataUpdatedAt > publishingSince) setPublishingSince(0);
  }, [dataUpdatedAt, publishingSince]);

  // The choice lives in the URL, written without navigating (reports-tabs.tsx).
  useEffect(() => {
    const url = new URL(globalThis.location.href);
    url.searchParams.set("date", date);
    if (view === "week") url.searchParams.set("view", "week");
    else url.searchParams.delete("view");
    globalThis.history.replaceState(globalThis.history.state, "", url);
    setSelected(new Set());
  }, [date, view]);

  const personName = useMemo(
    () => new Map((people ?? []).map((person) => [person.id, `${person.firstName} ${person.lastName}`])),
    [people],
  );
  const nameOf = (id: string) => personName.get(id) ?? "—";
  const subjectName = useMemo(() => new Map((subjects ?? []).map((s) => [s.id, s.name])), [subjects]);
  const groupName = useMemo(() => new Map((groups ?? []).map((g) => [g.id, g.name])), [groups]);
  const roomName = useMemo(() => new Map((rooms ?? []).map((r) => [r.id, r.name])), [rooms]);
  const teachers = useMemo(
    () =>
      (people ?? [])
        .filter((person) => person.role === "TEACHER" && person.isActive)
        .map((person) => ({ id: person.id, name: `${person.firstName} ${person.lastName}` })),
    [people],
  );

  const items = useMemo(() => board?.items ?? [], [board]);
  const lessons = useMemo(() => groupByLesson(items), [items]);
  const days = useMemo(() => groupByDate(lessons), [lessons]);
  const lessonById = useMemo(() => new Map(lessons.map((lesson) => [lesson.lessonId, lesson])), [lessons]);

  const timeText = (item: { startsAt: string; endsAt: string }) =>
    `${formatTime(item.startsAt)}–${formatTime(item.endsAt)}`;
  const groupText = (lesson: { studentGroupId: string; extraGroupIds: string[] }) =>
    [lesson.studentGroupId, ...lesson.extraGroupIds].map((id) => groupName.get(id) ?? "—").join(", ");
  const lessonText = (lessonId: string) => {
    const lesson = lessonById.get(lessonId);
    if (!lesson) return "—";
    return `${timeText(lesson)} · ${subjectName.get(lesson.subjectId) ?? "—"} · ${groupText(lesson)}`;
  };
  const dayText = (day: string) =>
    new Date(`${day}T12:00:00`).toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" });

  const failed = (error: unknown) => {
    const code = errorCode(error);
    if (code === "PUBLISH_IN_PROGRESS") setPublishing(true);
    toast.error(
      code === "COVER_STALE" ? t("staleRefetched") : coverErrorText(tErrors, error, tCommon("error")),
    );
  };

  const runDecision = async (item: BoardItem, kind: CoverDecisionKind, substituteId?: string) => {
    try {
      const result = await decide.mutateAsync({
        lessonId: item.lessonId,
        absenceId: item.absenceId,
        kind,
        ...(substituteId ? { substituteId } : {}),
        expected: item.status,
      });
      setPublishing(false);
      if (kind === "SUBSTITUTE") {
        savedToast(tWarnings, t("toastCovered"), result.warnings);
        setCandidatesFor(null);
      } else {
        toast.success(t(`toast.${kind}`));
      }
    } catch (error) {
      failed(error);
    }
  };

  const runUndo = async (item: BoardItem) => {
    try {
      await undo.mutateAsync({ lessonId: item.lessonId, absenceId: item.absenceId });
      setPublishing(false);
      toast.success(t("toastUndone"));
    } catch (error) {
      failed(error);
    }
  };

  const runBulk = async (action: BulkInput["action"]) => {
    const chosen = bulkItems(action, items, selected, now);
    if (chosen.length === 0) return;
    try {
      const result = await bulk.mutateAsync({ action, items: chosen });
      setPublishing(false);
      setSelected(new Set());
      toast.success(t("bulkDone", { count: result.done }));
    } catch (error) {
      failed(error);
    }
  };

  const selectedItems = items.filter((item) => selected.has(pairKey(item)));
  const eligible = (action: BulkInput["action"]) =>
    selectedItems.filter((item) => bulkEligible(action, item, now)).length;
  const toggle = (item: BoardItem, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(pairKey(item));
      else next.delete(pairKey(item));
      return next;
    });

  const move = (step: number) => setDate((current) => shiftDate(current, view === "day" ? step : step * 7));
  const busy = decide.isPending || undo.isPending || bulk.isPending;
  const summary = board?.summary;

  const renderLesson = (lesson: (typeof lessons)[number], index: number) => {
    const absent = absentIds(lesson);
    return lesson.pairs.map((item, pairIndex) => {
      const actions = pairActions(item, now, absent);
      const key = statusKey(item);
      const first = pairIndex === 0;
      return (
        <TableRow key={pairKey(item)} className={first && index > 0 ? "border-t-2" : undefined}>
          <TableCell className="w-8">
            <input
              type="checkbox"
              aria-label={t("selectPair", { teacher: nameOf(item.absentTeacherId), lesson: lessonText(item.lessonId) })}
              checked={selected.has(pairKey(item))}
              onChange={(event) => toggle(item, event.target.checked)}
            />
          </TableCell>
          <TableCell className="whitespace-nowrap tabular-nums">{first ? timeText(lesson) : null}</TableCell>
          <TableCell>{first ? groupText(lesson) : null}</TableCell>
          <TableCell className="font-medium">{first ? (subjectName.get(lesson.subjectId) ?? "—") : null}</TableCell>
          <TableCell>{first ? (lesson.roomId ? (roomName.get(lesson.roomId) ?? "—") : "—") : null}</TableCell>
          <TableCell>{nameOf(item.absentTeacherId)}</TableCell>
          <TableCell>
            <Badge variant={STATUS_VARIANT[key]}>{tStatus(key)}</Badge>
            {item.status === "CANCELLED" && item.cancelCause ? (
              <span className="block text-xs text-muted-foreground">{t(`causes.${item.cancelCause}`)}</span>
            ) : null}
            {item.decisionStale ? (
              <span className="block text-xs text-muted-foreground">{t("decisionStale")}</span>
            ) : null}
            {item.outsideAbsence ? (
              <span className="block text-xs text-muted-foreground">{t("outsideAbsence")}</span>
            ) : null}
          </TableCell>
          <TableCell>{item.substituteId ? nameOf(item.substituteId) : "—"}</TableCell>
          <TableCell className="text-right">
            <div className="flex flex-wrap justify-end gap-1.5">
              {actions.coTeacherFirst ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void runDecision(item, "CO_TEACHER")}>
                  {t("coTeacher")}
                </Button>
              ) : null}
              {actions.assign ? (
                <Button
                  size="sm"
                  variant={actions.coTeacherFirst ? "outline" : "default"}
                  disabled={busy}
                  onClick={() => {
                    setCandidatesMounted(true);
                    setCandidatesFor(item);
                  }}
                >
                  <UserPlus />
                  {t("assign")}
                </Button>
              ) : null}
              {actions.cancel ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-destructive"
                  disabled={busy}
                  onClick={() => setCancelling(item)}
                >
                  <CalendarX2 />
                  {t("cancel")}
                </Button>
              ) : null}
              {actions.supervised ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="ghost" aria-label={t("more")} disabled={busy}>
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => void runDecision(item, "SUPERVISED_STUDY")}>
                      {t("supervised")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              {actions.undo ? (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void runUndo(item)}>
                  <Undo2 />
                  {t("undo")}
                </Button>
              ) : null}
            </div>
          </TableCell>
        </TableRow>
      );
    });
  };

  const week = isoWeek(new Date(`${date}T12:00:00`));

  return (
    <div>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Tabs value={view} onValueChange={(value) => setView(value === "week" ? "week" : "day")}>
          <TabsList aria-label={t("viewLabel")}>
            <TabsTrigger value="day">{t("day")}</TabsTrigger>
            <TabsTrigger value="week">{t("week")}</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-end gap-1">
          <Button variant="outline" size="icon" aria-label={t("previous")} onClick={() => move(-1)}>
            <ChevronLeft />
          </Button>
          <DateField
            label={t("date")}
            aria-label={t("date")}
            className="w-40"
            value={date}
            onChange={(value) => value && setDate(value)}
          />
          <Button variant="outline" size="icon" aria-label={t("next")} onClick={() => move(1)}>
            <ChevronRight />
          </Button>
          <Button variant="ghost" onClick={() => setDate(toDateString(new Date()))}>
            {tCommon("today")}
          </Button>
        </div>
        <span className="pb-2 text-sm text-muted-foreground">
          {view === "day" ? dayText(date) : t("weekLabel", { week })}
        </span>
        {view === "day" ? (
          <Button
            className="ml-auto"
            onClick={() => {
              setProposalMounted(true);
              setProposalOpen(true);
            }}
            disabled={!summary || summary.open === 0}
          >
            <Sparkles />
            {t("distributeDay")}
          </Button>
        ) : null}
      </div>

      {summary ? (
        <div className="mb-3 flex flex-wrap gap-2" aria-label={t("summaryLabel")}>
          <Badge variant="warning">{t("summaryOpen", { count: summary.open })}</Badge>
          <Badge variant="success">{t("summaryCovered", { count: summary.covered })}</Badge>
          <Badge variant="secondary">{t("summaryCancelled", { count: summary.cancelled })}</Badge>
          <Badge variant="secondary">{t("summaryHandled", { count: summary.handled })}</Badge>
          {summary.passedOpen > 0 ? (
            <Badge variant="destructive">{t("summaryPassedOpen", { count: summary.passedOpen })}</Badge>
          ) : null}
        </div>
      ) : null}

      {publishing ? (
        <p role="status" className="mb-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          {t("publishing")}
        </p>
      ) : null}

      {selected.size > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <span className="font-medium">{t("bulkSelected", { count: selected.size })}</span>
          <Button size="sm" variant="outline" disabled={busy || eligible("CANCELLED") === 0} onClick={() => setConfirmingBulk("CANCELLED")}>
            {t("bulkCancel", { count: eligible("CANCELLED") })}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || eligible("SUPERVISED_STUDY") === 0}
            onClick={() => void runBulk("SUPERVISED_STUDY")}
          >
            {t("bulkSupervised", { count: eligible("SUPERVISED_STUDY") })}
          </Button>
          <Button size="sm" variant="outline" disabled={busy || eligible("UNDO") === 0} onClick={() => setConfirmingBulk("UNDO")}>
            {t("bulkUndo", { count: eligible("UNDO") })}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            {t("bulkClear")}
          </Button>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div>
          {isLoading ? (
            <Skeleton className="h-72 w-full" />
          ) : lessons.length === 0 ? (
            <EmptyState icon={CalendarClock} title={t("emptyTitle")} description={t("emptyBody")} />
          ) : (
            <div className="rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8">
                      <span className="sr-only">{t("columnSelect")}</span>
                    </TableHead>
                    <TableHead>{tCommon("time")}</TableHead>
                    <TableHead>{tCommon("group")}</TableHead>
                    <TableHead>{tCommon("subject")}</TableHead>
                    <TableHead>{tCommon("room")}</TableHead>
                    <TableHead>{t("columnAbsent")}</TableHead>
                    <TableHead>{tCommon("status")}</TableHead>
                    <TableHead>{t("columnSubstitute")}</TableHead>
                    <TableHead className="text-right">{tCommon("actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view === "day"
                    ? lessons.map((lesson, index) => renderLesson(lesson, index))
                    : days.map((day) => (
                        <Fragment key={day.date}>
                          <TableRow className="bg-muted/40 hover:bg-muted/40">
                            <TableCell colSpan={9} className="py-1.5 text-sm font-semibold capitalize">
                              {dayText(day.date)}
                            </TableCell>
                          </TableRow>
                          {day.lessons.map((lesson, index) => renderLesson(lesson, index))}
                        </Fragment>
                      ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
        <CounterPanel date={date} nameOf={nameOf} />
      </div>

      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={(open) => !open && setCancelling(null)}
        title={t("cancelTitle")}
        description={cancelling ? t("cancelBody", { lesson: lessonText(cancelling.lessonId) }) : undefined}
        confirmLabel={t("cancel")}
        loading={decide.isPending}
        onConfirm={() => {
          const item = cancelling;
          setCancelling(null);
          if (item) void runDecision(item, "CANCELLED");
        }}
      />

      {/* A bulk cancel tells every class and guardian; a bulk undo reopens
          every lesson. Each is asked first, with the count, as one cancel is. */}
      <ConfirmDialog
        open={confirmingBulk !== null}
        onOpenChange={(open) => !open && setConfirmingBulk(null)}
        title={
          confirmingBulk === "CANCELLED"
            ? t("bulkCancelTitle", { count: eligible("CANCELLED") })
            : t("bulkUndoTitle", { count: eligible("UNDO") })
        }
        description={confirmingBulk === "CANCELLED" ? t("bulkCancelBody") : t("bulkUndoBody")}
        confirmLabel={confirmingBulk === "CANCELLED" ? t("cancel") : t("undo")}
        loading={bulk.isPending}
        onConfirm={() => {
          const action = confirmingBulk;
          setConfirmingBulk(null);
          if (action) void runBulk(action);
        }}
      />

      {candidatesMounted ? (
        <Suspense fallback={null}>
          <CandidatesDialog
            item={candidatesFor}
            lessonText={candidatesFor ? lessonText(candidatesFor.lessonId) : ""}
            nameOf={nameOf}
            teachers={teachers}
            pending={decide.isPending}
            onOpenChange={(open) => !open && setCandidatesFor(null)}
            onAssign={(item, substituteId) => void runDecision(item, "SUBSTITUTE", substituteId)}
          />
        </Suspense>
      ) : null}

      {proposalMounted ? (
        <Suspense fallback={null}>
          <ProposalDialog
            open={proposalOpen}
            onOpenChange={setProposalOpen}
            date={date}
            dateText={dayText(date)}
            lessonText={lessonText}
            absentName={(lessonId, absenceId) =>
              nameOf(items.find((item) => item.lessonId === lessonId && item.absenceId === absenceId)?.absentTeacherId ?? "")
            }
            nameOf={nameOf}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
