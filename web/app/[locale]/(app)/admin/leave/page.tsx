"use client";

import { Suspense, lazy, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ClipboardCheck, Pencil } from "lucide-react";
import { leaveActionError } from "@/lib/leave-errors";
import { useLeaveDelegation, useLeaveInbox, useLeaveInboxActions } from "@/lib/leave-queries";
import { DecisionList, type Decision } from "@/components/admin/decision-list";
import { DelegationNotice } from "@/components/leave/delegation-notice";
import { useLeaveRows } from "@/components/leave/leave-rows";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { DialogLoadBoundary } from "@/components/schedule/dialog-load-boundary";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PurgedNotice } from "@/components/retention/purged-notice";
import { useProfile } from "@/components/profile-context";
import { profileDecides } from "@/lib/admin-areas";
import { FilterBar } from "@/components/ui/filter-bar";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const DelegationDialog = lazy(() =>
  import("@/components/leave/delegation-dialog").then((module) => ({ default: module.DelegationDialog })),
);

type Filter = "PENDING" | "APPROVED" | "REJECTED";

/**
 * Ledighetsansökningar: rektor's inbox, through the gateway
 * (GET /api/v1/leave-requests), with rektor's delegation above it.
 *
 * Pending requests come in two lists: the ones rektor decides (over the
 * delegation's limit, a pupil with no mentor on those dates, passed on by the
 * mentor, or every request when nothing is delegated) and the ones that wait
 * for the pupil's mentor. Rektor may decide those too; the first decision
 * wins. Every row says its skoldagar and the pupil's leave so far this läsår.
 */
export default function LeaveRequestsPage() {
  const t = useTranslations("adminLeave");
  const tGuardian = useTranslations("guardian");
  const tInbox = useTranslations("leaveInbox");
  const tCommon = useTranslations("common");
  const [filter, setFilter] = useState<Filter>("PENDING");
  const inbox = useLeaveInbox(filter);
  const delegation = useLeaveDelegation();
  const actions = useLeaveInboxActions();
  const [editOpen, setEditOpen] = useState(false);
  const [editUsed, setEditUsed] = useState(false);
  const [editLoad, setEditLoad] = useState(0);
  // Roller i skolan: delegating leave decisions to the mentors is rektor's
  // (or a full administrator's); anybody else reads the delegation.
  const me = useProfile().profile;
  const decides = profileDecides(me?.adminProfile === undefined ? "FULL" : me.adminProfile);

  const current = delegation.data?.current ?? null;
  const rowOf = useLeaveRows("admin", current);
  const requests = inbox.data ?? [];

  const decide = async (id: string, status: Decision, note: string | undefined) => {
    try {
      const result = await actions.decide.mutateAsync({ id, status, note });
      toast.success(status === "APPROVED" ? t("approved", { count: result.absenceDays }) : t("rejected"));
    } catch (error) {
      toast.error(leaveActionError(error, "admin", { alreadyDecided: tInbox("alreadyDecided"), fallback: tCommon("error") }));
    }
  };

  const save = async (body: { mentorMaxSchoolDays: number | null; reference?: string }) => {
    try {
      await actions.delegate.mutateAsync(body);
      toast.success(t("delegationSaved"));
      setEditOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const list = (id: string, title: string, rows: typeof requests) => (
    <DecisionList
      id={id}
      title={title}
      requests={rows.map(rowOf)}
      labels={{ approve: t("approve"), reject: t("reject"), note: t("noteLabel") }}
      rejectCopy={(request) => {
        const leave = rows.find((candidate) => candidate.id === request.id);
        return { title: t("rejectTitle", { name: leave?.student.name ?? "—" }), body: t("rejectBody") };
      }}
      deciding={actions.decide.isPending ? (actions.decide.variables?.id ?? null) : null}
      onDecide={decide}
      writes="DRIFT"
    />
  );

  const rektors = requests.filter((request) => request.decides !== "MENTOR");
  const mentors = requests.filter((request) => request.decides === "MENTOR");

  return (
    <Page>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      {delegation.isError ? (
        <LoadError variant="inline" title={t("delegationFailed")} hint={t("delegationFailedHint")} />
      ) : delegation.isLoading ? null : (
        <DelegationNotice
          delegation={current}
          action={
            decides ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setEditUsed(true);
                  setEditOpen(true);
                }}
                data-writes="DECIDES"
              >
                <Pencil aria-hidden="true" />
                {t("delegationEdit")}
              </Button>
            ) : undefined
          }
        />
      )}

      <FilterBar>
        <Tabs value={filter} onValueChange={(value) => setFilter(value as Filter)}>
          <TabsList aria-label={t("filterLabel")}>
            <TabsTrigger value="PENDING">{tGuardian("statusPENDING")}</TabsTrigger>
            <TabsTrigger value="APPROVED">{tGuardian("statusAPPROVED")}</TabsTrigger>
            <TabsTrigger value="REJECTED">{tGuardian("statusREJECTED")}</TabsTrigger>
          </TabsList>
        </Tabs>
      </FilterBar>

      {/* Decided requests end in the past, and gallring takes the old ones. */}
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
          title={t("emptyTitle", { status: filter })}
          description={t("emptyHint")}
          headingLevel={2}
        />
      ) : filter === "PENDING" ? (
        <>
          {rektors.length > 0 ? list("leave-requests", t("listRektor"), rektors) : null}
          {mentors.length > 0 ? list("leave-requests-mentor", t("listMentor"), mentors) : null}
        </>
      ) : (
        list("leave-requests", t("listTitle", { status: filter }), requests)
      )}

      {editUsed ? (
        <DialogLoadBoundary
          key={editLoad}
          onError={() => {
            toast.error(tCommon("confirmLoadFailed"));
            setEditOpen(false);
            setEditUsed(false);
            setEditLoad((attempt) => attempt + 1);
          }}
        >
          <Suspense fallback={null}>
            <DelegationDialog
              key={current?.decidedAt ?? "none"}
              open={editOpen}
              onOpenChange={setEditOpen}
              current={current}
              history={delegation.data?.history ?? []}
              pending={actions.delegate.isPending}
              onSave={save}
            />
          </Suspense>
        </DialogLoadBoundary>
      ) : null}
    </Page>
  );
}
