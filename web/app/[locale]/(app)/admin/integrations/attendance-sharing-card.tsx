"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import type { MessageLookup } from "@/lib/engine-message";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { INTEGRATION_KEYS } from "./query-keys";
import { errorText, formatWhen } from "./ss12000-messages";
import type { AttendanceSharing } from "./ss12000-types";
import { useAttendanceSharing, useDecideAttendanceSharing } from "./use-integration-keys";

/** The decisions the gateway answers with (ATTENDANCE_SHARING_HISTORY). */
const HISTORY_SHOWN = 20;

/*
 * Närvaro och frånvaro till integrationer: the school's decision
 * (AttendanceSharingDecisions, migration 20261114090000). Off until an admin
 * decides; while off, a key with attendances.read or absences.read is
 * answered 403 NOT_SHARED and the database's own arms read no row. Every
 * decision is kept with who and when (the database stamps them), so the
 * card shows the one in force and the ones before it, and a change is a new
 * decision, never an edit. What is shared and what never is are said here
 * in the reader's words, as the gateway emits them (docs/integration-api.md).
 *
 * The dialog asks about the decision it was opened for (`asked`), not the
 * state as it is when it closes: the answer's refetch can land while it
 * fades, and a card still showing the old state must not offer the same
 * decision twice, so the answer is written into the query before the refetch.
 */
export function AttendanceSharingCard() {
  const t = useTranslations("integrations.attendanceSharing");
  const tErrors = useTranslations("integrations.errors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const tHistory = useTranslations("dataProtection");
  const locale = useLocale();
  const queryClient = useQueryClient();
  const sharing = useAttendanceSharing(true);
  const decide = useDecideAttendanceSharing();
  const [reference, setReference] = useState("");
  // The decision the open dialog asks for; null while it is closed.
  const [asked, setAsked] = useState<boolean | null>(null);

  const current = sharing.data?.current ?? null;
  const shares = current?.shares === true;
  const history = sharing.data?.history ?? [];
  const earlier = history.slice(1);

  const submit = () => {
    if (asked === null) return;
    decide.mutate(
      { shares: asked, ...(reference.trim() ? { reference: reference.trim() } : {}) },
      {
        onSuccess: (decision) => {
          // In force at once, before the refetch: the card shows it and offers the next one.
          queryClient.setQueryData<AttendanceSharing>(INTEGRATION_KEYS.attendanceSharing, (before) => ({
            current: decision,
            history: [decision, ...(before?.history ?? [])].slice(0, HISTORY_SHOWN),
          }));
          toast.success(decision.shares ? t("savedShared") : t("savedStopped"));
          setReference("");
          setAsked(null);
        },
        onError: (error) => toast.error(errorText(tErrors, error, tCommon("error"))),
      },
    );
  };
  const who = (name: string | null) => name ?? tHistory("historyByUnknown");

  return (
    <SectionCard id="attendance-sharing" title={t("title")} description={t("body")}>
      {sharing.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-24 w-full" />
        </div>
      ) : sharing.isError ? (
        <LoadError variant="inline" title={t("loadFailed")} hint={errorText(tErrors, sharing.error, tCommon("error"))} />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {/* "Läge: Delas", so the word is not read as the end of the sentence before it. */}
            <span className="sr-only">{t("state")}</span>
            <Badge variant={shares ? "success" : "outline"}>{shares ? t("shared") : t("notShared")}</Badge>
            <p className="text-muted-foreground">
              {current
                ? t("decided", { when: formatWhen(locale, current.decidedAt), who: who(current.decidedBy) })
                : t("neverDecided")}
            </p>
          </div>
          {current?.reference ? <p className="text-xs text-muted-foreground">{t("referenceShown", { reference: current.reference })}</p> : null}
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
            <li>{t("leaves")}</li>
            <li>{t("never")}</li>
            <li>{t("logged")}</li>
            <li>{t("gallring")}</li>
          </ul>
          <FormField id="attendance-sharing-reference" label={t("reference")} hint={t("referenceHint")} optional>
            <Input value={reference} maxLength={200} onChange={(event) => setReference(event.target.value)} />
          </FormField>
          <Button
            type="button"
            size="sm"
            variant={shares ? "outline" : "default"}
            disabled={decide.isPending}
            onClick={() => setAsked(!shares)}
          >
            {shares ? t("stop") : t("share")}
          </Button>
          {earlier.length > 0 ? (
            <details className="text-xs">
              <summary className="cursor-pointer font-medium">{t("history")}</summary>
              <ul className="mt-1 space-y-0.5 text-muted-foreground">
                {earlier.map((decision) => {
                  const values = { when: formatWhen(locale, decision.decidedAt), who: who(decision.decidedBy) };
                  return (
                    <li key={`${decision.decidedAt}-${decision.shares}`}>
                      {decision.shares ? t("historyShared", values) : t("historyStopped", values)}
                      {decision.reference ? ` · ${decision.reference}` : ""}
                    </li>
                  );
                })}
              </ul>
              {history.length >= HISTORY_SHOWN ? <p className="mt-1 text-muted-foreground">{t("historyLimit", { count: HISTORY_SHOWN })}</p> : null}
            </details>
          ) : null}
        </div>
      )}
      <ConfirmDialog
        open={asked !== null}
        onOpenChange={(open) => {
          if (!open) setAsked(null);
        }}
        title={asked === false ? t("confirmStopTitle") : t("confirmShareTitle")}
        description={asked === false ? t("confirmStopBody") : t("confirmShareBody")}
        confirmLabel={asked === false ? t("stop") : t("share")}
        // Opening pupils' attendance to other systems is the step to weigh; closing it is not.
        destructive={asked !== false}
        loading={decide.isPending}
        onConfirm={submit}
      />
    </SectionCard>
  );
}
