"use client";

import { useState } from "react";
import { ApiError } from "@/lib/api";
import { usePupilCard } from "@/lib/checklists-queries";
import { CHECKLIST_NOT_FOUND, instructorOf, templateLabel } from "@/lib/checklists";
import type { PupilConsent, PupilProof } from "@/lib/checklists";
import { CHECKLIST_STATE_VARIANT } from "@/lib/status-variants";
import { useReadOnly } from "@/components/profile-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";
import { ConsentStateBadge } from "./consent-state-badge";
import { useChecklistsText } from "./use-checklists-text";
import { VoidForm } from "./void-form";

/**
 * One pupil: every tick, the voided ones too with who voided them, when and
 * why, and where the pupil stands on each consent list. Opened from a pupil's
 * name on a roster or a list. Recorded in the läslogg by the gateway, so read
 * when opened and not kept.
 *
 * A tick that was voided is shown, not hidden: that it was made, and why it was
 * taken back, is part of what the school can say about the pupil. Voiding a
 * valid tick is done in place of the lists (a step of this dialog, not a dialog
 * on a dialog).
 */
export function PupilCardBody({ studentId }: { studentId: string }) {
  const { t, tCommon } = useChecklistsText();
  const query = usePupilCard(studentId);
  const [voiding, setVoiding] = useState<{ id: string; label: string } | null>(null);
  const card = query.data;

  if (query.isLoading) {
    return (
      <div aria-busy="true">
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (query.isError || !card) {
    const gone = query.error instanceof ApiError && query.error.code === CHECKLIST_NOT_FOUND;
    return (
      <LoadError
        variant="inline"
        title={t(gone ? "card.notFound" : "card.loadFailed")}
        hint={t(gone ? "card.notFoundHint" : "card.loadFailedHint")}
        action={
          gone ? undefined : (
            <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>
              {tCommon("retry")}
            </Button>
          )
        }
      />
    );
  }
  if (voiding) {
    return <VoidForm proofId={voiding.id} label={voiding.label} onDone={() => setVoiding(null)} onCancel={() => setVoiding(null)} />;
  }

  return (
    <div className="space-y-5">
      <section aria-labelledby="card-proofs-title" className="space-y-2">
        <h3 id="card-proofs-title" className="text-sm font-semibold">
          {t("card.proofsTitle")}
        </h3>
        {card.proofs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("card.noProofs")}</p>
        ) : (
          <ul className="divide-y">
            {card.proofs.map((proof) => (
              <ProofItem key={proof.id} proof={proof} pupil={card.student.name} onVoid={setVoiding} />
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="card-consents-title" className="space-y-2">
        <h3 id="card-consents-title" className="text-sm font-semibold">
          {t("card.consentsTitle")}
        </h3>
        {card.consents.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("card.noConsents")}</p>
        ) : (
          <ul className="divide-y">
            {card.consents.map((consent) => (
              <ConsentItem key={consent.listId} consent={consent} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ProofItem({ proof, pupil, onVoid }: { proof: PupilProof; pupil: string; onVoid: (tick: { id: string; label: string }) => void }) {
  const { t, day, moment } = useChecklistsText();
  const readOnly = useReadOnly();
  const by = instructorOf(proof);
  const date = day(proof.instructedOn);
  const name = templateLabel({ title: proof.templateTitle, subjectName: proof.subjectName });
  return (
    <li className="space-y-1 py-2.5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{name}</p>
        {proof.voidedAt ? (
          <Badge variant={CHECKLIST_STATE_VARIANT.PROOF_VOIDED}>{t("card.voidedBadge")}</Badge>
        ) : readOnly || !proof.canVoid ? null : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-writes="DRIFT"
            aria-label={t("roster.voidNamed", { name: pupil, date })}
            onClick={() => onVoid({ id: proof.id, label: `${pupil} · ${name}, ${date}` })}
          >
            {t("roster.void")}
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {by ? t("roster.had", { date, by }) : t("roster.hadNoName", { date })}
        {proof.note ? ` · ${t("card.note", { note: proof.note })}` : ""}
      </p>
      {proof.voidedAt ? (
        <p className="text-sm">
          {t("card.voided", {
            moment: moment(proof.voidedAt),
            name: proof.voidedByName ?? t("card.someone"),
            reason: proof.voidReason ?? "",
          })}
        </p>
      ) : null}
    </li>
  );
}

function ConsentItem({ consent }: { consent: PupilConsent }) {
  const { t, day } = useChecklistsText();
  const { entry } = consent;
  return (
    <li className="space-y-1 py-2.5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {consent.title}
          <span className="font-normal text-muted-foreground"> · {consent.className}</span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {consent.closed ? <Badge variant={CHECKLIST_STATE_VARIANT.LIST_CLOSED}>{t("lists.closedBadge")}</Badge> : null}
          <ConsentStateBadge state={consent.state} label={t(`state.${consent.state}`)} />
        </div>
      </div>
      {entry ? (
        <p className="text-sm text-muted-foreground">
          {consent.state === "ASKED"
            ? t("detail.previously", { answer: `${t(`state.${entry.kind}`)} ${day(entry.givenOn)}` })
            : day(entry.givenOn)}
        </p>
      ) : null}
    </li>
  );
}
