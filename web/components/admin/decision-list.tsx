"use client";

/*
 * The admin's inbox of requests that wait for a yes or a no: Lokalbokningar
 * (a teacher's booking of a speciallokal) and Ledighetsansökningar (a
 * guardian's leave request). Both pages drew the same card per request with a
 * placeholder-only note field, a red Avslå that sent at once, and one
 * isPending that disabled every card while any decision was in flight.
 *
 * Here the note has a label (named after its request for a screen reader),
 * Avslå asks first — the requester is told and the gateway refuses to decide
 * twice, so a no cannot be taken back — and only the request being decided
 * waits. The page keeps its own mutation and toast (Ledighetsansökningar
 * says how many absence days an approval wrote).
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Check, Loader2, X } from "lucide-react";
import type { StatusVariant } from "@/lib/status-variants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { SectionCard } from "@/components/ui/section-card";

export type Decision = "APPROVED" | "REJECTED";

export interface DecisionRequest {
  id: string;
  /** The row's first line: what is asked for (the room, the pupil). */
  title: React.ReactNode;
  /** The row's name in its controls' labels: "Godkänn Sal 12, 14 okt. 2026 10:00–11:00". */
  name: string;
  /** Muted lines under the title: when, why, who asked. */
  details: React.ReactNode[];
  /** Still waiting for a decision: the row offers the note, Godkänn and Avslå. */
  open: boolean;
  /** The decided state's Badge (lib/status-variants.ts), for a request that is not open. */
  status: { label: string; variant: StatusVariant };
}

export interface DecisionListProps {
  /** The section's id; the note fields' ids derive from it. */
  id: string;
  title: string;
  requests: DecisionRequest[];
  labels: {
    approve: string;
    reject: string;
    /** The note field's label; "(valfritt)" is added. */
    note: string;
  };
  /** The rejection's question and consequence, for the request about to be rejected. */
  rejectCopy: (request: DecisionRequest) => { title: string; body: string };
  /** The request whose decision is in flight, or null. Only its row waits. */
  deciding: string | null;
  /** Sends the decision; the page says the outcome in a toast. The note is undefined when blank. */
  onDecide: (id: string, decision: Decision, note: string | undefined) => Promise<unknown>;
}

/** A SectionCard of requests, each decided on its own row. */
export function DecisionList({ id, title, requests, labels, rejectCopy, deciding, onDecide }: DecisionListProps) {
  const tCommon = useTranslations("common");
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [rejecting, setRejecting] = useState<DecisionRequest | null>(null);

  const noteOf = (requestId: string) => notes[requestId]?.trim() || undefined;
  const named = (action: string, request: DecisionRequest) =>
    tCommon("actionNamed", { action, name: request.name });
  const copy = rejecting ? rejectCopy(rejecting) : null;

  return (
    <SectionCard id={id} title={title}>
      <ul className="divide-y rounded-md border">
        {requests.map((request) => {
          const busy = deciding === request.id;
          const noteId = `${id}-note-${request.id}`;
          return (
            <li
              key={request.id}
              className="flex flex-col gap-3 px-3 py-3 text-sm sm:flex-row sm:items-start sm:justify-between"
            >
              <div className="min-w-0 space-y-1">
                <p className="font-medium">{request.title}</p>
                {request.details.map((detail, index) => (
                  <p key={index} className="text-muted-foreground">
                    {detail}
                  </p>
                ))}
              </div>
              {request.open ? (
                <div className="flex shrink-0 flex-col gap-2 sm:w-64">
                  <FormField
                    id={noteId}
                    optional
                    label={
                      <>
                        {labels.note}
                        <span className="sr-only">, {request.name}</span>
                      </>
                    }
                  >
                    <Input
                      className="h-8"
                      value={notes[request.id] ?? ""}
                      disabled={busy}
                      onChange={(event) => setNotes((current) => ({ ...current, [request.id]: event.target.value }))}
                    />
                  </FormField>
                  <div className="flex gap-2 sm:justify-end">
                    <Button
                      size="sm"
                      aria-label={named(labels.approve, request)}
                      onClick={() => void onDecide(request.id, "APPROVED", noteOf(request.id))}
                      disabled={busy}
                    >
                      {busy ? <Loader2 className="animate-spin" /> : <Check />}
                      {labels.approve}
                    </Button>
                    {/* Neutral: the confirmation it opens carries the red. */}
                    <Button
                      size="sm"
                      variant="outline"
                      aria-label={named(labels.reject, request)}
                      onClick={() => setRejecting(request)}
                      disabled={busy}
                    >
                      <X />
                      {labels.reject}
                    </Button>
                  </div>
                </div>
              ) : (
                <Badge variant={request.status.variant} className="self-start">
                  {request.status.label}
                </Badge>
              )}
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={rejecting !== null}
        onOpenChange={(open) => {
          if (!open) setRejecting(null);
        }}
        title={copy?.title ?? ""}
        description={copy?.body}
        confirmLabel={labels.reject}
        loading={rejecting !== null && deciding === rejecting.id}
        onConfirm={async () => {
          if (!rejecting) return;
          await onDecide(rejecting.id, "REJECTED", noteOf(rejecting.id));
          setRejecting(null);
        }}
      />
    </SectionCard>
  );
}
