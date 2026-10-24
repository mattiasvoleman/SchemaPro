"use client";

import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  History,
  Loader2,
  SlidersHorizontal,
  Sparkles,
  XCircle,
} from "lucide-react";
import { Link } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import { isActiveRun, VARIANT_KEYS, variantLabel } from "@/lib/candidates/labels";
import { engineMessage, type MessageLookup } from "@/lib/engine-message";
import {
  useAcademicYears,
  useGroupMemberships,
  useGroups,
  useLunchSettings,
  useOptimizationHistory,
  useOptimizationJob,
  usePeople,
  useRequirements,
  useRooms,
  useStartOptimization,
  type ObjectiveWeights,
  type OptimizationJob,
} from "@/lib/queries";
import { Label } from "@/components/ui/label";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatTime } from "@/lib/utils";
import { buildGradeSpans } from "@/lib/grade-span";
import { solverRunVariant } from "@/lib/status-variants";
import { useStaffingPolicy, useTeacherDuties } from "@/lib/staffing-queries";
import { sharesByRequirement, useRequirementShares } from "@/lib/requirement-shares";
import { dutyPeriodLine, keepsTimesAllYear } from "@/lib/duty-lines";
import { usePlanningYear } from "@/lib/planning-year";
import { withProjectedHomes } from "@/lib/projected-rosters";
import {
  PlanningYearPicker,
  ProjectedRostersBanner,
} from "@/components/schedule/planning-year";
import { CandidatesSection, candidatesHref } from "./candidates-section";
import { useScheduleCandidates } from "./use-schedule-candidates";

/**
 * How long the gateway counts a PENDING or RUNNING job as running when it
 * refuses a candidate run beside it (GENERATE_RUNNING): a job older than
 * this is one whose task was lost, and refusing for it would refuse for ever.
 */
const GENERATE_RUNNING_MS = 15 * 60 * 1000;

/**
 * How often the year's history is read again while it holds a job this page
 * did not start that is still running: nothing else reads it again while
 * the page stays open, and its row is what holds Ta fram förslag back.
 */
const HISTORY_POLL_MS = 5000;

/**
 * A history row's word for how the run ended: the gateway's own refusals
 * first — over unstaffed posts, or a partly locked parallel block (they travel
 * as INFEASIBLE, but the engine was never asked) — then a failed job, then the
 * solver's verdict, then the job's state. The same order solverRunVariant
 * reads them in for the colour.
 */
function historyStatusKey(run: OptimizationJob): string {
  if (run.solverStatus === "INFEASIBLE" && run.conflictSummaryCode === "STAFF_UNSTAFFED_REQUIREMENTS") {
    return "UNSTAFFED";
  }
  if (run.solverStatus === "INFEASIBLE" && run.conflictSummaryCode === "BLOCK_PARTLY_LOCKED_SUMMARY") {
    return "PARTLY_LOCKED";
  }
  if (run.status === "FAILED") return "FAILED";
  return run.solverStatus ?? run.status;
}

export default function GeneratePage() {
  const t = useTranslations("generate");
  const tLunch = useTranslations("lunch");
  const tConflicts = useTranslations("conflictCategories");
  const tEngine = useTranslations("engineMessages");
  const tStaffing = useTranslations("staffing");
  const tCommon = useTranslations("common");
  const tCandidates = useTranslations("scheduleCandidates");
  const locale = useLocale();
  /*
   * The year generated for: this one, or next year before its activation.
   * Next year's classes have no home pupils until then, so the people are
   * read with the class the activation will give each pupil it moves — the
   * overlay the gateway's generation itself reads (lib/projected-rosters.ts).
   * The warning below is derived from them, and must say what the run will do.
   */
  const planning = usePlanningYear();
  const { year } = planning;
  /**
   * /admin/staffing for the year planned here: a rolled year not yet
   * activated is not the one the staffing page opens on by itself, and a
   * proposal applied there would staff the wrong year's rows.
   */
  const staffingHref = (section: "unstaffed" | "propose") =>
    `/admin/staffing${year ? `?year=${encodeURIComponent(year.id)}` : ""}#${section}`;
  /*
   * The years themselves, for the state ladder only: usePlanningYear reads
   * the same cached query, and while it is in flight there is no year yet —
   * which the checklist below would otherwise draw as "no year".
   */
  const yearsQuery = useAcademicYears();
  const requirementsQuery = useRequirements(year?.id ?? null);
  const requirements = requirementsQuery.data;
  const roomsQuery = useRooms();
  const rooms = roomsQuery.data;
  const peopleQuery = usePeople();
  const storedPeople = peopleQuery.data;
  const people = useMemo(
    () => withProjectedHomes(storedPeople, planning.rosters),
    [storedPeople, planning.rosters],
  );
  const groupsQuery = useGroups();
  const groups = groupsQuery.data;
  const membershipsQuery = useGroupMemberships();
  const memberships = membershipsQuery.data;
  /**
   * Whether the school refuses to generate while a timplanspost has no lärare
   * (StaffingPolicy.unstaffedGeneration). Read only to say so BEFORE the run:
   * the gateway's pre-flight is what actually refuses
   * (OptimizationProxyService.unstaffedRefusal), so a policy that has not
   * answered yet, or failed, blocks nothing here — the run would come back as
   * the same refusal, named, in the result card below.
   */
  const { data: staffingPolicy } = useStaffingPolicy();
  // Delade lektioner: a post with a lead but a share nobody teaches has
  // lessons without a teacher too, and the pre-flight counts it
  // (readUnstaffedRequirements), so this does.
  const { data: shareRows } = useRequirementShares(year?.id ?? null);
  const unstaffedCount = useMemo(() => {
    const sharesOf = sharesByRequirement(shareRows);
    return (requirements ?? []).filter(
      (requirement) =>
        requirement.teacherId === null || (sharesOf.get(requirement.id) ?? []).some((share) => share.teacherId === null),
    ).length;
  }, [requirements, shareRows]);
  const refusesUnstaffed = staffingPolicy?.unstaffedGeneration === "REFUSE";

  /**
   * Uppdrag with Från or Till and fixed times (migration 20261017090000).
   * The master is one week, so the engine holds such a time free in every
   * week of the year, as it holds a dated requirement's lessons: the
   * vikarietavla and the load count only the uppdrag's dates, the weekly
   * timetable cannot. Said here, before the run, because a teacher missing
   * from Tuesday 15:00 in September for an APT that starts in January is
   * otherwise a mystery in the grid. keepsTimesAllYear is the rule, the one
   * the duties card says the same sentence by: dates on the läsår's own
   * bounds shorten nothing. Each is named — teacher, uppdrag and dates — so
   * the school can find the row the sentence is about.
   */
  const { data: yearDuties } = useTeacherDuties(year?.id ?? null);
  const datedTimes = useMemo(
    () => (yearDuties ?? []).filter((duty) => keepsTimesAllYear(duty, year)),
    [yearDuties, year],
  );
  const personName = (userId: string) => {
    const person = (storedPeople ?? []).find((candidate) => candidate.id === userId);
    return person ? `${person.firstName} ${person.lastName}` : null;
  };
  const blockedByStaffing = refusesUnstaffed && unstaffedCount > 0;

  /**
   * Groups the timplan names whose year cannot be derived.
   *
   * The engine reads "no year" as "unrestricted", on purpose — and so a group
   * with requirements, no members and no gradeLevel of its own is bound by
   * neither ramtider nor raster. The screenshot that prompted this had a slöjd
   * group's lesson laid straight across förmiddagsrasten while every other
   * lesson respected it. The grid shows the band and the lesson on top of it,
   * never why; this is the one place the school stands before it runs.
   *
   * Same derivation the gateway uses for the payload (members' home classes,
   * then the group's own year): a warning computed by a different rule than
   * the one that decides would be worse than none.
   */
  const spanlessGroups = useMemo(() => {
    if (!requirements || !groups) return [];
    const spans = buildGradeSpans({
      groups,
      membersByGroup: (memberships ?? []).reduce((map, row) => {
        const list = map.get(row.studentGroupId);
        if (list) list.push(row.studentId);
        else map.set(row.studentGroupId, [row.studentId]);
        return map;
      }, new Map<string, string[]>()),
      homeClassOf: new Map(
        (people ?? [])
          .filter((person) => person.role === "STUDENT" && person.isActive)
          .map((person) => [person.id, person.studentGroupId] as const),
      ),
    });
    const named = new Set(requirements.map((requirement) => requirement.studentGroupId));
    return groups
      .filter((group) => named.has(group.id) && !spans.has(group.id))
      .map((group) => group.name)
      .sort();
  }, [requirements, groups, memberships, people]);

  const startOptimization = useStartOptimization();
  const [jobId, setJobId] = useState<string | null>(null);
  const { data: job } = useOptimizationJob(jobId);
  const historyQuery = useOptimizationHistory(year?.id ?? null);
  const history = historyQuery.data;
  /*
   * Schemaförslag (design §6). A candidate run and a Generera run of the same
   * year would both replace the draft's generated lessons, so each waits for
   * the other — the gateway refuses either way (CANDIDATES_RUNNING,
   * GENERATE_RUNNING); the page says so before the click.
   */
  const candidatesQuery = useScheduleCandidates(year?.id ?? null);
  const candidateRunActive = isActiveRun(candidatesQuery.data?.latest?.run.status);

  // Optimization profile — persisted locally per browser.
  const [weights, setWeights] = useState<Required<ObjectiveWeights>>({
    preferredFree: 10,
    preferredBusy: 5,
    disruption: 8,
    spread: 3,
    teacherGap: 2,
  });
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("schemapro.optimizationWeights");
      if (stored) setWeights((prev) => ({ ...prev, ...JSON.parse(stored) }));
    } catch {
      // ignore malformed local storage
    }
  }, []);
  const setWeight = (key: keyof ObjectiveWeights, value: number) => {
    setWeights((prev) => {
      const next = { ...prev, [key]: value };
      window.localStorage.setItem(
        "schemapro.optimizationWeights",
        JSON.stringify(next),
      );
      return next;
    });
  };

  /*
   * Scheduling rules are no longer edited here.
   *
   * They used to live in this page's own `localStorage`, which meant every
   * administrator generated under their own copy and nobody could see whose
   * copy a given timetable came from. They are a property of the school now, so
   * this page shows what will be applied and links to where it is changed.
   */
  const lunchQuery = useLunchSettings();
  const lunchSettings = lunchQuery.data;

  /**
   * The engine names a cause with an enum constant. Until this change the
   * conflict analysis never reached a response at all, so nobody had ever seen
   * one — now that it does, DINING_CAPACITY should not be what a school reads.
   * An unknown category falls back to its own name rather than to an empty
   * badge: a new one added engine-side must look untranslated, not invisible.
   */
  const conflictLabel = (category: string): string =>
    tConflicts.has(category as never) ? tConflicts(category as never) : category;

  /**
   * The solver writes its refusals in English and names each one; the Swedish
   * lives in `engineMessages` and is rendered from that name. A sentence with
   * no name, or none this build has a translation for, shows the engine's own
   * words — see lib/engine-message.ts.
   */
  const engineText = (sentence: {
    code?: string | null;
    message: string;
    params?: Record<string, string | number> | null;
  }): string => engineMessage(tEngine as unknown as MessageLookup, sentence);

  const teacherCount = useMemo(
    () => (people ?? []).filter((person) => person.role === "TEACHER" && person.isActive).length,
    [people],
  );

  const prerequisites: {
    label: string;
    ok: boolean;
    detail: string;
    /** Not a gate: shown with a warning sign, and the run stays possible. */
    warn?: boolean;
    href?: string;
    /** A second way to meet it, linked after the figure, and the areas its write needs (data-writes). */
    action?: { href: string; label: string; writes: string };
  }[] = [
    /*
     * The year the run is FOR, which is next year's when it is picked — so
     * not "Aktivt läsår" then: next year is by definition not activated yet.
     */
    {
      label: year && !year.isActive ? t("preYearPlanned") : t("preYear"),
      ok: year !== null,
      detail: year?.name ?? "—",
    },
    {
      label: t("preRequirements"),
      ok: (requirements?.length ?? 0) > 0,
      detail: String(requirements?.length ?? 0),
    },
    { label: t("preTeachers"), ok: teacherCount > 0, detail: String(teacherCount) },
    {
      label: t("preRooms"),
      ok: (rooms?.length ?? 0) > 0,
      detail: String(rooms?.length ?? 0),
    },
    /*
     * "Alla timplansposter har lärare (N saknar)". A gate only when the school
     * has said so (unstaffedGeneration REFUSE); under ALLOW — the default, and
     * the behaviour every school had before Fas 2 — it is a warning, because
     * an unstaffed post is scheduled without a teacher and that may be what
     * the school means while it is still recruiting. Either way it links to
     * the panel where a post is staffed with one click. Met, it shows the
     * check mark and no figure: a "0" beside "Alla timplansposter har
     * lärare" read as "none of them has one". Unmet, it also offers Föreslå
     * bemanning (staffing Fas 4), which staffs every row it can in one go.
     */
    {
      label: t("preStaffed"),
      ok: unstaffedCount === 0,
      warn: unstaffedCount > 0 && !refusesUnstaffed,
      detail: unstaffedCount === 0 ? "" : t("preStaffedMissing", { count: unstaffedCount }),
      href: unstaffedCount > 0 ? staffingHref("unstaffed") : undefined,
      action:
        unstaffedCount > 0
          ? { href: staffingHref("propose"), label: t("preStaffedPropose"), writes: "SCHEMALAGGNING DRIFT" }
          : undefined,
    },
  ];

  /*
   * The checklist is only true once everything it counts has answered. Until
   * then each line would read as unmet — a red cross beside "Timplansposter
   * 0" for a school that has hundreds — so it waits; and a read that failed
   * says so instead of counting it as none. Neither changes what may run: a
   * line that has not answered, or failed, was never met.
   */
  /*
   * usePlanningYear holds the year back for one render, until ?year= has
   * been read — but only a school with an active year ever gets one. Keyed
   * on the active year, not on there being years at all: a school whose
   * years are all inactive would otherwise wait here for good, where it
   * should see "Läsår —" unmet as it always has.
   */
  const resolvingYear = planning.active !== null && year === null;
  const prerequisitesLoading = Boolean(
    yearsQuery.isLoading ||
      resolvingYear ||
      requirementsQuery.isLoading ||
      roomsQuery.isLoading ||
      peopleQuery.isLoading,
  );
  /*
   * Failed with nothing in hand: the read never arrived, so the line cannot
   * be counted. A refetch that fails over a read already in hand is another
   * fact — the counts stand as last read, and the notice above the list says
   * they may be out of date (refetchFailed) rather than taking them away.
   */
  const neverRead = (query: { isError: boolean; data: unknown }) =>
    query.isError && query.data === undefined;
  const prerequisitesFailed = [yearsQuery, requirementsQuery, roomsQuery, peopleQuery].some(neverRead);
  /*
   * The year-group warning is derived from the groups and their members. If
   * either failed, the page cannot say whether a group lacks a year, and
   * silence would read as "every group has one". Named, not a gate: the
   * warning never stopped a run either.
   */
  const groupsFailed = [groupsQuery, membershipsQuery].some(neverRead);
  const refetchFailed = [
    yearsQuery,
    requirementsQuery,
    roomsQuery,
    peopleQuery,
    groupsQuery,
    membershipsQuery,
  ].some((query) => query.isError && query.data !== undefined);
  const prerequisiteState = (prerequisite: { ok: boolean; warn?: boolean }) =>
    prerequisite.ok ? "met" : prerequisite.warn ? "warn" : "unmet";

  const canRun =
    !prerequisitesLoading &&
    !prerequisitesFailed &&
    prerequisites.every((prerequisite) => prerequisite.ok || prerequisite.warn);
  const isRunning =
    startOptimization.isPending ||
    job?.status === "PENDING" ||
    job?.status === "RUNNING";
  /*
   * Another admin's run, or this page's from before a reload, as the history
   * last read it. This page's own job is judged by its poll instead: the
   * history row it started as stays PENDING until the list is read again.
   *
   * Judged against `now`, a clock the poll below moves, not Date.now() in
   * the render: nothing else renders this page again when the 15 minutes
   * pass, and a block computed once would outlive the job it was about.
   */
  const [now, setNow] = useState(() => Date.now());
  const foreignGenerating = (history ?? []).some(
    (entry) =>
      entry.id !== job?.id &&
      (entry.status === "PENDING" || entry.status === "RUNNING") &&
      now - new Date(entry.createdAt).getTime() < GENERATE_RUNNING_MS,
  );
  const generating = isRunning || foreignGenerating;
  /*
   * While such a job runs, the history is read again every few seconds and
   * the clock moves with it: its row turning SUCCEEDED or FAILED, or ageing
   * past the gateway's 15 minutes, is what lets the proposals start. No poll
   * otherwise: the list is read when the page opens and when a run of its
   * own ends. Here, not as a refetchInterval on useOptimizationHistory:
   * lib/queries.ts is in every route's chunk.
   */
  const refetchHistory = historyQuery.refetch;
  const hasYear = year !== null;
  useEffect(() => {
    if (!foreignGenerating || !hasYear) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      void refetchHistory();
    }, HISTORY_POLL_MS);
    return () => window.clearInterval(timer);
  }, [foreignGenerating, hasYear, refetchHistory]);
  /*
   * This page's own job, once it has ended: the history read right after
   * the start still has its row as PENDING, so the list below would show a
   * finished run as waiting until a reload. It is read again.
   */
  const jobStatus = job?.status;
  useEffect(() => {
    if (!hasYear) return;
    if (jobStatus === "SUCCEEDED" || jobStatus === "FAILED") void refetchHistory();
  }, [jobStatus, hasYear, refetchHistory]);

  const run = async () => {
    if (!year) return;
    try {
      const { jobId: newJobId } = await startOptimization.mutateAsync({
        academicYearId: year.id,
        weights,
      });
      setJobId(newJobId);
    } catch (error) {
      // A candidate run that started in another tab since this page last read.
      // The overview is read again, so the section shows that run and polls
      // it, and Generera waits for it here with the reason beside it.
      if (error instanceof ApiError && error.code === "CANDIDATES_RUNNING") {
        toast.error(tCandidates("jobErrors.CANDIDATES_RUNNING"));
        void candidatesQuery.refetch();
        return;
      }
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  /**
   * The gateway's own reasons for a job it stopped before writing, which are
   * not the engine's and so not in its catalogue: the draft changed under
   * the run (GENERATE_STALE), or another write held the year (SCHEDULE_BUSY).
   */
  const jobErrorText = (code: string | null): string | null =>
    code === "GENERATE_STALE"
      ? tCandidates("jobErrors.GENERATE_STALE")
      : code === "SCHEDULE_BUSY"
        ? tCandidates("jobErrors.SCHEDULE_BUSY")
        : null;

  const solverStatus = job?.status === "SUCCEEDED" ? job.solverStatus : null;
  // Both verdicts mean "no timetable came back", but only INFEASIBLE is a
  // proof — TIMEOUT just means the solver needs more time, so it gets its own
  // hint and never claims the requirements are impossible.
  const noScheduleProduced =
    solverStatus === "INFEASIBLE" || solverStatus === "TIMEOUT";
  /**
   * The gateway's own pre-flight refusal, which travels as an INFEASIBLE job so
   * the history and this card treat it like any refusal — but the engine was
   * never asked, so "the constraints cannot all be met" would be false. It
   * gets its own status line and a link to where the posts are staffed.
   */
  const refusedUnstaffed =
    solverStatus === "INFEASIBLE" &&
    job?.conflictSummaryCode === "STAFF_UNSTAFFED_REQUIREMENTS";
  /** The same for a parallel block with some of its lessons locked: the conflict below names it. */
  const refusedPartlyLocked =
    solverStatus === "INFEASIBLE" &&
    job?.conflictSummaryCode === "BLOCK_PARTLY_LOCKED_SUMMARY";
  /**
   * The wishes a laid week could not keep (Lärarens dag): a teacher's free
   * day the generator gave up for the rest of the week. Not conflicts — the
   * run succeeded — so they get a heading of their own under the result. A
   * gateway before them sends no field, which is none.
   */
  const notes = job?.notes ?? [];
  /**
   * A schemaförslag applied over the year since this run: the grundschema is
   * the candidate's now, and the notes describe a timetable that is gone — a
   * list nobody can act on, under a hint to move lessons that were replaced.
   * They give way to a line naming the candidate, and while the comparison
   * still has it, pointing there for which wishes it breaks. The gateway reads
   * it from the year's change log, which keeps the apply whatever becomes of
   * the candidate's run — a newer batch or "Ta bort förslagen" deletes the
   * run, and with it the overview's appliedAt — and drops it again when the
   * apply's safety version is restored.
   */
  const appliedSince = job?.supersededBy ?? null;
  /** The candidate by its name, its emphasis only when this build knows it ("Förslag 2", not "Förslag 2 – Förslag 2"). */
  const supersededText = !appliedSince
    ? ""
    : appliedSince.ordinal === null || appliedSince.variant === null
      ? t("notesSupersededUnnamed")
      : VARIANT_KEYS[appliedSince.variant]
        ? t("notesSuperseded", {
            ordinal: appliedSince.ordinal,
            label: variantLabel(tCandidates, { ordinal: appliedSince.ordinal, variant: appliedSince.variant }),
          })
        : t("notesSupersededPlain", { ordinal: appliedSince.ordinal });
  /**
   * The comparison still shows the applied candidate only while its run is
   * the year's batch: a newer batch, a discard or the sweep deletes it, and
   * the page would then open on other candidates or none. No link then.
   */
  const comparisonHasIt =
    appliedSince !== null && appliedSince.runId !== null && candidatesQuery.data?.batch?.run.id === appliedSince.runId;
  /*
   * A candidate is applied on its own page, often in another tab, and this
   * app reads nothing again on focus (app-providers.tsx) nor polls a finished
   * run. So while the card shows wishes, coming back to the tab reads the run
   * again, and the gateway says whether one was applied since.
   */
  const queryClient = useQueryClient();
  const watchingWishes = job?.status === "SUCCEEDED" && notes.length > 0 && appliedSince === null;
  useEffect(() => {
    if (!watchingWishes || jobId === null) return undefined;
    const reread = () => {
      if (document.visibilityState === "visible") {
        void queryClient.invalidateQueries({ queryKey: ["optimizationJob", jobId] });
      }
    };
    document.addEventListener("visibilitychange", reread);
    return () => document.removeEventListener("visibilitychange", reread);
  }, [watchingWishes, jobId, queryClient]);
  /**
   * Whose post a days refusal is about, for a reader with HR-läs (Lärarens
   * dag): the sentence's `limit` is a post's id, which no screen resolves, so
   * the gateway names the teachers beside it, and they are drawn under the
   * sentence as a conflict's resourceNames are. Empty for every other reader
   * and every other sentence; absent from an older gateway.
   */
  const errorNames = job?.errorNames ?? [];
  const summaryNames = job?.conflictSummaryNames ?? [];

  /** When a run was started, in the app's language — not the browser's. */
  const runDate = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === "en" ? "en-GB" : "sv-SE", {
        dateStyle: "medium",
        timeStyle: "short",
      }),
    [locale],
  );

  return (
    <Page width="wide">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <PlanningYearPicker
            {...planning}
            onChoose={(yearId) => {
              // The last run's card is that year's; it must not stand under the other.
              setJobId(null);
              planning.choose(yearId);
            }}
          />
        }
      />
      <ProjectedRostersBanner
        year={year}
        active={planning.active}
        rosters={planning.rosters}
        failed={planning.rostersFailed}
      />

      {/* A warning, not a gate: the run is legal, and the school may mean it.
          What it must not be is a surprise. */}
      {spanlessGroups.length > 0 ? (
        <Notice tone="warning" title={t("noYearTitle", { count: spanlessGroups.length })}>
          <div className="space-y-1">
            <p>{t("noYearBody")}</p>
            <p className="font-medium">{spanlessGroups.join(", ")}</p>
            <Link href="/admin/groups" className="underline underline-offset-4">
              {t("noYearLink")}
            </Link>
          </div>
        </Notice>
      ) : groupsFailed ? (
        <LoadError variant="inline" title={t("groupsLoadFailed")} hint={t("groupsLoadFailedHint")} />
      ) : null}

      {datedTimes.length > 0 ? (
        <Notice title={t("datedDutyTimesTitle", { count: datedTimes.length })}>
          <div className="space-y-1">
            <p>{t("datedDutyTimesBody")}</p>
            <ul className="list-disc space-y-0.5 pl-5">
              {datedTimes.map((duty) => (
                <li key={duty.id}>
                  {[personName(duty.userId), duty.label, dutyPeriodLine(tStaffing, duty)]
                    .filter((part): part is string => Boolean(part))
                    .join(" · ")}
                </li>
              ))}
            </ul>
          </div>
        </Notice>
      ) : null}

      {/*
        The run closes the checklist: the list says whether the week can be
        laid, and the button that lays it stands at its foot, with the reason
        beside it when it cannot be pressed — not loose between two cards.
      */}
      <SectionCard
        id="prerequisites"
        title={t("prerequisites")}
        footer={
          <div className="flex w-full flex-wrap items-center justify-end gap-3">
            {/*
              The same sentence as the prerequisite line, beside the button it
              disables — a greyed button with no reason beside it is a button
              people click at and then call support about.
            */}
            {candidateRunActive ? (
              <p id="generate-blocked-candidates" className="mr-auto max-w-prose text-sm text-foreground">
                {tCandidates("generateBlocked")}{" "}
                {/* A plain anchor: the section is on this page, and a locale link would leave it. */}
                <a href="#candidates" className="underline underline-offset-4">
                  {tCandidates("generateBlockedLink")}
                </a>
              </p>
            ) : null}
            {blockedByStaffing ? (
              <p id="generate-blocked-unstaffed" className="mr-auto max-w-prose text-sm text-foreground">
                {t("preStaffed")} ({t("preStaffedMissing", { count: unstaffedCount })}).{" "}
                {t("runBlockedUnstaffed")}{" "}
                <Link href={staffingHref("unstaffed")} className="underline underline-offset-4">
                  {t("preStaffedLink")}
                </Link>
                <span data-writes="SCHEMALAGGNING DRIFT">
                  {" · "}
                  <Link href={staffingHref("propose")} className="underline underline-offset-4">
                    {t("preStaffedPropose")}
                  </Link>
                </span>
              </p>
            ) : null}
            <Button
              className="w-full sm:w-auto"
              disabled={!canRun || isRunning || candidateRunActive}
              onClick={run}
              data-writes="SCHEMALAGGNING DRIFT"
              aria-describedby={
                [
                  candidateRunActive ? "generate-blocked-candidates" : null,
                  blockedByStaffing ? "generate-blocked-unstaffed" : null,
                ]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
            >
              {isRunning ? (
                <>
                  <Loader2 className="animate-spin" />
                  {t("running")}
                </>
              ) : (
                <>
                  <Sparkles />
                  {t("run")}
                </>
              )}
            </Button>
          </div>
        }
      >
        {refetchFailed ? (
          <LoadError variant="inline" title={t("loadFailed")} hint={tCommon("refetchFailedHint")} />
        ) : null}
        {prerequisitesLoading ? (
          <div aria-busy="true">
            <Skeleton className="h-24 w-full" />
          </div>
        ) : prerequisitesFailed ? (
          <LoadError variant="inline" title={t("loadFailed")} hint={t("loadFailedHint")} />
        ) : (
          <ul className="space-y-2.5">
            {prerequisites.map((prerequisite) => {
              /*
               * The icon carries the verdict for a sighted reader, so it
               * carries it for a screen reader too: a named image rather than
               * a hidden one, since the line's text alone ("Salar
               * tillgängliga 0") does not say whether 0 passes.
               */
              const verdict = t(`preState.${prerequisiteState(prerequisite)}`);
              return (
                <li key={prerequisite.label} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                  {prerequisite.ok ? (
                    <CheckCircle2 role="img" aria-label={verdict} className="size-5 shrink-0 text-success-strong" />
                  ) : prerequisite.warn ? (
                    <AlertTriangle role="img" aria-label={verdict} className="size-5 shrink-0 text-warning-strong" />
                  ) : (
                    <XCircle role="img" aria-label={verdict} className="size-5 shrink-0 text-destructive" />
                  )}
                  {prerequisite.href ? (
                    <Link href={prerequisite.href} className="flex-1 underline underline-offset-4">
                      {prerequisite.label}
                    </Link>
                  ) : (
                    <span className="flex-1">{prerequisite.label}</span>
                  )}
                  <span className="tabular-nums text-muted-foreground">{prerequisite.detail}</span>
                  {prerequisite.action ? (
                    <Link
                      href={prerequisite.action.href}
                      className="font-medium text-primary underline-offset-4 hover:underline"
                      data-writes={prerequisite.action.writes}
                    >
                      {prerequisite.action.label}
                    </Link>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      {/* items-start: Skolregler is three lines; stretched to the profile's
          height it was a card of empty space. */}
      <div className="grid items-start gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <SectionCard
          id="profile"
          title={t("profileTitle")}
          icon={SlidersHorizontal}
          description={t("profileHint")}
        >
          {/*
            Two sliders a row only while the card is the page's full width
            (sm to lg). Beside Skolregler (lg and up) the card is half the page,
            and two columns there broke every label over two or three lines.
          */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 [&>*]:min-w-0">
            {(
              [
                ["disruption", t("weightDisruption")],
                ["spread", t("weightSpread")],
                ["preferredFree", t("weightPreferredFree")],
                ["preferredBusy", t("weightPreferredBusy")],
                ["teacherGap", t("weightTeacherGap")],
              ] as const
            ).map(([key, label]) => (
              <div key={key} className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-3">
                  <Label htmlFor={`weight-${key}`}>{label}</Label>
                  <span className="shrink-0 text-sm tabular-nums text-muted-foreground">{weights[key]}</span>
                </div>
                {/*
                  50, while the API accepts 1000 — and that is deliberate,
                  not an oversight nobody documented.

                  These weights are RELATIVE: only the ratios between them
                  reach the objective, so a ceiling of 50 across all five
                  expresses every ratio up to 50:1, which is far past the
                  point where one term stops trading against another at all.
                  Widening the track to 1000 would leave the useful range —
                  nought to ten — inside the first one percent of it, and
                  unhittable with a mouse.
                */}
                <input
                  id={`weight-${key}`}
                  type="range"
                  min={0}
                  max={50}
                  value={weights[key]}
                  onChange={(e) => setWeight(key, Number(e.target.value))}
                  className="w-full accent-primary"
                />
              </div>
            ))}
          </div>
        </SectionCard>

        <SectionCard
          id="rules"
          title={t("rulesTitle")}
          description={t("rulesHint")}
          action={
            <Button variant="outline" size="sm" asChild>
              {/* #skolregler: the card on Tillgänglighet that holds them. */}
              <Link href="/admin/constraints#skolregler">{t("rulesEdit")}</Link>
            </Button>
          }
        >
          {lunchQuery.isError && lunchQuery.data !== undefined ? (
            <LoadError variant="inline" title={t("rulesLoadFailed")} hint={tCommon("refetchFailedHint")} />
          ) : null}
          {lunchQuery.isLoading ? (
            <div aria-busy="true">
              <Skeleton className="h-16 w-full" />
            </div>
          ) : lunchQuery.isError && lunchQuery.data === undefined ? (
            <LoadError variant="inline" title={t("rulesLoadFailed")} hint={t("rulesLoadFailedHint")} />
          ) : (
            <ul className="space-y-1 text-sm">
              <li>
                {lunchSettings?.lunchEnabled ? (
                  <>
                    {tLunch("summary", {
                      // formatTime, not a slice: the same five characters read
                      // "1970-" for as long as the endpoint sent the raw
                      // `@db.Time` column, and this line printed it as the
                      // school's lunch hour on the page you press generate from.
                      start: formatTime(lunchSettings.lunchStartTime),
                      end: formatTime(lunchSettings.lunchEndTime),
                      minutes: lunchSettings.lunchMinutes,
                    })}
                    {" · "}
                    {lunchSettings.diningSeats === null
                      ? tLunch("summaryNoSeats")
                      : tLunch("summarySeats", { seats: lunchSettings.diningSeats })}
                  </>
                ) : (
                  <span className="text-muted-foreground">{tLunch("notDefined")}</span>
                )}
              </li>
              {lunchSettings?.maxLessonsPerDayPerGroup ? (
                <li className="text-muted-foreground">
                  {t("ruleMaxPerDay")}: {lunchSettings.maxLessonsPerDayPerGroup}
                </li>
              ) : null}
              {lunchSettings?.generatorKeepsTravelTime ? (
                <li className="text-muted-foreground">{t("ruleTravel")}</li>
              ) : null}
            </ul>
          )}
        </SectionCard>
      </div>

      <CandidatesSection
        year={year}
        overview={candidatesQuery}
        canStart={canRun}
        generating={generating}
        weights={weights}
      />

      {job && (job.status === "SUCCEEDED" || job.status === "FAILED") ? (
        <SectionCard
          id="last-run"
          title={
            <span className="flex items-center gap-2">
              {job.status === "FAILED" || noScheduleProduced ? (
                <AlertTriangle className="size-4 shrink-0 text-warning-strong" />
              ) : (
                <CheckCircle2 className="size-4 shrink-0 text-success-strong" />
              )}
              {t("lastRun")}
            </span>
          }
          description={
            job.status === "FAILED"
              ? jobErrorText(job.errorCode) ??
                (job.error
                  ? (
                      <>
                        <p>
                          {engineText({
                            code: job.errorCode,
                            message: job.error,
                            params: job.errorParams,
                          })}
                        </p>
                        {errorNames.length > 0 ? <p className="font-medium">{errorNames.join(", ")}</p> : null}
                      </>
                    )
                  : tCommon("error"))
              : refusedUnstaffed
                ? t("statusUnstaffed")
                : refusedPartlyLocked
                  ? t("statusPartlyLocked")
                  : solverStatus
                  ? t(`status${solverStatus}`)
                  : undefined
          }
          descriptionClassName="text-foreground"
        >
          {job.status === "SUCCEEDED" && !noScheduleProduced ? (
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant="success">{t("lessonsGenerated", { count: job.lessonsGenerated })}</Badge>
              <Button asChild variant="outline">
                <Link
                  href={
                    year && !year.isActive
                      ? `/admin/timetable?year=${year.id}`
                      : "/admin/timetable"
                  }
                >
                  {t("viewTimetable")}
                  <ArrowRight />
                </Link>
              </Button>
            </div>
          ) : null}

          {refusedUnstaffed ? (
            <p className="text-sm">
              <Link
                href={staffingHref("unstaffed")}
                className="font-medium text-foreground underline underline-offset-4"
              >
                {t("preStaffedLink")}
              </Link>
            </p>
          ) : refusedPartlyLocked ? (
            <p className="max-w-prose text-sm text-muted-foreground">{t("partlyLockedHint")}</p>
          ) : solverStatus === "INFEASIBLE" ? (
            <p className="max-w-prose text-sm text-muted-foreground">{t("infeasibleHint")}</p>
          ) : solverStatus === "TIMEOUT" ? (
            <p className="max-w-prose text-sm text-muted-foreground">{t("timeoutHint")}</p>
          ) : null}

          {job.conflicts.length > 0 ? (
            <section aria-labelledby="last-run-conflicts" className="space-y-2">
              <h3 id="last-run-conflicts" className="text-sm font-semibold">
                {t("conflicts")}
              </h3>
              {job.conflictSummary ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    {engineText({
                      code: job.conflictSummaryCode,
                      message: job.conflictSummary,
                      params: job.conflictSummaryParams,
                    })}
                  </p>
                  {summaryNames.length > 0 ? <p className="text-sm font-medium">{summaryNames.join(", ")}</p> : null}
                </>
              ) : null}
              <ul className="space-y-2">
                {job.conflicts.map((conflict, index) => (
                  <li key={index}>
                    {/* role null: a finished list, not news — the card above
                        already said how the run ended. */}
                    <Notice tone="warning" role={null}>
                      <div className="space-y-1">
                        <Badge variant="warning">{conflictLabel(conflict.category)}</Badge>
                        {/* Foreground, not muted: muted text on the notice's
                            muted surface falls under 4.5:1. */}
                        <p>{engineText(conflict)}</p>
                        {conflict.resourceNames && conflict.resourceNames.length > 0 ? (
                          <p className="font-medium">{conflict.resourceNames.join(", ")}</p>
                        ) : null}
                      </div>
                    </Notice>
                  </li>
                ))}
              </ul>
            </section>
          ) : job.status === "SUCCEEDED" && solverStatus === "INFEASIBLE" ? (
            <p className="text-sm text-muted-foreground">{t("noConflicts")}</p>
          ) : null}

          {/*
            Plain lines rather than the conflicts' warning boxes, and no
            category badge: nothing here stopped the run or needs fixing
            before the next one. Each sentence is the engine catalogue's
            through engineText, so it reads in the reader's language and
            falls back to the gateway's English like every refusal above.
          */}
          {job.status === "SUCCEEDED" && notes.length > 0 && appliedSince ? (
            <section aria-labelledby="last-run-notes" className="space-y-2">
              <h3 id="last-run-notes" className="text-sm font-semibold">
                {t("notesTitle")}
              </h3>
              <p className="max-w-prose text-sm text-muted-foreground">
                {supersededText}
                {comparisonHasIt ? (
                  <>
                    {" "}
                    {t("notesSupersededCompare")}{" "}
                    <Link
                      href={`${candidatesHref(year ?? null)}#comparison`}
                      className="font-medium text-foreground underline underline-offset-4"
                    >
                      {t("notesSupersededLink")}
                    </Link>
                  </>
                ) : null}
              </p>
            </section>
          ) : job.status === "SUCCEEDED" && notes.length > 0 ? (
            <section aria-labelledby="last-run-notes" className="space-y-2">
              <h3 id="last-run-notes" className="text-sm font-semibold">
                {t("notesTitle")}
              </h3>
              <p className="max-w-prose text-sm text-muted-foreground">{t("notesHint")}</p>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {/*
                  WHOSE WISH, under the sentence as a conflict's groups are.
                  The sentence names only the weekday: the gateway keeps the
                  teacher's id beside the note on the server and names them
                  here at read time, for every reader — a free-day wish is
                  staff-readable, not HR, so unlike a days refusal nobody's
                  list comes back empty for want of HR-läs. Empty or absent
                  (a run stored before the names) draws nothing rather than
                  an empty line.
                */}
                {notes.map((note, index) => (
                  <li key={index}>
                    <p>{engineText(note)}</p>
                    {note.resourceNames && note.resourceNames.length > 0 ? (
                      <p className="font-medium">{note.resourceNames.join(", ")}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </SectionCard>
      ) : null}

      <SectionCard id="history" title={t("historyTitle")} icon={History} description={t("historyHint")}>
        {historyQuery.isError && history !== undefined ? (
          <LoadError variant="inline" title={t("historyLoadFailed")} hint={tCommon("refetchFailedHint")} />
        ) : null}
        {/*
          The history is the year's, so it waits for the year as the checklist
          does: without one the request is never made, and the list would read
          as "no runs yet" for a school whose years are on their way or failed.
        */}
        {historyQuery.isLoading || yearsQuery.isLoading || resolvingYear ? (
          <div aria-busy="true">
            <Skeleton className="h-16 w-full" />
          </div>
        ) : historyQuery.isError && history === undefined ? (
          <LoadError variant="inline" title={t("historyLoadFailed")} hint={t("historyLoadFailedHint")} />
        ) : !year && yearsQuery.isError ? (
          <LoadError variant="inline" title={t("historyLoadFailed")} hint={t("historyYearsLoadFailedHint")} />
        ) : !year ? (
          <p className="text-sm text-muted-foreground">{t("historyNoYear")}</p>
        ) : (history ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("historyEmpty")}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {(history ?? []).map((run) => (
              <li
                key={run.id}
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-sm"
              >
                <span className="whitespace-nowrap tabular-nums text-muted-foreground">
                  {runDate.format(new Date(run.createdAt))}
                </span>
                <span className="flex items-center gap-2">
                  <Badge variant={solverRunVariant(run)}>{t(`historyStatus.${historyStatusKey(run)}`)}</Badge>
                  <span className="tabular-nums text-muted-foreground">
                    {t("lessonsGenerated", { count: run.lessonsGenerated })}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </Page>
  );
}
