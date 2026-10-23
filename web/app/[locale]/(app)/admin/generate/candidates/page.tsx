"use client";

import { lazy, Suspense, useCallback, useId, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Layers, RefreshCw } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import { engineMessage, type MessageLookup } from "@/lib/engine-message";
import { worseFor, type IdleComparison } from "@/lib/candidates/idle";
import type { IdleInputs } from "@/lib/candidates/idle-run";
import {
  changedPartsText,
  firstFailedKey,
  isActiveRun,
  isApplicable,
  refusalKey,
  requestErrorKey,
  runErrorText,
  safetyVersionName,
  staleParts,
  variantLabel,
} from "@/lib/candidates/labels";
import { candidateWeek, currentWeek, replacedLessons } from "@/lib/candidates/lessons";
import { movedLessons } from "@/lib/candidates/moved";
import type { CandidateBatch, CandidateView } from "@/lib/candidates/types";
import { alternates, otherParityMonday, referenceMonday, type WeekNames, type WeekTargetKind } from "@/lib/candidates/week";
import { buildRosterIndex } from "@/lib/lesson-audience";
import { isoWeekOf, plusDays } from "@/lib/print-sheet";
import { usePlanningYear } from "@/lib/planning-year";
import { isProjectable, withProjectedHomes } from "@/lib/projected-rosters";
import {
  useAcademicYears,
  useConstraints,
  useFrameTimes,
  useGroupMemberships,
  useGroups,
  useLunchSettings,
  usePeople,
  useRequirements,
  useRooms,
  useSubjects,
} from "@/lib/queries";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { PlanningYearPicker, ProjectedRostersBanner } from "@/components/schedule/planning-year";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Label } from "@/components/ui/label";
import { LoadError } from "@/components/ui/load-error";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useScheduleCandidates, useStartCandidates } from "../use-schedule-candidates";
import { ApplyDialog } from "./apply-dialog";
import { ComparisonTable, type IdleState } from "./comparison-table";
import { MovedLessons } from "./moved-lessons";
import {
  useApplyCandidate,
  useCandidateCheck,
  useCandidateLessons,
  useDiscardCandidates,
  useOriginMasters,
} from "./use-candidate-details";

/*
 * Schemaförslag: compare the year's candidates with the grundschema as it
 * stands, and apply one (design §6).
 *
 * Its own route under /admin/generate, for three reasons: it has its own
 * bundle budget; it inherits that page's SCHEMALAGGNING gate, because
 * gateOfPath (lib/admin-areas.ts) and ClosedPageGate both match a page by
 * prefix, so it needs no PAGE_GATES row; and the menu keeps "Generera"
 * highlighted on it without AppShell knowing it exists.
 *
 * WHAT IS COMPUTED WHERE. The gateway measured the candidates when it stored
 * them — lessons moved against the draft they came from, room changes, the
 * timplan lines left unplaced — and /check says whether the draft has moved
 * since. Håltimmar exist only in the browser (lib/gaps.ts is the product's
 * one definition), so they are computed here, for the current grundschema
 * and for each candidate, by the same rules /admin/gaps uses. That code is
 * heavy, so it arrives with React.lazy (idle-calculator.tsx), as does the
 * week sheet (candidate-week.tsx); the table is drawn first and its two
 * håltimmar rows are filled when the figures exist.
 */

const IdleCalculator = lazy(() => import("./idle-calculator"));
const CandidateWeek = lazy(() => import("./candidate-week"));

/** How long the applied toast stays: long enough to reach its links. */
const APPLIED_TOAST_MS = 15_000;

/** Never read, and failed: the state ladder's error rung (a refetch failing over data is not it). */
const neverRead = (query: { isError: boolean; data: unknown }) => query.isError && query.data === undefined;

export default function CandidatesPage() {
  const t = useTranslations("scheduleCandidates");
  const tEngine = useTranslations("engineMessages");
  const tConflicts = useTranslations("conflictCategories");
  const locale = useLocale();
  const applyReasonId = useId();

  const planning = usePlanningYear();
  const { year } = planning;
  const yearId = year?.id ?? null;
  const yearsQuery = useAcademicYears();
  const resolvingYear = planning.active !== null && year === null;
  const yearQuery = year && !year.isActive ? `?year=${encodeURIComponent(year.id)}` : "";
  const generateHref = `/admin/generate${yearQuery}`;
  const timetableHref = `/admin/timetable${yearQuery}`;

  const runDate = useMemo(
    () => new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "sv-SE", { dateStyle: "medium", timeStyle: "short" }),
    [locale],
  );
  const dateOf = (iso: string | null) => (iso ? runDate.format(new Date(iso)) : "");

  // -------------------------------------------------------------------
  // The runs, the batch, its check and its lessons
  // -------------------------------------------------------------------

  const overviewQuery = useScheduleCandidates(yearId);
  const overview = overviewQuery.data;
  const latest = overview?.latest ?? null;
  const batch = overview?.batch ?? null;
  const active = isActiveRun(latest?.run.status);
  const candidates = useMemo(
    () => [...(batch?.candidates ?? [])].sort((a, b) => a.ordinal - b.ordinal),
    [batch],
  );
  const applicable = useMemo(() => candidates.filter(isApplicable), [candidates]);

  const checkQuery = useCandidateCheck(batch?.run.status === "SUCCEEDED" ? batch.run.id : null);
  const check = checkQuery.data ?? null;
  const originQuery = useOriginMasters(yearId);
  const origin = originQuery.data;
  const lessons = useCandidateLessons(applicable.map((candidate) => candidate.id));

  // -------------------------------------------------------------------
  // The school, for names and for håltimmar (the /admin/gaps inputs)
  // -------------------------------------------------------------------

  const subjectsQuery = useSubjects();
  const groupsQuery = useGroups();
  const roomsQuery = useRooms();
  const peopleQuery = usePeople();
  const constraintsQuery = useConstraints();
  const membershipsQuery = useGroupMemberships();
  const frameTimesQuery = useFrameTimes();
  const lunchQuery = useLunchSettings();
  const requirementsQuery = useRequirements(yearId);
  /*
   * Next year before its activation: its classes have no home pupils until
   * then, so the pupils are read with the class the activation gives them —
   * the overlay the generation itself reads. Until it has arrived, a week
   * counted on this year's classes would be next year's håltimmar on the
   * wrong pupils, so the figures wait for it.
   */
  const rostersPending =
    isProjectable(year, planning.active) && planning.rosters === null && !planning.rostersFailed;
  const people = useMemo(
    () => withProjectedHomes(peopleQuery.data, planning.rosters) ?? [],
    [peopleQuery.data, planning.rosters],
  );

  /*
   * Keyed on the reads' data, never on the query objects: those are new on
   * every render, and a new input here measures every week again.
   */
  const constraints = constraintsQuery.data;
  const groups = groupsQuery.data;
  const memberships = membershipsQuery.data;
  const frameTimes = frameTimesQuery.data;
  const requirements = requirementsQuery.data;
  const lunch = lunchQuery.data;
  const idleInputs = useMemo((): IdleInputs | null => {
    if (!year || !peopleQuery.data || !constraints || !groups || !memberships || !frameTimes || !requirements) return null;
    if (lunch === undefined || rostersPending) return null;
    const current = people.filter((person) => person.isActive);
    return {
      constraints,
      requirements,
      studentGroupOf: new Map(
        current.filter((person) => person.role === "STUDENT").map((person) => [person.id, person.studentGroupId] as const),
      ),
      memberships,
      groups,
      frameTimes,
      lunch,
      academicYearId: year.id,
      numbering: year.gradeNumbering,
      teacherIds: current.filter((person) => person.role === "TEACHER").map((person) => person.id),
    };
  }, [year, peopleQuery.data, people, constraints, groups, memberships, frameTimes, requirements, lunch, rostersPending]);

  const weeks = useMemo(() => {
    if (!origin) return null;
    return {
      current: currentWeek(origin),
      candidates: applicable
        .filter((candidate) => lessons.byId.has(candidate.id))
        .map((candidate) => ({ id: candidate.id, week: candidateWeek(origin, lessons.byId.get(candidate.id)!, yearId ?? "") })),
    };
  }, [origin, applicable, lessons.byId, yearId]);

  const [idleResult, setIdleResult] = useState<IdleComparison | null>(null);
  const onIdle = useCallback((result: IdleComparison) => setIdleResult(result), []);
  const idleFailed =
    planning.rostersFailed ||
    [constraintsQuery, groupsQuery, peopleQuery, membershipsQuery, frameTimesQuery, lunchQuery, requirementsQuery, originQuery].some(
      neverRead,
    );
  const idle: IdleState = idleFailed
    ? { status: "failed" }
    : idleResult && idleInputs && weeks
      ? { status: "ready", ...idleResult }
      : { status: "loading" };

  // -------------------------------------------------------------------
  // Names
  // -------------------------------------------------------------------

  const nameMaps = useMemo(() => {
    const byId = <T extends { id: string }>(rows: readonly T[] | undefined, name: (row: T) => string) =>
      new Map((rows ?? []).map((row) => [row.id, name(row)]));
    return {
      subject: byId(subjectsQuery.data, (subject) => subject.name),
      group: byId(groups, (group) => group.name),
      room: byId(roomsQuery.data, (room) => room.name),
      person: byId(people, (person) => `${person.firstName} ${person.lastName}`),
    };
  }, [subjectsQuery.data, groups, roomsQuery.data, people]);
  const weekNames: WeekNames = useMemo(
    () => ({
      subject: (id) => nameMaps.subject.get(id) ?? null,
      group: (id) => nameMaps.group.get(id) ?? null,
      room: (id) => nameMaps.room.get(id) ?? null,
      teacher: (id) => nameMaps.person.get(id) ?? null,
    }),
    [nameMaps],
  );
  const listNames = useMemo(
    () => ({
      group: (id: string) => nameMaps.group.get(id) ?? "—",
      subject: (id: string) => nameMaps.subject.get(id) ?? "—",
      room: (id: string) => nameMaps.room.get(id) ?? "—",
    }),
    [nameMaps],
  );
  const nameOf = (candidate: CandidateView) =>
    t("candidateName", { ordinal: candidate.ordinal, label: variantLabel(t, candidate) });

  // -------------------------------------------------------------------
  // The candidate under review
  // -------------------------------------------------------------------

  const [chosenId, setChosenId] = useState<string | null>(null);
  const selected =
    applicable.find((candidate) => candidate.id === chosenId) ??
    applicable.find((candidate) => candidate.id === batch?.run.appliedCandidateId) ??
    applicable[0] ??
    null;
  const selectedLessons = selected ? lessons.byId.get(selected.id) : undefined;
  const moves = useMemo(
    () => (origin && selectedLessons ? movedLessons(replacedLessons(origin), selectedLessons) : null),
    [origin, selectedLessons],
  );
  const selectedWeek = selected ? weeks?.candidates.find((entry) => entry.id === selected.id)?.week : undefined;
  const worse =
    idle.status === "ready" && selected && idle.byCandidate.get(selected.id)
      ? worseFor(idle.current.perTeacher, idle.byCandidate.get(selected.id)!.perTeacher)
      : null;

  /*
   * The week view's choices: a class or a teaching group of the year (the
   * timetable's two filter sections), a teacher or a room. A group of
   * either kind is drawn by who sits in each lesson, so a class's week has
   * the teaching-group lessons its pupils attend (lib/candidates/week.ts).
   */
  const [weekKind, setWeekKind] = useState<WeekTargetKind>("GROUP");
  const [weekTarget, setWeekTarget] = useState<string | null>(null);
  const [nextWeek, setNextWeek] = useState(false);
  const weekSections = useMemo((): { label: string | null; options: { id: string; label: string }[] }[] => {
    if (weekKind === "TEACHER") {
      const teachers = people
        .filter((person) => person.role === "TEACHER" && person.isActive)
        .map((person) => ({ id: person.id, label: `${person.firstName} ${person.lastName}` }));
      return [{ label: null, options: teachers }];
    }
    if (weekKind === "ROOM") {
      return [{ label: null, options: (roomsQuery.data ?? []).map((room) => ({ id: room.id, label: room.name })) }];
    }
    const yearGroups = (groups ?? []).filter((group) => group.academicYearId === yearId);
    const named = (group: { id: string; name: string }) => ({ id: group.id, label: group.name });
    return [
      { label: t("week.classes"), options: yearGroups.filter((group) => group.kind === "CLASS").map(named) },
      { label: t("week.teachingGroups"), options: yearGroups.filter((group) => group.kind !== "CLASS").map(named) },
    ].filter((section) => section.options.length > 0);
  }, [weekKind, people, roomsQuery.data, groups, yearId, t]);
  const weekOptions = useMemo(() => weekSections.flatMap((section) => section.options), [weekSections]);
  const target = weekOptions.find((option) => option.id === weekTarget) ?? weekOptions[0] ?? null;
  /*
   * Who is in which group, for a group's week: the pupils the håltimmar are
   * counted for (home classes as the activation gives them, and the
   * teaching-group rows). Until both reads have arrived it is empty, and a
   * week shows only the lessons that name its group; the rest fill in after.
   */
  const rosterIndex = useMemo(
    () =>
      buildRosterIndex(
        peopleQuery.data
          ? new Map(
              people
                .filter((person) => person.role === "STUDENT" && person.isActive)
                .map((person) => [person.id, person.studentGroupId] as const),
            )
          : undefined,
        memberships,
        groups ?? [],
      ),
    [peopleQuery.data, people, memberships, groups],
  );
  /*
   * This week, held inside the läsår, and the next: two weeks are both
   * parities, which is all an alternating lesson needs to be seen in.
   */
  const [today] = useState(() => new Date().toISOString().slice(0, 10));
  const thisMonday = year ? referenceMonday(year, today) : null;
  // Offered only while the week under review alternates, or while this week
  // is the läsår's first and a mid-week start cuts it short (its days before
  // the start are drawn empty, so the next is the first whole week). A
  // choice made for another candidate does not linger once the select has gone.
  const firstWeekCut = year !== null && thisMonday !== null && thisMonday < year.startDate.slice(0, 10);
  const offersNextWeek = selectedWeek !== undefined && (alternates(selectedWeek) || firstWeekCut);
  const otherMonday = thisMonday === null || year === null ? null : otherParityMonday(year, thisMonday);
  const monday = thisMonday ? (nextWeek && offersNextWeek && otherMonday ? otherMonday : thisMonday) : null;
  const weekLabel = (date: string) => {
    const week = Number(isoWeekOf(date).split("W")[1]);
    return week % 2 === 1 ? t("week.odd", { week }) : t("week.even", { week });
  };

  // -------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------

  const start = useStartCandidates();
  const apply = useApplyCandidate();
  const discard = useDiscardCandidates();
  const [applying, setApplying] = useState<CandidateView | null>(null);
  const applyReasonRef = useRef<HTMLDivElement | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);

  const errorText = (error: unknown, route: "start" | "apply" | "discard") =>
    t(requestErrorKey(error instanceof ApiError ? error : null, route));

  const refresh = async () => {
    if (!year || !batch) return;
    try {
      await start.mutateAsync({ academicYearId: year.id, refreshOf: batch.run.id });
      toast.success(t("stale.refreshStarted"));
    } catch (error) {
      toast.error(errorText(error, "start"));
    }
  };

  const confirmApply = async () => {
    if (!applying || !check) return;
    const candidate = applying;
    try {
      const result = await apply.mutateAsync({ candidateId: candidate.id, expectedMode: check.mode });
      setApplying(null);
      toast.success(t("applied.toast", { ordinal: candidate.ordinal, count: result.lessonsCreated }), {
        description: (
          <span className="block space-y-1">
            <span className="block">{t("applied.version", { name: safetyVersionName(candidate) })}</span>
            <span className="flex flex-wrap gap-x-3">
              <Link href={timetableHref} className="font-medium underline underline-offset-4">
                {t("applied.versionsLink")}
              </Link>
              {check.mode === "DIRECT" ? (
                <Link href="/admin/publishing" className="font-medium underline underline-offset-4">
                  {t("applied.publishingLink")}
                </Link>
              ) : null}
            </span>
          </span>
        ),
        duration: APPLIED_TOAST_MS,
      });
    } catch (error) {
      // Every refusal leaves this candidate as it was; the page reads the
      // batch and its check again (useApplyCandidate) and shows why.
      setApplying(null);
      const parts =
        error instanceof ApiError && error.code === "SCHEDULE_CANDIDATE_STALE" ? staleParts(error.params) : [];
      toast.error(
        parts.length > 0
          ? t("errors.SCHEDULE_CANDIDATE_STALE_PARTS", { parts: changedPartsText(t, parts, locale) })
          : errorText(error, "apply"),
      );
    }
  };

  const confirmDiscard = async () => {
    if (!year) return;
    try {
      await discard.mutateAsync(year.id);
      setDiscardOpen(false);
      toast.success(active ? t("discard.cancelled") : t("discard.done"));
    } catch (error) {
      setDiscardOpen(false);
      toast.error(errorText(error, "discard"));
    }
  };

  // -------------------------------------------------------------------
  // Why nothing can be applied right now — one sentence, the first that holds
  // -------------------------------------------------------------------

  const stale = check?.stale ?? false;
  const applyReason: React.ReactNode = !batch ? null : active ? (
    <p id={applyReasonId} className="text-sm text-foreground">
      {t("apply.blockedRunning")}
    </p>
  ) : checkQuery.isLoading ? (
    <p id={applyReasonId} aria-busy="true" className="text-sm text-foreground">
      {t("check.checking")}
    </p>
  ) : checkQuery.isError || !check ? (
    <div id={applyReasonId}>
      <LoadError
        variant="inline"
        title={t("check.failed")}
        hint={t("check.failedHint")}
        action={
          <Button variant="outline" size="sm" onClick={() => void checkQuery.refetch()}>
            {t("check.retry")}
          </Button>
        }
      />
    </div>
  ) : check.refusalCode ? (
    // Before the stale branch: the gateway answers a draft that meets a
    // pre-flight refusal as stale with no parts named, and a refresh would
    // meet the same refusal. What helps is the refusal's own sentence.
    <div id={applyReasonId}>
      <Notice tone="warning" title={t("refusal.title")}>
        {t(refusalKey(check.refusalCode))}
      </Notice>
    </div>
  ) : stale ? (
    <div id={applyReasonId}>
      <Notice
        tone="warning"
        title={t("stale.title")}
        action={
          <Button size="sm" data-writes="SCHEMALAGGNING" onClick={refresh} disabled={start.isPending}>
            <RefreshCw aria-hidden="true" className={start.isPending ? "animate-spin" : undefined} />
            {start.isPending ? t("stale.refreshing") : t("stale.refresh")}
          </Button>
        }
      >
        <p>
          {check.changed.length > 0
            ? t("stale.body", { parts: changedPartsText(t, check.changed, locale) })
            : t("stale.bodyUnnamed")}
        </p>
      </Notice>
    </div>
  ) : null;

  // -------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------

  const conflictLabel = (category: string): string =>
    tConflicts.has(category as never) ? tConflicts(category as never) : category;
  const engineText = (sentence: { code?: string | null; message: string; params?: Record<string, string | number> | null }) =>
    engineMessage(tEngine as unknown as MessageLookup, sentence);

  /** The newest run, when it is not the batch: still working, or ended without one. */
  const runNotice = (run: CandidateBatch) => {
    if (isActiveRun(run.run.status)) {
      const { progress, requested, status } = run.run;
      return (
        <Notice
          title={t("progress.title")}
          action={
            <Button
              variant="outline"
              size="sm"
              data-writes="SCHEMALAGGNING"
              onClick={() => setDiscardOpen(true)}
              disabled={status === "CANCELLING"}
            >
              {t("progress.cancel")}
            </Button>
          }
        >
          <div className="space-y-2">
            <p>
              {status === "PENDING"
                ? t("progress.pending")
                : status === "CANCELLING"
                  ? t("progress.cancelling")
                  : t("progress.count", { done: progress, total: requested })}
            </p>
            <progress className="h-2 w-full max-w-sm accent-primary" value={progress} max={Math.max(requested, 1)} aria-label={t("progress.label")} />
            <p>{t("progress.hint")}</p>
          </div>
        </Notice>
      );
    }
    const cancelled = run.run.errorCode === "CANDIDATE_RUN_CANCELLED";
    /*
     * CANDIDATES_FIRST_FAILED keeps the first candidate, so what it met says
     * what stops every variant: the hard rules are the same for all of them.
     * Its errorCode is the engine's summary of the week, said as Generera's
     * page says a job's (conflictSummaryCode and its params), and its
     * conflicts are the causes under it. A TIMEOUT whose probes found nothing
     * has the summary alone, and one with probes off has neither — which is
     * why the sentence above them is chosen by what there is to list.
     */
    const firstFailed = run.run.errorCode === "CANDIDATES_FIRST_FAILED";
    const first = firstFailed ? [...run.candidates].sort((a, b) => a.ordinal - b.ordinal)[0] : undefined;
    // No English beside the code to fall back on: a code this build cannot
    // say is left out rather than shown as a code.
    const summary = first?.errorCode ? engineText({ code: first.errorCode, params: first.errorParams, message: "" }) : "";
    const conflicts = run.candidates.flatMap((candidate) => candidate.conflicts ?? []);
    const listed = summary !== "" || conflicts.length > 0;
    /*
     * A post's days (Lärarens dag) are hidden on this page for every reader,
     * rektor included: the gateway keeps the sentence without its teacher or
     * figure, and nothing here reads the post back. The sentence says who may
     * see the days; this says where — the post, and Generera's own answer.
     */
    const daysHidden = [run.run.errorCode, first?.errorCode, ...conflicts.map((conflict) => conflict.code)].includes(
      "TEACHER_WORK_DAYS_HIDDEN",
    );
    return (
      <Notice
        tone={cancelled ? "neutral" : "destructive"}
        role={null}
        title={cancelled ? t("failed.cancelledTitle") : t("failed.title", { date: dateOf(run.run.finishedAt ?? run.run.createdAt) })}
      >
        <div className="space-y-2">
          <p>{firstFailed ? t(firstFailedKey(first, listed)) : runErrorText(t, tEngine, run.run)}</p>
          {listed ? (
            <section aria-labelledby="candidates-conflicts" className="space-y-2">
              <h2 id="candidates-conflicts" className="font-semibold">
                {t("failed.conflicts")}
              </h2>
              {summary !== "" ? <p>{summary}</p> : null}
              {conflicts.length > 0 ? (
                <ul className="space-y-2">
                  {conflicts.map((conflict, index) => (
                    <li key={index} className="space-y-1">
                      <Badge variant="warning">{conflictLabel(conflict.category)}</Badge>
                      <p>{engineText(conflict)}</p>
                      {conflict.resourceNames && conflict.resourceNames.length > 0 ? (
                        <p className="font-medium">{conflict.resourceNames.join(", ")}</p>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
          {daysHidden ? <p>{t("failed.daysWhere")}</p> : null}
          {batch ? (
            <p>{t("failed.olderBatch", { date: dateOf(batch.run.finishedAt ?? batch.run.createdAt) })}</p>
          ) : (
            <Link href={`${generateHref}#candidates`} className="font-medium underline underline-offset-4">
              {t("failed.again")}
            </Link>
          )}
        </div>
      </Notice>
    );
  };

  const appliedCandidate = batch ? candidates.find((candidate) => candidate.id === batch.run.appliedCandidateId) : undefined;

  let body: React.ReactNode;
  if (overviewQuery.isLoading || yearsQuery.isLoading || resolvingYear) {
    body = (
      <div aria-busy="true" className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  } else if (neverRead(overviewQuery) || (!year && yearsQuery.isError)) {
    body = <LoadError title={t("page.loadFailed")} hint={t("page.loadFailedHint")} />;
  } else if (!year) {
    body = <EmptyState icon={Layers} title={t("page.noYear")} />;
  } else if (!latest && !batch) {
    body = (
      <EmptyState
        icon={Layers}
        title={t("page.emptyTitle")}
        description={t("page.emptyBody")}
        action={
          <Button asChild>
            <Link href={`${generateHref}#candidates`}>{t("page.emptyAction")}</Link>
          </Button>
        }
      />
    );
  } else {
    body = (
      <div className="space-y-4">
        {overviewQuery.isError ? (
          <LoadError variant="inline" title={t("page.loadFailed")} hint={t("page.refetchFailedHint")} />
        ) : null}
        {latest && latest.run.id !== batch?.run.id ? runNotice(latest) : null}

        {batch ? (
          <>
            {appliedCandidate ? (
              <Notice tone="success" role={null} title={t("applied.title", { name: nameOf(appliedCandidate) })}>
                <div className="space-y-1">
                  <p>{t("applied.body", { date: dateOf(batch.run.appliedAt) })}</p>
                  <p>{t("applied.version", { name: safetyVersionName(appliedCandidate) })}</p>
                  <p className="flex flex-wrap gap-x-3">
                    <Link href={timetableHref} className="font-medium underline underline-offset-4">
                      {t("applied.versionsLink")}
                    </Link>
                    {check?.mode === "DIRECT" ? (
                      <Link href="/admin/publishing" className="font-medium underline underline-offset-4">
                        {t("applied.publishingLink")}
                      </Link>
                    ) : null}
                  </p>
                </div>
              </Notice>
            ) : null}

            {applyReason ? (
              // Focusable, so a dialog closing over a Tillämpa this reason has
              // just disabled hands focus here rather than to <body>.
              <div ref={applyReasonRef} tabIndex={-1} className="outline-none">
                {applyReason}
              </div>
            ) : null}

            <SectionCard
              id="comparison"
              title={t("table.title")}
              description={
                batch.run.createdByName
                  ? t("batch.madeBy", { date: dateOf(batch.run.finishedAt ?? batch.run.createdAt), name: batch.run.createdByName })
                  : t("batch.made", { date: dateOf(batch.run.finishedAt ?? batch.run.createdAt) })
              }
            >
              <ComparisonTable
                candidates={candidates}
                mode={check?.mode ?? null}
                unplaced={overview?.unplaced ?? null}
                draftNotes={overview?.draftNotes ?? null}
                idle={idle}
                lessonsFailed={lessons.failed}
                appliedId={batch.run.appliedCandidateId}
                applyBlockedBy={applyReason ? applyReasonId : null}
                onApply={(candidate) => {
                  setApplying(candidate);
                  // The counts the DIRECT dialog shows, and whether the batch
                  // still fits, read again now rather than at page load.
                  void checkQuery.refetch();
                }}
              />
            </SectionCard>

            {selected ? (
              <>
                <SectionCard
                  id="review"
                  title={t("review.title")}
                  description={t("review.hint")}
                  action={
                    applicable.length > 1 ? (
                      <div className="space-y-1">
                        <Label htmlFor="review-candidate">{t("review.pick")}</Label>
                        <NativeSelect
                          id="review-candidate"
                          value={selected.id}
                          onChange={(event) => setChosenId(event.target.value)}
                        >
                          {applicable.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              {nameOf(candidate)}
                            </option>
                          ))}
                        </NativeSelect>
                      </div>
                    ) : null
                  }
                >
                  <section aria-labelledby="review-worse" className="space-y-2">
                    <h3 id="review-worse" className="text-sm font-semibold">
                      {t("worse.title")}
                    </h3>
                    <p className="text-sm text-muted-foreground">{t("worse.hint")}</p>
                    {idle.status === "failed" || lessons.failed.has(selected.id) ? (
                      <p className="text-sm text-foreground">{t("worse.failed")}</p>
                    ) : worse === null ? (
                      <div aria-busy="true">
                        <Skeleton className="h-10 w-full" />
                      </div>
                    ) : worse.length === 0 ? (
                      <p className="text-sm text-foreground">{t("worse.none")}</p>
                    ) : (
                      <ul className="space-y-1 text-sm">
                        {worse.map((teacher) => (
                          <li key={teacher.teacherId} className="tabular-nums">
                            {t("worse.row", {
                              name: nameMaps.person.get(teacher.teacherId) ?? "—",
                              before: Math.round(teacher.before),
                              after: Math.round(teacher.after),
                            })}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  <section aria-labelledby="review-moved" className="space-y-2 pt-2">
                    <h3 id="review-moved" className="text-sm font-semibold">
                      {t("moved.title")}
                    </h3>
                    {lessons.failed.has(selected.id) || neverRead(originQuery) ? (
                      <LoadError variant="inline" title={t("moved.failed")} hint={t("moved.failedHint")} />
                    ) : moves === null ? (
                      <div aria-busy="true">
                        <Skeleton className="h-24 w-full" />
                      </div>
                    ) : (
                      <MovedLessons moves={moves} candidateName={nameOf(selected)} names={listNames} />
                    )}
                  </section>
                </SectionCard>

                <SectionCard id="week" title={t("week.title", { name: nameOf(selected) })} description={t("week.hint")}>
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="space-y-1">
                      <Label htmlFor="week-kind">{t("week.kind")}</Label>
                      <NativeSelect
                        id="week-kind"
                        className="w-40"
                        value={weekKind}
                        onChange={(event) => {
                          setWeekKind(event.target.value as WeekTargetKind);
                          setWeekTarget(null);
                        }}
                      >
                        <option value="GROUP">{t("week.kindGROUP")}</option>
                        <option value="TEACHER">{t("week.kindTEACHER")}</option>
                        <option value="ROOM">{t("week.kindROOM")}</option>
                      </NativeSelect>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="week-target">
                        {weekKind === "TEACHER" ? t("week.kindTEACHER") : weekKind === "ROOM" ? t("week.kindROOM") : t("week.kindGROUP")}
                      </Label>
                      <NativeSelect
                        id="week-target"
                        className="w-56"
                        value={target?.id ?? ""}
                        onChange={(event) => setWeekTarget(event.target.value)}
                        disabled={weekOptions.length === 0}
                      >
                        {weekSections.map((section) => {
                          const options = section.options.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.label}
                            </option>
                          ));
                          return section.label ? (
                            <optgroup key={section.label} label={section.label}>
                              {options}
                            </optgroup>
                          ) : (
                            options
                          );
                        })}
                      </NativeSelect>
                    </div>
                    {thisMonday && offersNextWeek ? (
                      <div className="space-y-1">
                        <Label htmlFor="week-which">{t("week.week")}</Label>
                        <NativeSelect
                          id="week-which"
                          className="w-48"
                          value={nextWeek ? "next" : "this"}
                          onChange={(event) => setNextWeek(event.target.value === "next")}
                        >
                          <option value="this">{weekLabel(thisMonday)}</option>
                          <option value="next">{weekLabel(otherMonday ?? plusDays(thisMonday, 7))}</option>
                        </NativeSelect>
                      </div>
                    ) : null}
                  </div>
                  {lessons.failed.has(selected.id) || neverRead(originQuery) ? (
                    <LoadError variant="inline" title={t("moved.failed")} hint={t("moved.failedHint")} />
                  ) : !target ? (
                    <p className="text-sm text-foreground">{t("week.noTargets")}</p>
                  ) : selectedWeek && monday && year ? (
                    <Suspense
                      fallback={
                        <div aria-busy="true">
                          <Skeleton className="h-64 w-full" />
                        </div>
                      }
                    >
                      <CandidateWeek
                        lessons={selectedWeek}
                        kind={weekKind}
                        targetId={target.id}
                        title={target.label}
                        school={nameOf(selected)}
                        monday={monday}
                        year={year}
                        names={weekNames}
                        roster={rosterIndex}
                      />
                    </Suspense>
                  ) : (
                    <div aria-busy="true">
                      <Skeleton className="h-64 w-full" />
                    </div>
                  )}
                </SectionCard>
              </>
            ) : null}
          </>
        ) : null}
      </div>
    );
  }

  return (
    <Page width="wide">
      <PageHeader
        title={t("page.title")}
        subtitle={t("page.subtitle")}
        back={{ href: generateHref, label: t("page.back") }}
        actions={
          <>
            <PlanningYearPicker
              {...planning}
              onChoose={(id) => {
                // The other year's candidates are other candidates.
                setChosenId(null);
                setIdleResult(null);
                planning.choose(id);
              }}
            />
            {/* While a run works, its own notice offers Avbryt instead. */}
            {(latest || batch) && !active ? (
              <Button variant="outline" size="sm" data-writes="SCHEMALAGGNING" onClick={() => setDiscardOpen(true)}>
                {t("discard.button")}
              </Button>
            ) : null}
          </>
        }
      />
      <ProjectedRostersBanner
        year={year}
        active={planning.active}
        rosters={planning.rosters}
        failed={planning.rostersFailed}
      />
      <p className="mb-4 max-w-prose text-sm text-foreground">{t("section.retention")}</p>

      {body}

      <ApplyDialog
        candidate={applying}
        label={applying ? variantLabel(t, applying) : ""}
        check={check}
        // Not only isFetching: a read paused while the browser is offline is
        // not fetching either, and must hold the confirm as well.
        checking={checkQuery.fetchStatus !== "idle"}
        checkFailed={checkQuery.isError}
        onRetryCheck={() => void checkQuery.refetch()}
        onCloseAutoFocus={(event) => {
          // The opener is disabled whenever a reason is shown (a failed or
          // stale check): focus the reason, which says why.
          const reason = applyReasonRef.current;
          if (reason?.isConnected) {
            event.preventDefault();
            reason.focus();
          }
        }}
        pending={apply.isPending}
        onOpenChange={(open) => (open ? undefined : setApplying(null))}
        onConfirm={confirmApply}
      />
      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title={active ? t("discard.titleActive") : t("discard.title")}
        description={active ? t("discard.bodyActive") : t("discard.body")}
        confirmLabel={active ? t("discard.confirmActive") : t("discard.confirm")}
        loading={discard.isPending}
        onConfirm={confirmDiscard}
      />
      {idleInputs && weeks ? (
        <Suspense fallback={null}>
          <IdleCalculator inputs={idleInputs} current={weeks.current} candidates={weeks.candidates} onResult={onIdle} />
        </Suspense>
      ) : null}
    </Page>
  );
}
