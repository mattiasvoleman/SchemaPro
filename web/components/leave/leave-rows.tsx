"use client";

import { useMemo } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { DecisionRequest } from "@/components/admin/decision-list";
import type { LeaveDelegation, LeaveInboxRequest } from "@/lib/leave-queries";
import { LEAVE_STATUS_VARIANT } from "@/lib/status-variants";

/*
 * One leave request as a DecisionList row, for rektor's inbox and the
 * mentor's. Both show the same facts, because both decide on them: the
 * request's skoldagar (weekends and lov not counted), who decides it now and
 * why, the pupil's leave so far this läsår, the family's reason and who
 * asked. Rektor also reads which mentor holds a request, and the mentor which
 * co-mentor may decide it first.
 */

/** "Ella Elev (7A)" and the period, as the row's first line. */
function titleOf(request: LeaveInboxRequest, period: string): React.ReactNode {
  return (
    <>
      {request.student.name}
      {request.student.className ? <span className="font-normal"> ({request.student.className})</span> : null}
      {/* A real space: the margin alone read "Ines Vik (7A)20–24 okt" aloud. */}{" "}
      <span className="ml-1 font-normal tabular-nums text-muted-foreground">{period}</span>
    </>
  );
}

export function useLeaveRows(view: "admin" | "mentor", delegation: LeaveDelegation | null, me?: string | null) {
  const t = useTranslations("leaveInbox");
  const tGuardian = useTranslations("guardian");
  const locale = useLocale();
  // A leave's dates are calendar days, read at UTC midnight so no time zone
  // moves them to the day before; when it was asked is the reader's own day.
  const days = useMemo(
    () => new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }),
    [locale],
  );
  const asked = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }), [locale]);

  return (request: LeaveInboxRequest): DecisionRequest => {
    const start = new Date(`${request.startDate}T00:00:00.000Z`);
    const end = new Date(`${request.endDate}T00:00:00.000Z`);
    const period = start.getTime() === end.getTime() ? days.format(start) : days.formatRange(start, end);
    const names = (people: Array<{ name: string }>) => people.map((person) => person.name).join(", ");

    const who: string[] = request.schoolDays === null ? [] : [t("schoolDays", { count: request.schoolDays })];
    if (request.status === "PENDING") {
      if (view === "admin") {
        if (request.decidingMentors.length > 0) who.push(t("decidesMentor", { names: names(request.decidingMentors) }));
        else if (request.referral) who.push(t("referredBy", { name: request.referral.by ?? "—" }));
        else if (delegation?.mentorMaxSchoolDays == null) who.push(t("decidesAdmin"));
        else if (request.mentors.length === 0) who.push(t("decidesAdminNoMentor"));
        else who.push(t("decidesAdminOverLimit", { limit: delegation.mentorMaxSchoolDays }));
      } else {
        const others = request.decidingMentors.filter((mentor) => mentor.id !== me);
        if (others.length > 0) who.push(t("sharedWith", { names: names(others) }));
      }
    } else if (request.decidedAs === "MENTOR") {
      who.push(t("decidedByMentor", { name: request.decidedByName ?? "—" }));
    } else if (request.decidedAs === "ADMIN") {
      who.push(t("decidedByAdmin", { name: request.decidedByName ?? "—" }));
    }

    const year = request.year
      ? request.year.approvedRequests === 0 && request.year.pendingRequests === 0
        ? t("yearNone", { year: request.year.name })
        : t("yearSoFar", {
            year: request.year.name,
            days: request.year.approvedDays,
            requests: request.year.approvedRequests,
            pending: request.year.pendingRequests,
          })
      : null;

    const name = `${request.student.name}, ${period}`;
    return {
      id: request.id,
      title: titleOf(request, period),
      name,
      details: [
        who.join(" · "),
        ...(year ? [year] : []),
        request.reason,
        ...(request.decisionNote ? [t("decisionNote", { note: request.decisionNote })] : []),
        <span key="who" className="text-xs">
          {t("requestedBy", { name: request.requestedBy ?? "—" })} · {asked.format(new Date(request.createdAt))}
        </span>,
      ],
      open: request.status === "PENDING",
      status: { label: tGuardian(`status${request.status}`), variant: LEAVE_STATUS_VARIANT[request.status] },
    };
  };
}
