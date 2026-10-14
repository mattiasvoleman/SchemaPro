"use client";

import { useLocale, useTranslations } from "next-intl";
import { Notice } from "@/components/ui/notice";
import type { LeaveDelegation } from "@/lib/leave-queries";

/**
 * Rektor's delegation in force, said as a sentence on both inboxes: how many
 * skoldagar the mentor decides, since when and under which reference, or
 * that rektor decides everything. Rektor's page passes the action that
 * changes it.
 */
export function DelegationNotice({ delegation, action }: { delegation: LeaveDelegation | null; action?: React.ReactNode }) {
  const t = useTranslations("leaveInbox");
  const locale = useLocale();
  const when = delegation ? new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(delegation.decidedAt)) : "";
  const limit = delegation?.mentorMaxSchoolDays ?? null;
  return (
    <Notice
      title={limit === null ? t("delegationNoneTitle") : t("delegationTitle", { count: limit })}
      action={action}
    >
      {limit === null ? t("delegationNoneBody") : t("delegationBody", { count: limit })}
      {delegation ? (
        <>
          {" "}
          {t(delegation.reference ? "delegationDecidedRef" : "delegationDecided", {
            date: when,
            name: delegation.decidedBy ?? "—",
            reference: delegation.reference ?? "",
          })}
        </>
      ) : null}
    </Notice>
  );
}
