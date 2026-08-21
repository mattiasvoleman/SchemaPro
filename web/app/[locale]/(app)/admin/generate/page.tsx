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
import {
  useActiveYear,
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
  const tCommon = useTranslations("common");
  const { activeYear } = useActiveYear();
  const { data: requirements } = useRequirements(activeYear?.id ?? null);
  const { data: rooms } = useRooms();
  const { data: people } = usePeople();

  const startOptimization = useStartOptimization();
  const [jobId, setJobId] = useState<string | null>(null);
  const { data: job } = useOptimizationJob(jobId);
  const { data: history } = useOptimizationHistory(activeYear?.id ?? null);

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

  const teacherCount = useMemo(
    () => (people ?? []).filter((person) => person.role === "TEACHER" && person.isActive).length,
    [people],
  );

  const prerequisites = [
    { label: t("preYear"), ok: activeYear !== null, detail: activeYear?.name ?? "—" },
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
  ];

  const canRun = prerequisites.every((prerequisite) => prerequisite.ok);
  const isRunning =
    startOptimization.isPending ||
    job?.status === "PENDING" ||
    job?.status === "RUNNING";

  const run = async () => {
    if (!activeYear) return;
    try {
      const { jobId: newJobId } = await startOptimization.mutateAsync({
        academicYearId: activeYear.id,
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

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

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
                ) : (
                  <XCircle className="h-5 w-5 shrink-0 text-destructive" />
                )}
                <span className="flex-1">{prerequisite.label}</span>
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
                      start: lunchSettings.lunchStartTime.slice(0, 5),
                      end: lunchSettings.lunchEndTime.slice(0, 5),
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
                ? (job.error ?? tCommon("error"))
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
                    <Link href="/admin/timetable">
                      {t("viewTimetable")}
                      <ArrowRight />
                    </Link>
                  </Button>
                </div>
              </>
            ) : null}

            {solverStatus === "INFEASIBLE" ? (
              <p className="text-sm text-muted-foreground">{t("infeasibleHint")}</p>
            ) : solverStatus === "TIMEOUT" ? (
              <p className="text-sm text-muted-foreground">{t("timeoutHint")}</p>
            ) : null}

            {job.conflicts.length > 0 ? (
              <div>
                <h3 className="mb-2 text-sm font-semibold">{t("conflicts")}</h3>
                {job.conflictSummary ? (
                  <p className="mb-3 text-sm text-muted-foreground">{job.conflictSummary}</p>
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
                        <p className="text-muted-foreground">{conflict.message}</p>
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
