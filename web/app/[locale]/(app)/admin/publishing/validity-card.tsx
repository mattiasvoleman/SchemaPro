"use client";

/*
 * Which published timetable is valid when (giltig fr.o.m./t.o.m.), for one
 * läsår, and the log every publish writes.
 *
 * A publication is valid over its range except where a later one covers it:
 * an HT publication from August to June and a VT one from January leave HT
 * valid until the turn of the year. The gateway computes those segments
 * (publication-validity.ts) — this card lists them, marks the one valid on
 * the school's today, and keeps the log below: every publish, refusal,
 * starting point (BASELINE) and påfyllning, with what it wrote and which
 * checks it met.
 *
 * In utkastläge the card also holds what only a draft has: how much is
 * waiting, Kassera utkast (the grundschema goes back to the published one —
 * the gateway saves a version first, "Före kasserat utkast"), and Fyll på
 * publicerat schema. That last one is how a draft school gets lessons back
 * after a lov was shortened or a closure lifted: it writes the PUBLISHED
 * lessons into the calendar again, never the draft, and never a day that has
 * begun.
 */

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import type { MessageLookup } from "@/lib/engine-message";
import {
  useDiscardDraft,
  useDraftState,
  usePublicationTimeline,
  useRefillPublication,
} from "@/lib/publication-queries";
import { publicationErrorText, warningCodes } from "@/lib/publication-messages";
import type { PublishMode } from "@/lib/publication-types";
import { formatInstant, pendingCount, segmentViews, tallyGates } from "@/lib/publication-view";
import type { AcademicYear } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DateField } from "@/components/ui/date-field";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const WHEN_VARIANT = { past: "outline", current: "success", ahead: "secondary" } as const;

export function ValidityCard({
  year,
  mode,
  onReview,
}: {
  year: AcademicYear;
  mode: PublishMode;
  onReview: () => void;
}) {
  const t = useTranslations("publishing");
  const locale = useLocale();
  const tErrors = useTranslations("publishing.errors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const timeline = usePublicationTimeline(year.id);
  const draft = useDraftState(year.id, mode === "DRAFT");
  const discard = useDiscardDraft();
  const refill = useRefillPublication();
  const [discarding, setDiscarding] = useState(false);
  const [refillRange, setRefillRange] = useState<{ from?: string; to?: string }>({});
  // The warnings the gateway named for this range; "Fyll på ändå" only once they are on screen.
  const [refillWarnings, setRefillWarnings] = useState<string[]>([]);
  const refillNeedsAck = refillWarnings.length > 0;
  const [problem, setProblem] = useState<string | null>(null);

  const today = timeline.data?.today ?? "";
  const refillFrom = refillRange.from ?? (today > year.startDate ? today : year.startDate);
  const refillTo = refillRange.to ?? year.endDate;

  const doDiscard = async () => {
    setProblem(null);
    try {
      const result = await discard.mutateAsync(year.id);
      toast.success(t("discarded", { count: result.restored }));
    } catch (error) {
      setProblem(publicationErrorText(tErrors, error, tCommon("error")));
    } finally {
      setDiscarding(false);
    }
  };

  const doRefill = async (acknowledge: boolean) => {
    setProblem(null);
    try {
      const outcome = await refill.mutateAsync({
        academicYearId: year.id,
        validFrom: refillFrom,
        validTo: refillTo,
        ...(acknowledge ? { acknowledgeWarnings: true } : {}),
      });
      setRefillWarnings([]);
      toast.success(t("refilled", { count: outcome.result.created }));
    } catch (error) {
      const warnings = warningCodes(error);
      setRefillWarnings(warnings);
      if (warnings.length === 0) setProblem(publicationErrorText(tErrors, error, tCommon("error")));
    }
  };

  const segments = timeline.data ? segmentViews(timeline.data) : [];
  const log = timeline.data ? [...timeline.data.publications].reverse() : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("validityTitle", { year: year.name })}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p>{t("validityBody")}</p>
        {timeline.isLoading ? <Skeleton className="h-16 w-full" /> : null}
        {timeline.isError ? (
          <p role="alert">{publicationErrorText(tErrors, timeline.error, tCommon("error"))}</p>
        ) : null}
        {timeline.data && segments.length === 0 ? <p>{t("validityNone")}</p> : null}
        {segments.length > 0 ? (
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-foreground">{t("validFrom")}</TableHead>
                  <TableHead className="text-foreground">{t("validTo")}</TableHead>
                  <TableHead className="text-foreground">{t("logKind")}</TableHead>
                  <TableHead className="text-foreground">{t("logPublishedAt")}</TableHead>
                  <TableHead className="text-foreground">{t("validityStatus")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {segments.map((segment) => (
                  <TableRow key={`${segment.publicationId}-${segment.from}`}>
                    <TableCell className="tabular-nums">{segment.from}</TableCell>
                    <TableCell className="tabular-nums">{segment.to}</TableCell>
                    <TableCell>{segment.publication ? t(`kind.${segment.publication.kind}`) : "–"}</TableCell>
                    <TableCell className="tabular-nums">
                      {segment.publication ? formatInstant(segment.publication.publishedAt, locale) : "–"}
                    </TableCell>
                    <TableCell>
                      <Badge variant={WHEN_VARIANT[segment.when]}>{t(`when.${segment.when}`)}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button onClick={onReview}>{t(mode === "DRAFT" ? "reviewDraft" : "reviewDirect")}</Button>
          {mode === "DRAFT" ? (
            <Button
              variant="outline"
              onClick={() => setDiscarding(true)}
              disabled={!draft.data || pendingCount(draft.data) === 0}
            >
              {t("discard")}
            </Button>
          ) : null}
        </div>

        {mode === "DRAFT" && draft.data ? (
          <p>
            {pendingCount(draft.data) === 0
              ? t("draftClean")
              : t("draftPending", { count: pendingCount(draft.data) })}
          </p>
        ) : null}

        {mode === "DRAFT" ? (
          <section aria-labelledby="refill-title" className="space-y-2 rounded-md border p-3">
            <h3 id="refill-title" className="font-semibold">
              {t("refillTitle")}
            </h3>
            <p>{t("refillBody")}</p>
            <div className="grid max-w-md grid-cols-2 gap-3 [&>*]:min-w-0">
              <div className="space-y-1">
                <Label htmlFor="refill-from">{t("validFrom")}</Label>
                <DateField
                  id="refill-from"
                  label={t("validFrom")}
                  value={refillFrom}
                  min={today > year.startDate ? today : year.startDate}
                  max={year.endDate}
                  onChange={(value) => {
                    setRefillWarnings([]);
                    setRefillRange((previous) => ({ ...previous, from: value }));
                  }}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="refill-to">{t("validTo")}</Label>
                <DateField
                  id="refill-to"
                  label={t("validTo")}
                  value={refillTo}
                  min={year.startDate}
                  max={year.endDate}
                  onChange={(value) => {
                    setRefillWarnings([]);
                    setRefillRange((previous) => ({ ...previous, to: value }));
                  }}
                />
              </div>
            </div>
            {refillNeedsAck ? (
              <div role="status" className="space-y-1">
                <p className="font-medium">{t("refillWarnings")}</p>
                <ul className="list-disc pl-5">
                  {refillWarnings.map((code) => (
                    <li key={code}>{t.has(`policy.${code}`) ? t(`policy.${code}`) : code}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <Button
              variant="outline"
              onClick={() => void doRefill(refillNeedsAck)}
              disabled={refill.isPending || !refillFrom || !refillTo || refillFrom > refillTo}
            >
              {t(refillNeedsAck ? "refillAnyway" : "refill")}
            </Button>
          </section>
        ) : null}

        {problem ? (
          <p role="alert" className="font-medium">
            {problem}
          </p>
        ) : null}

        {log.length > 0 ? (
          <details>
            <summary className="cursor-pointer font-medium">{t("logTitle", { count: log.length })}</summary>
            <div className="mt-2 overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-foreground">{t("logPublishedAt")}</TableHead>
                    <TableHead className="text-foreground">{t("logKind")}</TableHead>
                    <TableHead className="text-foreground">{t("logRange")}</TableHead>
                    <TableHead className="text-foreground">{t("logWritten")}</TableHead>
                    <TableHead className="text-foreground">{t("logGates")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {log.map((row) => {
                    const tally = tallyGates(row.gates);
                    return (
                      <TableRow key={row.id}>
                        <TableCell className="tabular-nums">{formatInstant(row.publishedAt, locale, { withTime: true })}</TableCell>
                        <TableCell>
                          {t(`kind.${row.kind}`)}
                          {row.outcome === "REFUSED" ? ` · ${t("outcomeRefused")}` : ""}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {row.validFrom}–{row.validTo}
                        </TableCell>
                        <TableCell>
                          {t("logCounts", {
                            created: row.created,
                            cancelled: row.cancelled,
                            removed: row.removed,
                          })}
                        </TableCell>
                        <TableCell>
                          {t("logGateTally", { refuse: tally.refuse, warn: tally.warn })}
                          {row.acknowledgedWarnings ? ` · ${t("logAcknowledged")}` : ""}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </details>
        ) : null}
      </CardContent>
      <ConfirmDialog
        open={discarding}
        onOpenChange={setDiscarding}
        title={t("discard")}
        description={t("discardConfirm")}
        confirmLabel={t("discard")}
        destructive
        loading={discard.isPending}
        onConfirm={doDiscard}
      />
    </Card>
  );
}
