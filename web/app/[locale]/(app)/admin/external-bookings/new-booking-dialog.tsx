"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { ApiError } from "@/lib/api";
import {
  EXTERNAL_CONFLICTS_CODE,
  LIMITS,
  WEEKDAYS,
  WEEKDAY_KEYS,
  blockedDays,
  contactErrors,
  createBody,
  emptyExternalForm,
  ruleBody,
  ruleErrors,
  ruleKey,
  type ExternalBookingResult,
  type ExternalForm,
  type ExternalOccurrencePreview,
  type ExternalPreviewResponse,
} from "@/lib/local";
import { useExternalBookingActions, useResources } from "@/lib/local-queries";
import { useRooms } from "@/lib/queries";
import { toDateString } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { LoadError } from "@/components/ui/load-error";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";
import { ContactFields } from "./contact-fields";
import { DayTable } from "./day-table";

/*
 * Ny extern bokning: a series for somebody who has no login, fetched when the
 * dialog is first opened (components/local/lazy-dialog.tsx).
 *
 * The preview is the registration without the writes: the same rule, asked of
 * the gateway, answers every day with what it meets. A registration that meets a
 * BLOCK on any day is refused whole (409 EXTERNAL_BOOKING_CONFLICTS) unless the
 * box "Hoppa över dagar som krockar" is ticked, so nobody gets half a term by
 * mistake. api.ts keeps a refusal's code and not the days it lists, so the days
 * of a 409 are read by asking the preview again.
 *
 * What is typed about the contact stays in this form and goes to the gateway:
 * no toast, no log and no URL carries a value of it.
 */

export function NewBookingDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations("adminExternalBookings");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("newTitle")}</DialogTitle>
          <DialogDescription>{t("newHint")}</DialogDescription>
        </DialogHeader>
        <NewBookingForm onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

type Tried = "none" | "rule" | "all";

function NewBookingForm({ onClose }: { onClose: () => void }) {
  const t = useTranslations("adminExternalBookings");
  const tLocal = useTranslations("local");
  const tCommon = useTranslations("common");
  const rooms = useRooms();
  const resources = useResources();
  const actions = useExternalBookingActions();
  const [form, setForm] = useState<ExternalForm>(() => emptyExternalForm(toDateString(new Date())));
  const [tried, setTried] = useState<Tried>("none");
  const [preview, setPreview] = useState<{ key: string; data: ExternalPreviewResponse } | null>(null);
  // The days a refused registration met, or null when they could not be read again.
  const [refused, setRefused] = useState<{ days: ExternalOccurrencePreview[] | null } | null>(null);
  const [done, setDone] = useState<ExternalBookingResult | null>(null);

  const set = (patch: Partial<ExternalForm>) => {
    setForm((current) => ({ ...current, ...patch }));
    // A refusal is about the form it was given: it is not said again over another.
    setRefused(null);
  };
  const rule = ruleErrors(form);
  const contact = contactErrors(form);
  const showRule = tried !== "none";
  const showContact = tried === "all";
  // Numbers are passed as text, so that a limit of 1 000 is not set in the language's own grouping.
  const ruleError = (field: keyof typeof rule) =>
    showRule && rule[field]
      ? t(`errors.${rule[field]}`, { max: String(field === "quantity" ? LIMITS.quantity : LIMITS.seriesDays) })
      : undefined;
  const current = preview && preview.key === ruleKey(form) ? preview.data : null;
  const busy = actions.preview.isPending || actions.create.isPending;
  const roomList = rooms.data ?? [];
  const resourceList = resources.data ?? [];
  const chosenResource = resourceList.find((resource) => resource.id === form.resourceId);

  const runPreview = async () => {
    setTried((was) => (was === "none" ? "rule" : was));
    if (Object.keys(rule).length > 0) return;
    setRefused(null);
    try {
      setPreview({ key: ruleKey(form), data: await actions.preview.mutateAsync(ruleBody(form)) });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const register = async () => {
    setTried("all");
    if (Object.keys(rule).length > 0 || Object.keys(contact).length > 0) return;
    try {
      const result = await actions.create.mutateAsync(createBody(form));
      setDone(result);
      // Said without a word of the contact: the toast outlives the dialog.
      toast.success(t("registeredToast"));
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.code === EXTERNAL_CONFLICTS_CODE) {
        await explainRefusal();
      } else {
        toast.error(error instanceof Error ? error.message : tCommon("error"));
      }
    }
  };

  const explainRefusal = async () => {
    try {
      const data = await actions.preview.mutateAsync(ruleBody(form));
      setPreview({ key: ruleKey(form), data });
      setRefused({ days: blockedDays(data) });
    } catch {
      setRefused({ days: null });
    }
  };

  if (done) {
    return (
      <div className="space-y-4">
        <Notice tone="success" title={t("doneTitle")}>
          {t("doneBody", { created: done.created })}
        </Notice>
        {done.skipped.length > 0 ? (
          <div className="space-y-2">
            <p className="text-sm">{t("skippedIntro", { count: done.skipped.length })}</p>
            <div role="region" aria-label={t("skippedDays")} tabIndex={0} className="max-h-64 overflow-y-auto rounded-md">
              <DayTable
                caption={t("skippedDays")}
                days={done.skipped.map((day) => ({ key: day.date, date: day.date, conflicts: day.conflicts }))}
              />
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button autoFocus onClick={onClose}>
            {tCommon("close")}
          </Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <form
      noValidate
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        void register();
      }}
    >
      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">{t("sectionWhat")}</legend>
        <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
          <FormField id="ext-kind" label={t("kind")}>
            <NativeSelect
              value={form.target}
              onChange={(event) => set({ target: event.target.value as ExternalForm["target"] })}
            >
              <option value="ROOM">{t("kindRoom")}</option>
              <option value="RESOURCE">{t("kindResource")}</option>
            </NativeSelect>
          </FormField>
          {form.target === "ROOM" ? (
            <FormField id="ext-room" label={tCommon("room")} error={ruleError("target")}>
              <NativeSelect value={form.roomId} onChange={(event) => set({ roomId: event.target.value })}>
                <option value="">{tCommon("select")}</option>
                {roomList.map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.name}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
          ) : (
            <FormField id="ext-resource" label={t("resource")} error={ruleError("target")}>
              <NativeSelect value={form.resourceId} onChange={(event) => set({ resourceId: event.target.value })}>
                <option value="">{tCommon("select")}</option>
                {resourceList.map((resource) => (
                  <option key={resource.id} value={resource.id}>
                    {resource.name}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
          )}
        </div>
        {form.target === "ROOM" && rooms.isError ? (
          <LoadError variant="inline" title={t("roomsLoadFailed")} hint={t("optionsLoadFailedHint")} />
        ) : null}
        {form.target === "RESOURCE" && resources.isError ? (
          <LoadError variant="inline" title={t("resourcesLoadFailed")} hint={t("optionsLoadFailedHint")} />
        ) : null}
        {form.target === "RESOURCE" ? (
          <FormField
            id="ext-quantity"
            label={t("quantity")}
            hint={chosenResource ? t("quantityOf", { total: chosenResource.quantity }) : undefined}
            error={ruleError("quantity")}
            className="max-w-40"
          >
            <Input
              type="number"
              inputMode="numeric"
              min={1}
              max={LIMITS.quantity}
              step={1}
              value={form.resourceQuantity}
              onChange={(event) => set({ resourceQuantity: event.target.value })}
            />
          </FormField>
        ) : null}
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">{t("sectionWhen")}</legend>
        <fieldset
          className="space-y-1.5"
          aria-describedby={ruleError("weekdays") ? "ext-weekdays-error" : undefined}
        >
          <legend className="text-sm font-medium">{t("weekdays")}</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {WEEKDAYS.map((weekday) => (
              <label key={weekday} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={form.weekdays.includes(weekday)}
                  onChange={(event) =>
                    set({
                      weekdays: event.target.checked
                        ? [...form.weekdays, weekday]
                        : form.weekdays.filter((chosen) => chosen !== weekday),
                    })
                  }
                />
                {tCommon(WEEKDAY_KEYS[weekday - 1] as (typeof WEEKDAY_KEYS)[number])}
              </label>
            ))}
          </div>
          {ruleError("weekdays") ? (
            <p id="ext-weekdays-error" className="text-xs text-destructive">
              {ruleError("weekdays")}
            </p>
          ) : null}
        </fieldset>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-4"
            checked={form.everyOtherWeek}
            onChange={(event) => set({ everyOtherWeek: event.target.checked })}
          />
          {t("everyOtherWeek")}
        </label>
        <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
          <FormField id="ext-start-date" label={t("startDate")} error={ruleError("startDate")}>
            <DateField label={t("startDate")} value={form.startDate} onChange={(value) => set({ startDate: value })} />
          </FormField>
          <FormField id="ext-end-date" label={t("endDate")} error={ruleError("endDate")}>
            <DateField
              label={t("endDate")}
              value={form.endDate}
              min={form.startDate || undefined}
              onChange={(value) => set({ endDate: value })}
            />
          </FormField>
          <FormField id="ext-start-time" label={t("startTime")} error={ruleError("startTime")}>
            <Input type="time" className="tabular-nums" value={form.startTime} onChange={(event) => set({ startTime: event.target.value })} />
          </FormField>
          <FormField id="ext-end-time" label={t("endTime")} error={ruleError("endTime")}>
            <Input type="time" className="tabular-nums" value={form.endTime} onChange={(event) => set({ endTime: event.target.value })} />
          </FormField>
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-sm font-semibold">{t("sectionWho")}</legend>
        <p className="text-xs text-muted-foreground">{t("contactHint")}</p>
        <ContactFields form={form} errors={contact} show={showContact} idPrefix="ext" onChange={(patch) => set(patch)} />
      </fieldset>

      <div className="space-y-3 rounded-md border p-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" onClick={() => void runPreview()} disabled={busy}>
            {actions.preview.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {t("preview")}
          </Button>
          <p className="text-xs text-muted-foreground">{t("previewHint")}</p>
        </div>
        {/* Always mounted, so the result is announced when it arrives. */}
        <div aria-live="polite" className="space-y-2">
          {current ? (
            <>
              <p className="text-sm font-medium tabular-nums">
                {t("previewSummary", { count: current.count, blocked: current.blocked, warned: current.warned })}
              </p>
              {current.framesMissing ? <p className="text-xs text-muted-foreground">{t("framesMissing")}</p> : null}
              {current.occurrences.length > 0 ? (
                <div role="region" aria-label={t("previewDays")} tabIndex={0} className="max-h-64 overflow-y-auto rounded-md">
                  <DayTable
                    caption={t("previewDays")}
                    days={current.occurrences.map((day) => ({ key: day.date, date: day.date, conflicts: day.conflicts }))}
                  />
                </div>
              ) : null}
            </>
          ) : null}
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-0.5 size-4"
            checked={form.skipConflicts}
            aria-describedby="ext-skip-hint"
            onChange={(event) => set({ skipConflicts: event.target.checked })}
          />
          <span>
            <span className="font-medium">{t("skipConflicts")}</span>
            <span id="ext-skip-hint" className="block text-xs text-muted-foreground">
              {t("skipConflictsHint")}
            </span>
          </span>
        </label>
      </div>

      {refused ? (
        <Notice tone="destructive" role="alert" title={t("refusedTitle")}>
          <p>
            {refused.days === null
              ? t("refusedUnknown")
              : refused.days.length === 0
                ? t("refusedGone")
                : t("refusedBody", { count: refused.days.length })}
          </p>
          {refused.days !== null && refused.days.length > 0 ? (
            <div role="region" aria-label={t("refusedDays")} tabIndex={0} className="mt-2 max-h-64 overflow-y-auto rounded-md bg-card">
              <DayTable
                caption={t("refusedDays")}
                days={refused.days.map((day) => ({ key: day.date, date: day.date, conflicts: day.conflicts }))}
              />
            </div>
          ) : null}
        </Notice>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {tCommon("cancel")}
        </Button>
        <Button type="submit" disabled={busy}>
          {actions.create.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
          {t("register")}
        </Button>
      </DialogFooter>
    </form>
  );
}
