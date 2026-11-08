"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { LazyDialog, loadConfirm } from "@/components/local/lazy-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { Skeleton } from "@/components/ui/skeleton";
import {
  contactErrors,
  contactFormOf,
  dayText,
  instantDayText,
  isCancellable,
  ruleText,
  updateBody,
  type ExternalBookingDetail,
  type ExternalContactForm,
  type ExternalDayResponse,
} from "@/lib/local";
import { useExternalBooking, useExternalBookingActions } from "@/lib/local-queries";
import { ContactFields } from "./contact-fields";
import { DayTable } from "./day-table";

/*
 * One series: who it is for, its days, and what can still be done with it
 * (fetched when first opened, components/local/lazy-dialog.tsx).
 *
 * The series is read when the dialog's content is on screen and not kept after
 * (the hook's gcTime is 0), since it carries the contact of somebody who has no
 * login. The body below is mounted with the content and unmounted when the dialog
 * is closed, so nothing of it is held while it is shut.
 *
 * A change is a change of who the series is for, never of when: a new rule is a
 * new series. Cancelling a day or the series is asked once, in the confirmation.
 */

export function SeriesDialog({
  open,
  onOpenChange,
  seriesId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seriesId: string | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <SeriesBody seriesId={seriesId} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

type Asking = { kind: "series" } | { kind: "day"; day: ExternalDayResponse } | null;

function SeriesBody({ seriesId, onClose }: { seriesId: string | null; onClose: () => void }) {
  const t = useTranslations("adminExternalBookings");
  const tLocal = useTranslations("local");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const series = useExternalBooking(seriesId);
  const actions = useExternalBookingActions();
  const [editing, setEditing] = useState<ExternalContactForm | null>(null);
  const [tried, setTried] = useState(false);
  // What the confirmation is about stays set while it closes, so its title does not empty under the fade.
  const [asking, setAsking] = useState<Asking>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const detail: ExternalBookingDetail | undefined = series.data;
  const errors = editing ? contactErrors(editing) : {};

  const save = async () => {
    if (!detail || !editing) return;
    setTried(true);
    if (Object.keys(errors).length > 0) return;
    try {
      await actions.update.mutateAsync({ id: detail.id, ...updateBody(editing) });
      // Said without a word of the contact: the toast outlives the dialog.
      toast.success(t("detail.savedToast"));
      setEditing(null);
      setTried(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const confirm = async () => {
    if (!detail || !asking) return;
    try {
      if (asking.kind === "series") {
        await actions.cancelSeries.mutateAsync(detail.id);
        toast.success(t("detail.seriesCancelledToast"));
      } else {
        await actions.cancelDay.mutateAsync({ id: detail.id, dayId: asking.day.id });
        toast.success(t("detail.dayCancelledToast"));
      }
      setConfirmOpen(false);
    } catch (error) {
      setConfirmOpen(false);
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const ask = (next: Exclude<Asking, null>) => {
    setAsking(next);
    setConfirmOpen(true);
  };

  const pending = actions.cancelSeries.isPending || actions.cancelDay.isPending;
  const now = Date.now();
  const cancelled = detail?.cancelledAt != null;
  const canCancelSeries = detail !== undefined && !cancelled && detail.days.upcoming > 0;

  return (
    <>
      <DialogHeader>
        <DialogTitle>{detail ? detail.organisation : t("detail.title")}</DialogTitle>
        <DialogDescription>
          {detail ? `${detail.target.name}${detail.resourceQuantity ? ` × ${detail.resourceQuantity}` : ""}. ${ruleText(detail, tLocal, locale)}` : t("detail.loading")}
        </DialogDescription>
      </DialogHeader>

      {series.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-48 w-full" />
        </div>
      ) : series.isError || !detail ? (
        <LoadError variant="inline" title={t("detail.loadFailed")} hint={t("detail.loadFailedHint")} />
      ) : (
        <div className="space-y-5">
          {cancelled ? (
            <Notice tone="neutral" title={t("detail.cancelledTitle")}>
              {t("detail.cancelledBody", { date: instantDayText(detail.cancelledAt ?? "", locale) })}
            </Notice>
          ) : null}

          <section aria-labelledby="series-contact-title" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id="series-contact-title" className="text-sm font-semibold">
                {t("detail.contact")}
              </h3>
              {editing === null ? (
                <Button data-writes="DRIFT" variant="outline" size="sm" onClick={() => setEditing(contactFormOf(detail))}>
                  {t("detail.edit")}
                </Button>
              ) : null}
            </div>
            {editing === null ? (
              <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                <Fact label={t("organisation")} value={detail.organisation} />
                <Fact label={t("contactName")} value={detail.contactName} />
                <Fact label={t("phone")} value={detail.contactPhone} />
                <Fact label={t("email")} value={detail.contactEmail} />
                <Fact label={t("purpose")} value={detail.purpose} />
                <Fact label={t("note")} value={detail.note} />
              </dl>
            ) : (
              <form
                noValidate
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save();
                }}
              >
                <ContactFields
                  form={editing}
                  errors={errors}
                  show={tried}
                  idPrefix="series"
                  onChange={(patch) => setEditing({ ...editing, ...patch })}
                />
                <div className="flex flex-wrap justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setEditing(null);
                      setTried(false);
                    }}
                  >
                    {tCommon("cancel")}
                  </Button>
                  <Button type="submit" disabled={actions.update.isPending}>
                    {actions.update.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
                    {tCommon("save")}
                  </Button>
                </div>
              </form>
            )}
            <p className="text-xs text-muted-foreground">
              {detail.registeredByName
                ? t("detail.registeredBy", { name: detail.registeredByName, date: instantDayText(detail.createdAt, locale) })
                : t("detail.registered", { date: instantDayText(detail.createdAt, locale) })}
            </p>
          </section>

          <section aria-labelledby="series-days-title" className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 id="series-days-title" className="text-sm font-semibold">
                  {t("detail.days")}
                </h3>
                <p className="text-xs tabular-nums text-muted-foreground">
                  {t("detail.daysSummary", { upcoming: detail.days.upcoming, total: detail.days.total, cancelled: detail.days.cancelled })}
                </p>
              </div>
              {canCancelSeries ? (
                <Button data-writes="DRIFT" variant="outline" size="sm" disabled={pending} onClick={() => ask({ kind: "series" })}>
                  {t("detail.cancelSeries")}
                </Button>
              ) : null}
            </div>
            {detail.days.skipped.length > 0 ? (
              <p className="text-sm">
                {t("detail.skipped", { count: detail.days.skipped.length })}{" "}
                <span className="tabular-nums text-muted-foreground">{detail.days.skipped.join(", ")}</span>
              </p>
            ) : null}
            {detail.occurrences.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("detail.noDays")}</p>
            ) : (
              <div role="region" aria-label={t("detail.daysTable")} tabIndex={0} className="max-h-80 overflow-y-auto rounded-md">
                <DayTable
                  caption={t("detail.daysTable")}
                  withAction
                  held
                  days={detail.occurrences.map((day) => ({
                    key: day.id,
                    date: day.date,
                    conflicts: day.conflicts,
                    cancelled: day.status === "CANCELLED",
                    action: isCancellable(day, now) ? (
                      <Button
                        data-writes="DRIFT"
                        variant="outline"
                        size="sm"
                        disabled={pending}
                        aria-label={t("detail.cancelDayNamed", { date: dayText(day.date, locale) })}
                        onClick={() => ask({ kind: "day", day })}
                      >
                        {t("detail.cancelDay")}
                      </Button>
                    ) : null,
                  }))}
                />
              </div>
            )}
          </section>
        </div>
      )}

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {tCommon("close")}
        </Button>
      </DialogFooter>

      <LazyDialog
        load={loadConfirm}
        kind="confirm"
        props={{
          open: confirmOpen,
          onOpenChange: setConfirmOpen,
          title:
            asking?.kind === "day"
              ? t("detail.cancelDayTitle", { date: dayText(asking.day.date, locale) })
              : t("detail.cancelSeriesTitle", { organisation: detail?.organisation ?? "" }),
          description:
            asking?.kind === "day" ? t("detail.cancelDayBody") : t("detail.cancelSeriesBody", { count: detail?.days.upcoming ?? 0 }),
          confirmLabel: asking?.kind === "day" ? t("detail.cancelDay") : t("detail.cancelSeries"),
          loading: pending,
          onConfirm: () => void confirm(),
        }}
      />
    </>
  );
}

/** One line of the contact: the label, and the value or a dash. */
function Fact({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words">{value && value.trim() !== "" ? value : <span className="text-muted-foreground">—</span>}</dd>
    </div>
  );
}
