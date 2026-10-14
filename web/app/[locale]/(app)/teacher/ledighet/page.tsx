"use client";

// /teacher/ledighet — Ledighet, the mentor's inbox (Mentorns
// ledighetsbeslut, 20261023091000).
//
// The leave requests rektor's delegation gives this teacher to decide: a
// pupil whose class they hold MENTORSKAP for on the request's dates, and a
// request of at most the delegation's skoldagar. Read through the gateway,
// because the arms that let a mentor read a request and its reason are the
// API's alone; the teacher's own Supabase session reads no leave request.
// Each row says its skoldagar, the pupil's leave so far this läsår and the
// family's reason, and offers Bevilja, Avslå and Skicka till rektor. The tabs
// for decided requests show the mentor's own decisions only.
//
// A school that has delegated nothing shows that, rather than an empty list:
// rektor decides every request there. The delegation is GET
// /api/v1/leave-delegation's, which a teacher reads too.
//
// Bundle: core tier (170KB), like the teacher's other pages. DecisionList
// brings its own ConfirmDialog; nothing else here is lazy.

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ClipboardCheck } from "lucide-react";
import { useProfile } from "@/components/profile-context";
import { leaveActionError } from "@/lib/leave-errors";
import { useLeaveDelegation, useLeaveInbox, useLeaveInboxActions } from "@/lib/leave-queries";
import { DecisionList, type Decision } from "@/components/admin/decision-list";
import { DelegationNotice } from "@/components/leave/delegation-notice";
import { useLeaveRows } from "@/components/leave/leave-rows";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { PurgedNotice } from "@/components/retention/purged-notice";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar } from "@/components/ui/filter-bar";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Filter = "PENDING" | "APPROVED" | "REJECTED";

export default function TeacherLeavePage() {
  const t = useTranslations("teacherLeave");
  const tGuardian = useTranslations("guardian");
  const tInbox = useTranslations("leaveInbox");
  const tCommon = useTranslations("common");
  const { profile } = useProfile();
  const [filter, setFilter] = useState<Filter>("PENDING");
  const inbox = useLeaveInbox(filter);
  const delegationQuery = useLeaveDelegation();
  const actions = useLeaveInboxActions();
  const delegation = delegationQuery.data?.current ?? null;
  const rowOf = useLeaveRows("mentor", delegation, profile.id);
  const requests = inbox.data ?? [];
  // Until the delegation is read, an empty inbox says nothing waits, never
  // that rektor decides everything.
  const delegated = !delegationQuery.data || delegation?.mentorMaxSchoolDays != null;

  const busy = actions.decide.isPending
    ? (actions.decide.variables?.id ?? null)
    : actions.refer.isPending
      ? (actions.refer.variables ?? null)
      : null;

  // A request a co-mentor or rektor decided first, or one passed on, is no
  // longer the mentor's: the gateway answers 409, or 404 once it is out of
  // their reach, and the inbox is read again either way (useLeaveInboxActions).
  const failed = (error: unknown) =>
    leaveActionError(error, "mentor", { alreadyDecided: tInbox("noLongerYours"), fallback: tCommon("error") });

  const decide = async (id: string, status: Decision, note: string | undefined) => {
    try {
      const result = await actions.decide.mutateAsync({ id, status, note });
      toast.success(status === "APPROVED" ? t("approved", { count: result.absenceDays }) : t("rejected"));
    } catch (error) {
      toast.error(failed(error));
    }
  };

  const refer = async (id: string) => {
    try {
      await actions.refer.mutateAsync(id);
      toast.success(t("referred"));
    } catch (error) {
      toast.error(failed(error));
    }
  };

  return (
    <Page width="wide">
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      {delegationQuery.data ? <DelegationNotice delegation={delegation} /> : null}

      <FilterBar>
        <Tabs value={filter} onValueChange={(value) => setFilter(value as Filter)}>
          <TabsList aria-label={t("filterLabel")}>
            <TabsTrigger value="PENDING">{tGuardian("statusPENDING")}</TabsTrigger>
            <TabsTrigger value="APPROVED">{tGuardian("statusAPPROVED")}</TabsTrigger>
            <TabsTrigger value="REJECTED">{tGuardian("statusREJECTED")}</TabsTrigger>
          </TabsList>
        </Tabs>
      </FilterBar>

      {filter !== "PENDING" ? <PurgedNotice kind="LEAVE_REQUESTS" /> : null}

      {inbox.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : inbox.isError ? (
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      ) : requests.length === 0 ? (
        <EmptyState
          icon={ClipboardCheck}
          title={filter === "PENDING" && !delegated ? t("noDelegationTitle") : t("emptyTitle", { status: filter })}
          description={filter === "PENDING" && !delegated ? t("noDelegationHint") : t("emptyHint")}
          headingLevel={2}
        />
      ) : (
        <DecisionList
          id="mentor-leave-requests"
          title={t("listTitle", { status: filter })}
          requests={requests.map(rowOf)}
          labels={{ approve: t("approve"), reject: t("reject"), note: t("noteLabel") }}
          rejectCopy={(request) => {
            const leave = requests.find((candidate) => candidate.id === request.id);
            return { title: t("rejectTitle", { name: leave?.student.name ?? "—" }), body: t("rejectBody") };
          }}
          extra={{
            label: t("refer"),
            confirm: (request) => {
              const leave = requests.find((candidate) => candidate.id === request.id);
              return { title: t("referTitle", { name: leave?.student.name ?? "—" }), body: t("referBody") };
            },
            onAct: refer,
          }}
          deciding={busy}
          onDecide={decide}
        />
      )}
    </Page>
  );
}
