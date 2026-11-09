"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { useLeavePolicy, useSaveLeavePolicy } from "@/lib/leave-policy-queries";
import type { LeavePolicy } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { LoadError } from "@/components/ui/load-error";
import { NativeSelect } from "@/components/ui/native-select";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";

/** The form's own state: the minimum is text until it is saved, so a half-typed number is not a policy. */
interface Draft {
  requireAll: boolean;
  min: string;
  late: LeavePolicy["shortNotice"];
  contact: LeavePolicy["contact"];
}

const draftOf = (policy: LeavePolicy): Draft => ({
  requireAll: policy.requireAllGuardians,
  min: policy.minDaysAhead === null ? "" : String(policy.minDaysAhead),
  late: policy.shortNotice,
  contact: policy.contact,
});

/** The minimum in a draft: null for none, undefined for text that is not 1 to 90 whole days. */
function minOf(draft: Draft): number | null | undefined {
  const text = draft.min.trim();
  if (text === "") return null;
  const days = /^\d{1,3}$/.test(text) ? Number(text) : NaN;
  return days >= 1 && days <= 90 ? days : undefined;
}

const LATE: LeavePolicy["shortNotice"][] = ["REFUSE", "FLAG"];
const CONTACT: LeavePolicy["contact"][] = ["OFF", "OPTIONAL", "REQUIRED"];

/**
 * Ledighetspolicy: how the school receives leave requests (/admin/leave). Three
 * choices, all off as delivered: that every guardian consents before a request
 * goes to a decision, a fewest number of days before the first day (and
 * whether a later request is refused or only flagged for whoever decides),
 * and whether the family gives a temporary contact for the leave.
 *
 * Every administrator reads the choices; saving them is a decider's (rektor,
 * full), as the gateway's @Decides and the database ask, like the delegation
 * beside it. Anybody else is told who decides and sees what was chosen.
 */
export function LeavePolicyCard({ decides }: { decides: boolean }) {
  const t = useTranslations("adminLeave");
  const tCommon = useTranslations("common");
  const policy = useLeavePolicy();
  const save = useSaveLeavePolicy();
  // What the reader has changed and not yet saved; null: what is saved.
  const [draft, setDraft] = useState<Draft | null>(null);

  const saved = policy.data;
  const current = draft ?? (saved ? draftOf(saved) : null);
  const minDays = current ? minOf(current) : undefined;
  const changed = draft !== null && saved !== undefined && JSON.stringify(draftOf(saved)) !== JSON.stringify(draft);
  const change = (patch: Partial<Draft>) => current && setDraft({ ...current, ...patch });

  const submit = async () => {
    if (!current || minDays === undefined || save.isPending) return;
    try {
      await save.mutateAsync({
        requireAllGuardians: current.requireAll,
        minDaysAhead: minDays,
        shortNotice: current.late,
        contact: current.contact,
      });
      setDraft(null);
      toast.success(t("policy.saved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  return (
    <SectionCard
      id="leave-policy"
      title={t("policy.title")}
      description={t("policy.description")}
      footer={
        current && decides ? (
          <Button data-writes="DECIDES" disabled={!changed || minDays === undefined || save.isPending} onClick={() => void submit()}>
            {save.isPending ? t("policy.saving") : t("policy.save")}
          </Button>
        ) : undefined
      }
    >
      {policy.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-32 w-full" />
        </div>
      ) : policy.isError || !current ? (
        <LoadError variant="inline" title={t("policy.loadFailed")} hint={t("policy.loadFailedHint")} />
      ) : (
        <div className="space-y-4" data-writes-inert="DECIDES">
          <div className="flex items-start gap-3">
            <input
              id="leave-policy-consent"
              type="checkbox"
              className="mt-1 size-4"
              checked={current.requireAll}
              disabled={!decides}
              aria-describedby="leave-policy-consent-hint"
              onChange={(event) => change({ requireAll: event.target.checked })}
            />
            <div className="min-w-0 space-y-0.5">
              <label htmlFor="leave-policy-consent" className="text-sm font-medium">
                {t("policy.consentLabel")}
              </label>
              <p id="leave-policy-consent-hint" className="text-sm text-muted-foreground">
                {t("policy.consentHint")}
              </p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
            <FormField
              id="leave-policy-min"
              label={t("policy.minLabel")}
              hint={t("policy.minHint")}
              error={minDays === undefined ? <span role="alert">{t("policy.minInvalid")}</span> : undefined}
            >
              <Input
                inputMode="numeric"
                className="tabular-nums"
                value={current.min}
                disabled={!decides}
                onChange={(event) => change({ min: event.target.value })}
              />
            </FormField>
            <FormField id="leave-policy-late" label={t("policy.lateLabel")} hint={t("policy.lateHint")}>
              <NativeSelect
                value={current.late}
                disabled={!decides || !minDays}
                onChange={(event) => change({ late: event.target.value as Draft["late"] })}
              >
                {LATE.map((value) => (
                  <option key={value} value={value}>
                    {t(`policy.late${value}`)}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
          </div>

          <FormField id="leave-policy-contact" label={t("policy.contactLabel")} hint={t("policy.contactHint")}>
            <NativeSelect
              value={current.contact}
              disabled={!decides}
              onChange={(event) => change({ contact: event.target.value as Draft["contact"] })}
            >
              {CONTACT.map((value) => (
                <option key={value} value={value}>
                  {t(`policy.contact${value}`)}
                </option>
              ))}
            </NativeSelect>
          </FormField>

          {!decides ? <p className="text-sm text-muted-foreground">{t("policy.readOnly")}</p> : null}
        </div>
      )}
    </SectionCard>
  );
}
