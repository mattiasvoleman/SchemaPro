"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { leaveConsentError } from "@/lib/leave-errors";
import type { ContactProblem } from "@/lib/leave-policy";
import { useAnswerLeaveConsent } from "@/lib/leave-consent-queries";
import type { LeaveContact, LeavePolicy, LeaveRequest } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";

/*
 * Ledighetspolicy on the guardian's page (K4): what the school's choices add to
 * the leave form and to the list of requests. Both parts are fetched on first
 * use with lazy() (see guardian/page.tsx) and only when the policy or a
 * request asks for them, so a school that has chosen nothing, which is every
 * school as delivered, sees the page as it was and downloads nothing for it.
 *
 * What these say follows reports/k4/api-contract.md: the contact is a third
 * party's details and is shown to the family that wrote it; consent is told as
 * a state and never as who answered what; a guardian's own answer is final.
 */

/** The form's policy-driven part: the minimum, the request for consent, and the contact fields. */
export function LeavePolicyFields({
  policy,
  contact,
  problem,
  onChange,
}: {
  policy: LeavePolicy;
  contact: LeaveContact;
  /** What keeps the contact from being sent (lib/leave-policy.ts contactProblem). */
  problem: ContactProblem | null;
  onChange: (contact: LeaveContact) => void;
}) {
  const t = useTranslations("guardian");
  const tCommon = useTranslations("common");
  // A problem is told once the reader has left the contact fields, not while they are still typing the others.
  const [left, setLeft] = useState(false);
  const set = (patch: Partial<LeaveContact>) => onChange({ ...contact, ...patch });
  const required = policy.contact === "REQUIRED";

  return (
    <div className="space-y-4">
      {policy.minDaysAhead !== null || policy.requireAllGuardians ? (
        <div className="space-y-1 text-sm text-muted-foreground">
          {policy.minDaysAhead !== null ? (
            <p>
              {t("leavePolicy.minAhead", { days: policy.minDaysAhead })}{" "}
              {t(policy.shortNotice === "FLAG" ? "leavePolicy.flag" : "leavePolicy.refuse")}
            </p>
          ) : null}
          {policy.requireAllGuardians ? <p>{t("leavePolicy.allGuardians")}</p> : null}
        </div>
      ) : null}

      {policy.contact !== "OFF" ? (
        <fieldset
          className="space-y-3 rounded-md border p-3"
          aria-describedby="leave-contact-hint"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setLeft(true);
          }}
        >
          <legend className="px-1 text-sm font-medium">
            {t("leavePolicy.contactLegend")}{" "}
            <span className="font-normal text-muted-foreground">
              ({required ? t("leavePolicy.contactRequired") : tCommon("optional")})
            </span>
          </legend>
          <p id="leave-contact-hint" className="text-xs text-muted-foreground">
            {t("leavePolicy.contactHint")}
          </p>
          <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
            <FormField id="leave-contact-name" label={t("leavePolicy.contactName")}>
              <Input
                autoComplete="off"
                maxLength={100}
                required={required}
                value={contact.name}
                onChange={(event) => set({ name: event.target.value })}
              />
            </FormField>
            <FormField
              id="leave-contact-phone"
              label={t("leavePolicy.contactPhone")}
              error={left && problem === "PHONE" ? <span role="alert">{t("leavePolicy.contactPhoneInvalid")}</span> : undefined}
            >
              <Input
                type="tel"
                autoComplete="off"
                maxLength={30}
                required={required}
                value={contact.phone}
                onChange={(event) => set({ phone: event.target.value })}
              />
            </FormField>
            <FormField id="leave-contact-relation" label={t("leavePolicy.contactRelation")} className="sm:col-span-2">
              <Input
                autoComplete="off"
                maxLength={60}
                required={required}
                value={contact.relation}
                onChange={(event) => set({ relation: event.target.value })}
              />
            </FormField>
          </div>
          {left && (problem === "INCOMPLETE" || problem === "REQUIRED") ? (
            <p role="alert" className="text-xs text-destructive">
              {t(problem === "REQUIRED" ? "leaveContactRequired" : "leaveContactIncomplete")}
            </p>
          ) : null}
        </fieldset>
      ) : null}
    </div>
  );
}

/**
 * What a request in the family's list says beyond its plain row: the contact the
 * family wrote, where the guardians' consent stands, that a guardian's no ended
 * it, and, for a guardian the school still waits for, the question with its two
 * answers. A no is asked about first, because it ends the request for everybody
 * and cannot be taken back.
 */
export function LeaveRowExtras({ leave, name, span }: { leave: LeaveRequest; name: string; span: string }) {
  const t = useTranslations("guardian");
  const tCommon = useTranslations("common");
  const answer = useAnswerLeaveConsent();
  const [confirming, setConfirming] = useState(false);
  const confirmTitle = useRef<HTMLParagraphElement>(null);
  const noButton = useRef<HTMLButtonElement>(null);

  // Focus follows the question: the buttons it replaces are gone, and a reader would be left on nothing.
  useEffect(() => {
    if (confirming) confirmTitle.current?.focus();
  }, [confirming]);

  const consent = leave.consent;
  const open = leave.status === "PENDING";
  const mine = consent?.mine ?? "NOT_ASKED";
  const told = open || leave.status === "GUARDIAN_DECLINED";

  const send = async (yes: boolean) => {
    try {
      await answer.mutateAsync({ id: leave.id, consent: yes });
      toast.success(t(yes ? "consent.answeredYes" : "consent.answeredNo"));
    } catch (error) {
      toast.error(
        leaveConsentError(error, {
          notAGuardian: t("consent.notAGuardian"),
          notFound: t("consent.notFound"),
          requestEnded: t("consent.requestEnded"),
          custodyEnded: t("consent.custodyEnded"),
          answered: t("consent.answered"),
          fallback: tCommon("error"),
        }),
      );
    }
    setConfirming(false);
  };

  const named = (key: "consent.yesNamed" | "consent.noNamed") => t(key, { name, span });
  const note = "text-xs text-muted-foreground";

  return (
    <>
      {leave.contact ? (
        <p className="text-muted-foreground">
          <span className="font-medium text-foreground">{t("contactTitle")}</span>
          {": "}
          {t("contactValue", { name: leave.contact.name, relation: leave.contact.relation, phone: leave.contact.phone })}
        </p>
      ) : null}
      {leave.status === "GUARDIAN_DECLINED" ? <p className={note}>{t("consent.declined")}</p> : null}
      {open && consent?.state === "WAITING" ? <p className={note}>{t("consent.waiting")}</p> : null}
      {open && consent?.state === "GIVEN" ? <p className={note}>{t("consent.allGiven")}</p> : null}
      {told && mine === "GIVEN" ? <p className={note}>{t("consent.mineGiven")}</p> : null}
      {told && mine === "REFUSED" ? <p className={note}>{t("consent.mineRefused")}</p> : null}
      {told && mine === "ENDED" ? <p className={note}>{t("consent.mineEnded")}</p> : null}

      {open && mine === "WAITING" ? (
        <div className="space-y-2 rounded-md border bg-muted/40 p-3" role="group" aria-label={t("consent.askTitle")}>
          {confirming ? (
            <>
              <p ref={confirmTitle} tabIndex={-1} className="font-medium">
                {t("consent.confirmTitle")}
              </p>
              <p>{t("consent.confirmBody")}</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="destructive" disabled={answer.isPending} onClick={() => void send(false)}>
                  {t("consent.confirmNo")}
                  <span className="sr-only">
                    , {name}, {span}
                  </span>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={answer.isPending}
                  onClick={() => {
                    setConfirming(false);
                    // The button that asked is back after this render.
                    queueMicrotask(() => noButton.current?.focus());
                  }}
                >
                  {tCommon("cancel")}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="font-medium">{t("consent.askTitle")}</p>
              <p>{t("consent.askBody")}</p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" aria-label={named("consent.yesNamed")} disabled={answer.isPending} onClick={() => void send(true)}>
                  {t("consent.yes")}
                </Button>
                <Button
                  ref={noButton}
                  size="sm"
                  variant="outline"
                  aria-label={named("consent.noNamed")}
                  disabled={answer.isPending}
                  onClick={() => setConfirming(true)}
                >
                  {t("consent.no")}
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </>
  );
}
