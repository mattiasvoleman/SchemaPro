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
import { ChevronDown, ChevronRight } from "lucide-react";
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
import { VALIDITY_VARIANT } from "@/lib/status-variants";
import type { AcademicYear } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DateField } from "@/components/ui/date-field";
import { Label } from "@/components/ui/label";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/** The empty glyph of every table: an em dash, muted. */
const NONE = <span className="text-muted-foreground">—</span>;

/*
 * Both tables sit inside this card, so they take no frame of their own: the
 * card is the frame, the rows are compact and the outer columns line up with
 * the card's padding. On a phone the secondary columns step aside (hidden
 * below sm on head and cell alike).
 */
const TH = "h-auto py-1.5 pr-3 text-xs";
const TD = "py-1.5 pr-3";
const PHONE_HIDDEN = "hidden sm:table-cell";

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
  const [logOpen, setLogOpen] = useState(false);

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
    <SectionCard
      id="publish-validity"
      title={t("validityTitle", { year: year.name })}
      description={t("validityBody")}
      descriptionClassName="max-w-prose"
    >
      {timeline.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-16 w-full" />
        </div>
      ) : timeline.isError ? (
        <LoadError variant="inline" title={t("validityLoadFailed")} hint={t("validityLoadFailedHint")} />
      ) : timeline.data && segments.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("validityNone")}</p>
      ) : null}
      {segments.length > 0 ? (
        // The range and its status are what a row says; the kind and the
        // publish date are the history behind it, and give way on a phone.
        <div className="overflow-x-auto">
          <Table>
            <caption className="sr-only">{t("validityTitle", { year: year.name })}</caption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col" className={cn(TH, "pl-0")}>
                  {t("validFrom")}
                </TableHead>
                <TableHead scope="col" className={TH}>
                  {t("validTo")}
                </TableHead>
                <TableHead scope="col" className={cn(TH, PHONE_HIDDEN)}>
                  {t("logKind")}
                </TableHead>
                <TableHead scope="col" className={cn(TH, PHONE_HIDDEN)}>
                  {t("logPublishedAt")}
                </TableHead>
                <TableHead scope="col" className={cn(TH, "pr-0")}>
                  {t("validityStatus")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {segments.map((segment) => (
                <TableRow key={`${segment.publicationId}-${segment.from}`}>
                  <TableCell className={cn(TD, "whitespace-nowrap pl-0 font-medium tabular-nums")}>
                    {segment.from}
                  </TableCell>
                  <TableCell className={cn(TD, "whitespace-nowrap tabular-nums")}>{segment.to}</TableCell>
                  <TableCell className={cn(TD, PHONE_HIDDEN)}>
                    {segment.publication ? t(`kind.${segment.publication.kind}`) : NONE}
                  </TableCell>
                  <TableCell className={cn(TD, PHONE_HIDDEN, "whitespace-nowrap tabular-nums")}>
                    {segment.publication ? formatInstant(segment.publication.publishedAt, locale) : NONE}
                  </TableCell>
                  <TableCell className={cn(TD, "pr-0")}>
                    <Badge variant={VALIDITY_VARIANT[segment.when]}>{t(`when.${segment.when}`)}</Badge>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button onClick={onReview} data-writes="PUBLICERING DRIFT">
          {t(mode === "DRAFT" ? "reviewDraft" : "reviewDirect")}
        </Button>
        {mode === "DRAFT" ? (
          <Button
            variant="outline"
            onClick={() => setDiscarding(true)}
            disabled={!draft.data || pendingCount(draft.data) === 0}
            data-writes="PUBLICERING SCHEMALAGGNING DRIFT"
          >
            {t("discard")}
          </Button>
        ) : null}
      </div>

      {mode === "DRAFT" && draft.data ? (
        <p className="text-sm">
          {pendingCount(draft.data) === 0
            ? t("draftClean")
            : t("draftPending", { count: pendingCount(draft.data) })}
        </p>
      ) : null}

      {mode === "DRAFT" ? (
        <section aria-labelledby="refill-title" className="space-y-3 rounded-md border p-3" data-writes="PUBLICERING DRIFT">
          <div className="space-y-1">
            <h3 id="refill-title" className="text-sm font-semibold">
              {t("refillTitle")}
            </h3>
            <p className="max-w-prose text-sm text-muted-foreground">{t("refillBody")}</p>
          </div>
          <div className="grid max-w-md gap-4 sm:grid-cols-2 [&>*]:min-w-0">
            <div className="space-y-1.5">
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
            <div className="space-y-1.5">
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
            <Notice tone="warning" title={t("refillWarnings")}>
              <ul className="list-disc pl-5">
                {refillWarnings.map((code) => (
                  <li key={code}>{t.has(`policy.${code}`) ? t(`policy.${code}`) : code}</li>
                ))}
              </ul>
            </Notice>
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

      {problem ? <Notice tone="destructive">{problem}</Notice> : null}

      {log.length > 0 ? (
        /*
          A disclosure button, not <details>: the native marker (▶) is a glyph
          no other control on the page draws, and its summary had no focus
          ring of the app's own. The log mounts on opening — it is history,
          read seldom, and can run long.
        */
        <div className="space-y-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="-ml-2"
            aria-expanded={logOpen}
            aria-controls="publish-log"
            onClick={() => setLogOpen((open) => !open)}
          >
            {logOpen ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
            {t("logTitle", { count: log.length })}
          </Button>
          <div id="publish-log" hidden={!logOpen}>
            {logOpen ? (
              <div className="overflow-x-auto">
                <Table>
                  <caption className="sr-only">{t("logTitle", { count: log.length })}</caption>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead scope="col" className={cn(TH, "pl-0")}>
                        {t("logPublishedAt")}
                      </TableHead>
                      <TableHead scope="col" className={TH}>
                        {t("logKind")}
                      </TableHead>
                      <TableHead scope="col" className={cn(TH, PHONE_HIDDEN)}>
                        {t("logRange")}
                      </TableHead>
                      <TableHead scope="col" className={cn(TH, PHONE_HIDDEN)}>
                        {t("logWritten")}
                      </TableHead>
                      <TableHead scope="col" className={cn(TH, PHONE_HIDDEN, "pr-0")}>
                        {t("logGates")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {log.map((row) => {
                      const tally = tallyGates(row.gates);
                      return (
                        <TableRow key={row.id}>
                          <TableCell className={cn(TD, "whitespace-nowrap pl-0 font-medium tabular-nums")}>
                            {formatInstant(row.publishedAt, locale, { withTime: true })}
                          </TableCell>
                          <TableCell className={TD}>
                            {t(`kind.${row.kind}`)}
                            {row.outcome === "REFUSED" ? ` · ${t("outcomeRefused")}` : ""}
                          </TableCell>
                          <TableCell className={cn(TD, PHONE_HIDDEN, "whitespace-nowrap tabular-nums")}>
                            {row.validFrom}–{row.validTo}
                          </TableCell>
                          <TableCell className={cn(TD, PHONE_HIDDEN, "tabular-nums")}>
                            {t("logCounts", {
                              created: row.created,
                              cancelled: row.cancelled,
                              removed: row.removed,
                            })}
                          </TableCell>
                          <TableCell className={cn(TD, PHONE_HIDDEN, "pr-0 tabular-nums")}>
                            {t("logGateTally", { refuse: tally.refuse, warn: tally.warn })}
                            {row.acknowledgedWarnings ? ` · ${t("logAcknowledged")}` : ""}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
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
    </SectionCard>
  );
}
