"use client";

import { Fragment, Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  BookOpen,
  CalendarClock,
  CalendarX2,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  Sparkles,
  Undo2,
  UserCheck,
  UserPlus,
  Users,
  type LucideIcon,
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
  type LessonGroup,
  type PairActions,
} from "@/lib/cover-view";
import { COVER_STATUS_VARIANT } from "@/lib/status-variants";
import { isoWeek, toDateString } from "@/lib/utils";
import { useCoverRealtime } from "./use-cover-realtime";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DateField } from "@/components/ui/date-field";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar, FilterField } from "@/components/ui/filter-bar";
import { KpiStrip, KpiTile } from "@/components/ui/kpi";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCard } from "@/components/ui/table-card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
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
/*
 * An absent rastvakt's passes (Rastvakt i vardagen), lazy too: mounted when
 * the board has one, so a school without a rastvaktsschema downloads none of
 * it, nor its candidates dialog.
 */
const SupervisionPasses = lazy(() =>
  import("./supervision-passes").then((module) => ({ default: module.SupervisionPasses })),
);

/** The clock the buttons follow, a minute at a time: a lesson that starts closes its cancel. */
function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

interface PairMenuItem {
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
}

/**
 * A pair's quieter decisions — Ställ in, Självstudier under tillsyn, and Ångra
 * beside an open lesson — behind "Fler val". The chosen item runs once the
 * menu has closed (components/ui/row-actions.tsx): Ställ in opens a
 * ConfirmDialog, and opened from onSelect it mounted while the menu's focus
 * trap still held, so focus fell to <body> when the dialog closed. Run from
 * onCloseAutoFocus, focus is back on "Fler val …" first, and the dialog hands
 * it back there.
 */
function PairMenu({ label, items, disabled }: { label: string; items: PairMenuItem[]; disabled: boolean }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const chosen = useRef<(() => void) | null>(null);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button ref={trigger} type="button" size="icon" variant="ghost" className="size-8" aria-label={label} disabled={disabled}>
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={(event) => {
          const action = chosen.current;
          chosen.current = null;
          if (!action) return;
          event.preventDefault();
          trigger.current?.focus();
          action();
        }}
      >
        {items.map((item) => (
          <DropdownMenuItem
            key={item.label}
            onSelect={() => {
              chosen.current = item.onSelect;
            }}
          >
            <item.icon aria-hidden="true" />
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The rail beside the board: who has covered how much, which also orders the suggestions. */
function CounterPanel({ date, nameOf }: { date: string; nameOf: (id: string) => string }) {
  const t = useTranslations("coverBoard");
  const { data, isLoading, isError } = useCoverCounter(date);
  const rows = [...(data?.rows ?? [])].sort(
    (a: CounterRow, b: CounterRow) =>
      b.weekLessons - a.weekLessons || b.termLessons - a.termLessons || a.userId.localeCompare(b.userId),
  );
  const weekLessons = rows.reduce((sum, row) => sum + row.weekLessons, 0);
  const weekMinutes = rows.reduce((sum, row) => sum + row.weekMinutes, 0);
  return (
    <SectionCard id="cover-counter" title={t("counterTitle")} icon={Users} description={t("counterBody")}>
      {isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-16 w-full" />
        </div>
      ) : isError ? (
        <LoadError variant="inline" title={t("counterLoadFailed")} hint={t("counterLoadFailedHint")} />
      ) : (
        <>
          <p className="text-sm font-medium">{t("weekHours", { lessons: weekLessons, minutes: weekMinutes })}</p>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("counterEmpty")}</p>
          ) : (
            <table className="w-full text-sm">
              <caption className="sr-only">{t("counterTitle")}</caption>
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    {t("counterName")}
                  </th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                    {t("counterWeek")}
                  </th>
                  <th scope="col" className="py-1.5 text-right font-medium">
                    {t("counterTerm")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 12).map((row) => (
                  <tr key={row.userId}>
                    <td className="py-1.5 pr-3">
                      {nameOf(row.userId)}
                      {row.kind === "POOL" ? (
                        <Badge variant="outline" className="ml-1">
                          {t("pool")}
                        </Badge>
                      ) : null}
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{row.weekLessons}</td>
                    <td className="py-1.5 text-right tabular-nums">{row.termLessons}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </SectionCard>
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
  const tDay = useTranslations("dayPlanner");
  const locale = useLocale();
  const tWarnings = chainLookup(tErrors, tEngine);

  const [date, setDate] = useState(() => initialDate ?? toDateString(new Date()));
  const [view, setView] = useState<"day" | "week">(initialView);
  const range = view === "day" ? { from: date, to: date } : weekOf(date);
  const now = useMinuteClock();

  // isError is read: a board that cannot be read must never look like a
  // morning with nothing to cover.
  const { data: board, isLoading, isError, dataUpdatedAt } = useCoverBoard(range.from, range.to);
  const peopleQuery = usePeople();
  const subjectsQuery = useSubjects();
  const groupsQuery = useGroups();
  const roomsQuery = useRooms();
  const people = peopleQuery.data;
  const subjects = subjectsQuery.data;
  const groups = groupsQuery.data;
  const rooms = roomsQuery.data;
  const lookupsFailed =
    peopleQuery.isError || subjectsQuery.isError || groupsQuery.isError || roomsQuery.isError;
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
  const passes = useMemo(() => board?.supervision ?? [], [board]);
  const lessons = useMemo(() => groupByLesson(items), [items]);
  const days = useMemo(() => groupByDate(lessons), [lessons]);
  const lessonById = useMemo(() => new Map(lessons.map((lesson) => [lesson.lessonId, lesson])), [lessons]);

  // The reader's clock in the app's language, 24-hour as everywhere in the app.
  const clock = useMemo(
    () => new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }),
    [locale],
  );
  const timeText = (item: { startsAt: string; endsAt: string }) =>
    `${clock.format(new Date(item.startsAt))}–${clock.format(new Date(item.endsAt))}`;
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

  const dash = <span className="text-muted-foreground">—</span>;
  const roomText = (lesson: LessonGroup) => (lesson.roomId ? (roomName.get(lesson.roomId) ?? null) : null);
  const pairLabel = (item: BoardItem) =>
    t("selectPair", { teacher: nameOf(item.absentTeacherId), lesson: lessonText(item.lessonId) });

  /** Why a decided pair reads as it does: the cancel's cause, a stale decision, a lesson now outside the absence. */
  const noted = new Set(board?.notedLessonIds ?? []);
  const pairNotes = (item: BoardItem) => (
    <>
      {/* Lektionslogg: that the lesson's own teacher left the substitute a
          note, which the substitute reads on the lesson; never what it says. */}
      {noted.has(item.lessonId) ? (
        <span className="block whitespace-normal text-xs text-muted-foreground" title={t("notedHint")}>
          {t("noted")}
        </span>
      ) : null}
      {item.status === "CANCELLED" && item.cancelCause ? (
        <span className="block whitespace-normal text-xs text-muted-foreground">{t(`causes.${item.cancelCause}`)}</span>
      ) : null}
      {item.decisionStale ? (
        <span className="block whitespace-normal text-xs text-muted-foreground">{t("decisionStale")}</span>
      ) : null}
      {item.outsideAbsence ? (
        <span className="block whitespace-normal text-xs text-muted-foreground">{t("outsideAbsence")}</span>
      ) : null}
    </>
  );

  /**
   * One pair's decisions, the same in the table and the phone list. In sight:
   * "Tillsätt vikarie" as an outline button — "Fördela dagen" in the header
   * is the page's one primary — with "Medläraren håller" before it when a
   * co-teacher stays (it goes first, review amendment L), and Ångra when it is
   * a decided lesson's only way on. The rest — Ställ in, Självstudier under
   * tillsyn, Ångra beside an open lesson — under "Fler val".
   */
  const pairControls = (item: BoardItem, actions: PairActions, className: string) => {
    // Every button names its pair, as the checkbox does: "Fler val Anna Lind: 08:00–09:00 · Matematik · 7A".
    const pairName = `${nameOf(item.absentTeacherId)}: ${lessonText(item.lessonId)}`;
    const named = (action: string) => tCommon("actionNamed", { action, name: pairName });
    const undoInSight = actions.undo && !actions.assign;
    const menu: PairMenuItem[] = [];
    // Neutral in the menu: the confirmation Ställ in opens carries the red.
    if (actions.cancel) menu.push({ label: t("cancel"), icon: CalendarX2, onSelect: () => setCancelling(item) });
    if (actions.supervised) {
      menu.push({ label: t("supervised"), icon: BookOpen, onSelect: () => void runDecision(item, "SUPERVISED_STUDY") });
    }
    if (actions.undo && !undoInSight) menu.push({ label: t("undo"), icon: Undo2, onSelect: () => void runUndo(item) });
    if (!actions.assign && !undoInSight && menu.length === 0) return null;
    // Every one of them is a decision, Drift's (POST/DELETE /cover/lessons/:id/decision).
    return (
      <div className={className} data-writes="DRIFT">
        {actions.coTeacherFirst ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            aria-label={named(t("coTeacher"))}
            onClick={() => void runDecision(item, "CO_TEACHER")}
          >
            <UserCheck />
            {t("coTeacher")}
          </Button>
        ) : null}
        {actions.assign ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            aria-label={named(t("assign"))}
            onClick={() => {
              setCandidatesMounted(true);
              setCandidatesFor(item);
            }}
          >
            <UserPlus />
            {t("assign")}
          </Button>
        ) : null}
        {undoInSight ? (
          <Button size="sm" variant="ghost" disabled={busy} aria-label={named(t("undo"))} onClick={() => void runUndo(item)}>
            <Undo2 />
            {t("undo")}
          </Button>
        ) : null}
        {menu.length > 0 ? <PairMenu label={named(t("more"))} items={menu} disabled={busy} /> : null}
      </div>
    );
  };

  const renderLesson = (lesson: LessonGroup, index: number) => {
    const absent = absentIds(lesson);
    return lesson.pairs.map((item, pairIndex) => {
      const actions = pairActions(item, now, absent);
      const key = statusKey(item);
      const first = pairIndex === 0;
      const room = roomText(lesson);
      return (
        <TableRow key={pairKey(item)} className={first && index > 0 ? "border-t-2" : undefined}>
          <TableCell className="w-8">
            {/* A pair is chosen only for the bulk decisions, Drift's. */}
            <input
              type="checkbox"
              aria-label={pairLabel(item)}
              checked={selected.has(pairKey(item))}
              onChange={(event) => toggle(item, event.target.checked)}
              data-writes="DRIFT"
            />
          </TableCell>
          <TableCell className="whitespace-nowrap tabular-nums">{first ? timeText(lesson) : null}</TableCell>
          <TableCell>{first ? groupText(lesson) : null}</TableCell>
          <TableCell className="font-medium">{first ? (subjectName.get(lesson.subjectId) ?? "—") : null}</TableCell>
          <TableCell className="whitespace-nowrap">{first ? (room ?? dash) : null}</TableCell>
          <TableCell className="whitespace-nowrap">{nameOf(item.absentTeacherId)}</TableCell>
          <TableCell className="whitespace-nowrap">
            <Badge variant={COVER_STATUS_VARIANT[key]}>{tStatus(key)}</Badge>
            {pairNotes(item)}
          </TableCell>
          <TableCell className="whitespace-nowrap">{item.substituteId ? nameOf(item.substituteId) : dash}</TableCell>
          <TableCell className="text-right">
            {pairControls(item, actions, "flex items-center justify-end gap-1")}
          </TableCell>
        </TableRow>
      );
    });
  };

  /**
   * Below sm the same pairs as a list, one item per pair: the lesson on the
   * first line, where it is, who is away and its state on the second, then
   * its decisions. Same data, handlers and labels as the table, which a
   * phone could only scroll sideways through nine columns.
   */
  const renderLessonItems = (lesson: LessonGroup) => {
    const absent = absentIds(lesson);
    const room = roomText(lesson);
    return lesson.pairs.map((item) => {
      const actions = pairActions(item, now, absent);
      const key = statusKey(item);
      const controls = pairControls(item, actions, "flex flex-wrap items-center gap-1 pt-1");
      return (
        <li key={pairKey(item)} className="flex gap-3 px-3 py-2 text-sm">
          {/* The label widens the box's hit area to a thumb's; the name is the input's own. */}
          <label className="-m-2 flex shrink-0 cursor-pointer self-start p-2" data-writes="DRIFT">
            <input
              type="checkbox"
              className="mt-0.5 size-4"
              aria-label={pairLabel(item)}
              checked={selected.has(pairKey(item))}
              onChange={(event) => toggle(item, event.target.checked)}
            />
          </label>
          <div className="min-w-0 flex-1 space-y-1">
            <p className="font-medium">
              <span className="tabular-nums">{timeText(lesson)}</span>
              {` · ${groupText(lesson)} · ${subjectName.get(lesson.subjectId) ?? "—"}`}
            </p>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-muted-foreground">
                {[room, nameOf(item.absentTeacherId)].filter(Boolean).join(" · ")}
              </span>
              <Badge variant={COVER_STATUS_VARIANT[key]}>{tStatus(key)}</Badge>
            </div>
            {item.substituteId ? (
              <p className="text-muted-foreground">{t("substituteLine", { name: nameOf(item.substituteId) })}</p>
            ) : null}
            {pairNotes(item)}
            {controls}
          </div>
        </li>
      );
    });
  };

  const week = isoWeek(new Date(`${date}T12:00:00`));

  return (
    <Page>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          view === "day" ? (
            <Button
              onClick={() => {
                setProposalMounted(true);
                setProposalOpen(true);
              }}
              disabled={!summary || summary.open === 0}
              data-writes="DRIFT"
            >
              <Sparkles />
              {t("distributeDay")}
            </Button>
          ) : null
        }
      />

      <FilterBar>
        <Tabs value={view} onValueChange={(value) => setView(value === "week" ? "week" : "day")}>
          <TabsList aria-label={t("viewLabel")}>
            <TabsTrigger value="day">{t("day")}</TabsTrigger>
            <TabsTrigger value="week">{t("week")}</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-end gap-2">
          <Button variant="outline" size="icon" aria-label={t("previous")} onClick={() => move(-1)}>
            <ChevronLeft />
          </Button>
          <FilterField id="cover-date" label={t("date")}>
            <DateField
              id="cover-date"
              label={t("date")}
              className="w-40"
              value={date}
              onChange={(value) => value && setDate(value)}
            />
          </FilterField>
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
      </FilterBar>

      {lookupsFailed ? (
        <LoadError variant="inline" title={tDay("lookupsFailed")} hint={tDay("lookupsFailedHint")} />
      ) : null}

      {summary && !isError ? (
        <KpiStrip columns={5}>
          <KpiTile label={t("kpiOpen")} value={summary.open} />
          <KpiTile label={t("kpiCovered")} value={summary.covered} />
          <KpiTile label={t("kpiCancelled")} value={summary.cancelled} />
          <KpiTile label={t("kpiHandled")} value={summary.handled} />
          <KpiTile label={t("kpiPassed")} value={summary.passedOpen} />
        </KpiStrip>
      ) : null}

      {publishing ? <Notice tone="warning">{t("publishing")}</Notice> : null}

      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
          <span className="font-medium">{t("bulkSelected", { count: selected.size })}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || eligible("CANCELLED") === 0}
            onClick={() => setConfirmingBulk("CANCELLED")}
            data-writes="DRIFT"
          >
            {t("bulkCancel", { count: eligible("CANCELLED") })}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || eligible("SUPERVISED_STUDY") === 0}
            onClick={() => void runBulk("SUPERVISED_STUDY")}
            data-writes="DRIFT"
          >
            {t("bulkSupervised", { count: eligible("SUPERVISED_STUDY") })}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || eligible("UNDO") === 0}
            onClick={() => setConfirmingBulk("UNDO")}
            data-writes="DRIFT"
          >
            {t("bulkUndo", { count: eligible("UNDO") })}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            {t("bulkClear")}
          </Button>
        </div>
      ) : null}

      {/* The rail sits beside the board only from xl: next to a 20rem rail the
          nine columns scrolled sideways on a laptop. Below, it follows the board. */}
      <div className="grid gap-4 2xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0">
          {isLoading ? (
            <div aria-busy="true">
              <Skeleton className="h-64 w-full" />
            </div>
          ) : isError ? (
            <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
          ) : lessons.length === 0 && passes.length === 0 ? (
            <EmptyState icon={CalendarClock} title={t("emptyTitle")} description={t("emptyBody")} headingLevel={2} />
          ) : lessons.length === 0 ? null : (
            <>
              {/* Two renderings split by CSS alone, no matchMedia: the list on a
                  phone, the table from sm. display:none takes the other out of
                  the accessibility tree. */}
              <ul aria-label={t("tableCaption")} className="divide-y rounded-md border bg-card sm:hidden">
                {view === "day"
                  ? lessons.flatMap((lesson) => renderLessonItems(lesson))
                  : days.map((day) => (
                      <Fragment key={day.date}>
                        <li className="bg-muted/40 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          {dayText(day.date)}
                        </li>
                        {day.lessons.flatMap((lesson) => renderLessonItems(lesson))}
                      </Fragment>
                    ))}
              </ul>
              <TableCard caption={t("tableCaption")} className="hidden sm:block">
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col" className="w-8">
                      <span className="sr-only">{t("columnSelect")}</span>
                    </TableHead>
                    <TableHead scope="col">{tCommon("time")}</TableHead>
                    <TableHead scope="col">{tCommon("group")}</TableHead>
                    <TableHead scope="col">{tCommon("subject")}</TableHead>
                    <TableHead scope="col">{tCommon("room")}</TableHead>
                    <TableHead scope="col">{t("columnAbsent")}</TableHead>
                    <TableHead scope="col">{tCommon("status")}</TableHead>
                    <TableHead scope="col">{t("columnSubstitute")}</TableHead>
                    <TableHead scope="col" className="text-right">
                      {tCommon("actions")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view === "day"
                    ? lessons.map((lesson, index) => renderLesson(lesson, index))
                    : days.map((day) => (
                        <Fragment key={day.date}>
                          <TableRow className="bg-muted/40 hover:bg-muted/40">
                            <TableCell
                              colSpan={9}
                              className="py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                            >
                              {dayText(day.date)}
                            </TableCell>
                          </TableRow>
                          {day.lessons.map((lesson, index) => renderLesson(lesson, index))}
                        </Fragment>
                      ))}
                </TableBody>
              </TableCard>
            </>
          )}
          {!isLoading && !isError && passes.length > 0 ? (
            <Suspense fallback={null}>
              <div className={lessons.length > 0 ? "mt-4" : undefined}>
                <SupervisionPasses
                  items={passes}
                  summary={board?.supervisionSummary}
                  view={view}
                  dayText={dayText}
                  timeText={timeText}
                  nameOf={nameOf}
                  teachers={teachers}
                  now={now}
                />
              </div>
            </Suspense>
          ) : null}
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
    </Page>
  );
}
