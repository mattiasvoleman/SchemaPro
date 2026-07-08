"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  Sparkles,
  XCircle,
} from "lucide-react";
import { Link } from "@/i18n/navigation";
import {
  useActiveYear,
  useOptimizationJob,
  usePeople,
  useRequirements,
  useRooms,
  useStartOptimization,
} from "@/lib/queries";
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
  const tCommon = useTranslations("common");
  const { activeYear } = useActiveYear();
  const { data: requirements } = useRequirements(activeYear?.id ?? null);
  const { data: rooms } = useRooms();
  const { data: people } = usePeople();

  const startOptimization = useStartOptimization();
  const [jobId, setJobId] = useState<string | null>(null);
  const { data: job } = useOptimizationJob(jobId);

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
      const { jobId: newJobId } = await startOptimization.mutateAsync(activeYear.id);
      setJobId(newJobId);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const solverStatus = job?.status === "SUCCEEDED" ? job.solverStatus : null;

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
              {job.status === "FAILED" || solverStatus === "INFEASIBLE" ? (
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
            {job.status === "SUCCEEDED" && solverStatus !== "INFEASIBLE" ? (
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
                          {conflict.category}
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
    </div>
  );
}
