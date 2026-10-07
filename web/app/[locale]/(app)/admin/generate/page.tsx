"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
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
import { engineMessage, type MessageLookup } from "@/lib/engine-message";
import {
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
} from "@/lib/queries";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatTime } from "@/lib/utils";
import { buildGradeSpans } from "@/lib/grade-span";
import { useStaffingPolicy } from "@/lib/staffing-queries";
import { usePlanningYear } from "@/lib/planning-year";
import { withProjectedHomes } from "@/lib/projected-rosters";
import {
  PlanningYearPicker,
  ProjectedRostersBanner,
} from "@/components/schedule/planning-year";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export default function GeneratePage() {
  const t = useTranslations("generate");
  const tLunch = useTranslations("lunch");
  const tConflicts = useTranslations("conflictCategories");
  const tEngine = useTranslations("engineMessages");
  const tCommon = useTranslations("common");
  /*
   * The year generated for: this one, or next year before its activation.
   * Next year's classes have no home pupils until then, so the people are
   * read with the class the activation will give each pupil it moves — the
   * overlay the gateway's generation itself reads (lib/projected-rosters.ts).
   * The warning below is derived from them, and must say what the run will do.
   */
  const planning = usePlanningYear();
  const { year } = planning;
  const { data: requirements } = useRequirements(year?.id ?? null);
  const { data: rooms } = useRooms();
  const { data: storedPeople } = usePeople();
  const people = useMemo(
    () => withProjectedHomes(storedPeople, planning.rosters),
    [storedPeople, planning.rosters],
  );
  const { data: groups } = useGroups();
  const { data: memberships } = useGroupMemberships();
  /**
   * Whether the school refuses to generate while a timplanspost has no lärare
   * (StaffingPolicy.unstaffedGeneration). Read only to say so BEFORE the run:
   * the gateway's pre-flight is what actually refuses
   * (OptimizationProxyService.unstaffedRefusal), so a policy that has not
   * answered yet, or failed, blocks nothing here — the run would come back as
   * the same refusal, named, in the result card below.
   */
  const { data: staffingPolicy } = useStaffingPolicy();
  const unstaffedCount = useMemo(
    () => (requirements ?? []).filter((requirement) => requirement.teacherId === null).length,
    [requirements],
  );
  const refusesUnstaffed = staffingPolicy?.unstaffedGeneration === "REFUSE";
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
  const { data: history } = useOptimizationHistory(year?.id ?? null);

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
  const { data: lunchSettings } = useLunchSettings();

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
     * lärare" read as "none of them has one".
     */
    {
      label: t("preStaffed"),
      ok: unstaffedCount === 0,
      warn: unstaffedCount > 0 && !refusesUnstaffed,
      detail: unstaffedCount === 0 ? "" : t("preStaffedMissing", { count: unstaffedCount }),
      href: unstaffedCount > 0 ? "/admin/staffing#unstaffed" : undefined,
    },
  ];

  const canRun = prerequisites.every((prerequisite) => prerequisite.ok || prerequisite.warn);
  const isRunning =
    startOptimization.isPending ||
    job?.status === "PENDING" ||
    job?.status === "RUNNING";

  const run = async () => {
    if (!year) return;
    try {
      const { jobId: newJobId } = await startOptimization.mutateAsync({
        academicYearId: year.id,
        weights,
      });
      setJobId(newJobId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

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

  return (
    <div className="mx-auto max-w-3xl">
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
        <div
          role="status"
          className="mb-6 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <div className="space-y-1">
            <p className="font-medium">
              {t("noYearTitle", { count: spanlessGroups.length })}
            </p>
            <p>{t("noYearBody")}</p>
            <p className="font-medium">{spanlessGroups.join(", ")}</p>
            <Link href="/admin/groups" className="underline underline-offset-4">
              {t("noYearLink")}
            </Link>
          </div>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t("prerequisites")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2.5">
            {prerequisites.map((prerequisite) => (
              <li key={prerequisite.label} className="flex items-center gap-3 text-sm">
                {prerequisite.ok ? (
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-success" />
                ) : prerequisite.warn ? (
                  <AlertTriangle className="h-5 w-5 shrink-0 text-warning" />
                ) : (
                  <XCircle className="h-5 w-5 shrink-0 text-destructive" />
                )}
                {prerequisite.href ? (
                  <Link
                    href={prerequisite.href}
                    className="flex-1 underline underline-offset-4"
                  >
                    {prerequisite.label}
                  </Link>
                ) : (
                  <span className="flex-1">{prerequisite.label}</span>
                )}
                <span className="tabular-nums text-muted-foreground">
                  {prerequisite.detail}
                </span>
              </li>
            ))}
          </ul>

          <div className="mt-6 rounded-md border p-4">
            <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold">
              <SlidersHorizontal className="h-4 w-4" />
              {t("profileTitle")}
            </h3>
            <p className="mb-4 text-xs text-muted-foreground">{t("profileHint")}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              {(
                [
                  ["disruption", t("weightDisruption")],
                  ["spread", t("weightSpread")],
                  ["preferredFree", t("weightPreferredFree")],
                  ["preferredBusy", t("weightPreferredBusy")],
                  ["teacherGap", t("weightTeacherGap")],
                ] as const
              ).map(([key, label]) => (
                <div key={key} className="space-y-1">
                  <div className="flex items-center justify-between">
                    <Label htmlFor={`weight-${key}`} className="text-xs">
                      {label}
                    </Label>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {weights[key]}
                    </span>
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
          </div>

          <div className="mt-4 rounded-md border p-4">
            <div className="mb-1 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold">{t("rulesTitle")}</h3>
              <Link
                href="/admin/constraints"
                className="text-xs font-medium text-primary underline-offset-4 hover:underline"
              >
                {t("rulesEdit")}
              </Link>
            </div>
            <p className="mb-3 text-xs text-muted-foreground">{t("rulesHint")}</p>
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
            </ul>
          </div>

          <Button
            className="mt-6 w-full"
            size="lg"
            disabled={!canRun || isRunning}
            onClick={run}
            aria-describedby={blockedByStaffing ? "generate-blocked-unstaffed" : undefined}
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
          {/*
            The same sentence as the prerequisite line, under the button it
            disables — a greyed button with no reason beside it is a button
            people click at and then call support about.
          */}
          {blockedByStaffing ? (
            <p id="generate-blocked-unstaffed" className="mt-2 text-sm text-foreground">
              {t("preStaffed")} ({t("preStaffedMissing", { count: unstaffedCount })}).{" "}
              {t("runBlockedUnstaffed")}{" "}
              <Link href="/admin/staffing#unstaffed" className="underline underline-offset-4">
                {t("preStaffedLink")}
              </Link>
            </p>
          ) : null}
        </CardContent>
      </Card>

      {job && (job.status === "SUCCEEDED" || job.status === "FAILED") ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {job.status === "FAILED" || noScheduleProduced ? (
                <AlertTriangle className="h-5 w-5 text-warning" />
              ) : (
                <CheckCircle2 className="h-5 w-5 text-success" />
              )}
              {t("lastRun")}
            </CardTitle>
            <CardDescription>
              {job.status === "FAILED"
                ? job.error
                  ? engineText({
                      code: job.errorCode,
                      message: job.error,
                      params: job.errorParams,
                    })
                  : tCommon("error")
                : refusedUnstaffed
                  ? t("statusUnstaffed")
                  : solverStatus
                    ? t(`status${solverStatus}`)
                    : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {job.status === "SUCCEEDED" && !noScheduleProduced ? (
              <>
                <Badge variant="success">
                  {t("lessonsGenerated", { count: job.lessonsGenerated })}
                </Badge>
                <div>
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
              </>
            ) : null}

            {refusedUnstaffed ? (
              <p className="text-sm text-muted-foreground">
                <Link
                  href="/admin/staffing#unstaffed"
                  className="font-medium text-foreground underline underline-offset-4"
                >
                  {t("preStaffedLink")}
                </Link>
              </p>
            ) : solverStatus === "INFEASIBLE" ? (
              <p className="text-sm text-muted-foreground">{t("infeasibleHint")}</p>

            ) : solverStatus === "TIMEOUT" ? (
              <p className="text-sm text-muted-foreground">{t("timeoutHint")}</p>
            ) : null}

            {job.conflicts.length > 0 ? (
              <div>
                <h3 className="mb-2 text-sm font-semibold">{t("conflicts")}</h3>
                {job.conflictSummary ? (
                  <p className="mb-3 text-sm text-muted-foreground">
                    {engineText({
                      code: job.conflictSummaryCode,
                      message: job.conflictSummary,
                      params: job.conflictSummaryParams,
                    })}
                  </p>
                ) : null}
                <ul className="space-y-2">
                  {job.conflicts.map((conflict, index) => (
                    <li
                      key={index}
                      className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm"
                    >
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                      <div>
                        <Badge variant="warning" className="mb-1">
                          {conflictLabel(conflict.category)}
                        </Badge>
                        <p className="text-muted-foreground">{engineText(conflict)}</p>
                        {conflict.resourceNames && conflict.resourceNames.length > 0 ? (
                          <p className="mt-1 font-medium">{conflict.resourceNames.join(", ")}</p>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : job.status === "SUCCEEDED" && solverStatus === "INFEASIBLE" ? (
              <p className="text-sm text-muted-foreground">{t("noConflicts")}</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {(history ?? []).length > 0 ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <History className="h-5 w-5" />
              {t("historyTitle")}
            </CardTitle>
            <CardDescription>{t("historyHint")}</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {(history ?? []).map((run) => (
                <li
                  key={run.id}
                  className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
                >
                  <span className="tabular-nums text-muted-foreground">
                    {new Date(run.createdAt).toLocaleString()}
                  </span>
                  <span className="flex items-center gap-2">
                    {run.status === "FAILED" ? (
                      <Badge variant="destructive">{run.status}</Badge>
                    ) : run.solverStatus === "INFEASIBLE" ||
                      run.solverStatus === "TIMEOUT" ? (
                      <Badge variant="warning">{run.solverStatus}</Badge>
                    ) : (
                      <Badge variant="success">{run.solverStatus ?? run.status}</Badge>
                    )}
                    <span className="tabular-nums text-muted-foreground">
                      {t("lessonsGenerated", { count: run.lessonsGenerated })}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
