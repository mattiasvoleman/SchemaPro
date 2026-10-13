"use client";

import { useQuery } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { api } from "@/lib/api";
import { KpiStrip, KpiTile } from "@/components/ui/kpi";
import { LoadError } from "@/components/ui/load-error";

/** GET /api/v1/users/counts: every Users row of the school, active or not. */
interface UserCounts {
  byRole: Record<"STUDENT" | "TEACHER" | "GUARDIAN" | "SCHOOL_ADMIN", number>;
}

/** GET /api/v1/attendance/summary: records since a day; present is PRESENT or LATE. */
interface AttendanceSummary {
  recorded: number;
  present: number;
}

/** The figures the server counted through PostgREST: formatted, or null for one that failed. */
export interface ServerCounts {
  groups: string | null;
  rooms: string | null;
  lessonsToday: string | null;
  requirements: string | null;
  masterLessons: string | null;
}

/**
 * The dashboard's KPI strip. Pupils, teachers and the week's attendance are
 * the gateway's (an admin's PostgREST reads no other person's Users or
 * AttendanceRecords row since the läslogg), asked from the browser: from the
 * Next server every admin of every school would come from one address and
 * share the gateway's one throttle bucket per address. The rest the server
 * counted. A figure that could not be read is "—" with the notice above,
 * never a 0; one still coming is "—" without it.
 */
export function DashboardKpis({
  server,
  serverFailed,
  since,
}: {
  server: ServerCounts;
  serverFailed: boolean;
  /** The first day of the attendance figure, yyyy-mm-dd. */
  since: string;
}) {
  const t = useTranslations("dashboard");
  const locale = useLocale();
  const people = useQuery({
    queryKey: ["dashboard", "userCounts"],
    queryFn: () => api.get<UserCounts>("/api/v1/users/counts"),
  });
  const attendance = useQuery({
    queryKey: ["dashboard", "attendanceSummary", since],
    queryFn: () => api.get<AttendanceSummary>(`/api/v1/attendance/summary?since=${encodeURIComponent(since)}`),
  });

  const number = new Intl.NumberFormat(locale);
  // An answer without the role's figure is as much a failure as no answer.
  const roleCount = (role: keyof UserCounts["byRole"]) => {
    const count = people.data?.byRole?.[role];
    return typeof count === "number" ? number.format(count) : null;
  };
  const students = roleCount("STUDENT");
  const teachers = roleCount("TEACHER");
  const peopleFailed = people.isError || (people.isSuccess && (students === null || teachers === null));

  // No records in the week is no rate, but no failure either; an answer
  // without its two figures is one.
  const recorded = attendance.data?.recorded;
  const present = attendance.data?.present;
  const attendanceFailed =
    attendance.isError || (attendance.isSuccess && (typeof recorded !== "number" || typeof present !== "number"));
  const attendanceRate =
    typeof recorded === "number" && typeof present === "number" && recorded > 0
      ? new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(present / recorded)
      : null;

  const kpis = [
    { label: t("students"), value: students },
    { label: t("teachers"), value: teachers },
    { label: t("groups"), value: server.groups },
    { label: t("rooms"), value: server.rooms },
    { label: t("lessonsToday"), value: server.lessonsToday },
    { label: t("attendanceRate"), value: attendanceRate },
    { label: t("requirements"), value: server.requirements },
    { label: t("masterLessons"), value: server.masterLessons },
  ];

  return (
    <>
      {serverFailed || peopleFailed || attendanceFailed ? (
        <LoadError variant="inline" title={t("loadFailed")} hint={t("loadFailedHint")} />
      ) : null}
      <KpiStrip>
        {kpis.map((kpi) => (
          <KpiTile key={kpi.label} label={kpi.label} value={kpi.value} />
        ))}
      </KpiStrip>
    </>
  );
}
