"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { ClipboardCheck } from "lucide-react";
import { usePeople } from "@/lib/queries";
import { useLeaveRequestActions, useLeaveRequests } from "@/lib/guardian-queries";
import { LEAVE_STATUS_VARIANT } from "@/lib/status-variants";
import { DecisionList, type Decision, type DecisionRequest } from "@/components/admin/decision-list";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { PurgedNotice } from "@/components/retention/purged-notice";
import { FilterBar } from "@/components/ui/filter-bar";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Filter = "PENDING" | "APPROVED" | "REJECTED";

export default function LeaveRequestsPage() {
  const t = useTranslations("adminLeave");
  const tGuardian = useTranslations("guardian");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const [filter, setFilter] = useState<Filter>("PENDING");
  const { data: leaves, isLoading, isError } = useLeaveRequests(filter);
  const peopleQuery = usePeople();
  const actions = useLeaveRequestActions();

  const personName = useMemo(() => {
    const byId = new Map((peopleQuery.data ?? []).map((person) => [person.id, person]));
    return (id: string) => {
      const person = byId.get(id);
      return person ? `${person.firstName} ${person.lastName}` : "—";
    };
  }, [peopleQuery.data]);

  // A leave's dates are calendar days, read at UTC midnight so no time zone
  // moves them to the day before; when it was asked is the reader's own day.
  const days = useMemo(
    () => new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }),
    [locale],
  );
  const asked = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }), [locale]);
  const dayOf = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);

  const decide = async (id: string, status: Decision, note: string | undefined) => {
    try {
      const result = await actions.decide.mutateAsync({ id, status, note });
      toast.success(
        status === "APPROVED"
          ? t("approved", { count: (result as { absenceDays?: number }).absenceDays ?? 0 })
          : t("rejected"),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const requests: DecisionRequest[] = (leaves ?? []).map((leave) => {
    const student = personName(leave.studentId);
    const start = dayOf(leave.startDate);
    const end = dayOf(leave.endDate);
    const period = start.getTime() === end.getTime() ? days.format(start) : days.formatRange(start, end);
    return {
      id: leave.id,
      title: (
        <>
          {student}
          <span className="ml-2 font-normal tabular-nums text-muted-foreground">{period}</span>
        </>
      ),
      name: `${student}, ${period}`,
      details: [
        ...(leave.reason ? [leave.reason] : []),
        <span key="who" className="text-xs">
          {t("requestedBy", { name: personName(leave.requestedById) })} · {asked.format(new Date(leave.createdAt))}
        </span>,
      ],
      open: leave.status === "PENDING",
      status: { label: tGuardian(`status${leave.status}`), variant: LEAVE_STATUS_VARIANT[leave.status] },
    };
  });

  return (
    <Page>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      <FilterBar>
        <Tabs value={filter} onValueChange={(value) => setFilter(value as Filter)}>
          <TabsList aria-label={t("filterLabel")}>
            <TabsTrigger value="PENDING">{tGuardian("statusPENDING")}</TabsTrigger>
            <TabsTrigger value="APPROVED">{tGuardian("statusAPPROVED")}</TabsTrigger>
            <TabsTrigger value="REJECTED">{tGuardian("statusREJECTED")}</TabsTrigger>
          </TabsList>
        </Tabs>
      </FilterBar>

      {peopleQuery.isError ? (
        <LoadError variant="inline" title={t("namesFailed")} hint={t("namesFailedHint")} />
      ) : null}

      {/* Decided requests end in the past, and gallring takes the old ones. */}
      {filter !== "PENDING" ? <PurgedNotice kind="LEAVE_REQUESTS" /> : null}

      {isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : isError ? (
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      ) : requests.length === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title={t("emptyTitle", { status: filter })}
          description={t("emptyHint")}
          headingLevel={2}
        />
      ) : (
        <DecisionList
          id="leave-requests"
          title={t("listTitle", { status: filter })}
          requests={requests}
          labels={{ approve: t("approve"), reject: t("reject"), note: t("noteLabel") }}
          rejectCopy={(request) => {
            const leave = leaves?.find((candidate) => candidate.id === request.id);
            return {
              title: t("rejectTitle", { name: leave ? personName(leave.studentId) : "—" }),
              body: t("rejectBody"),
            };
          }}
          deciding={actions.decide.isPending ? (actions.decide.variables?.id ?? null) : null}
          onDecide={decide}
        />
      )}
    </Page>
  );
}
