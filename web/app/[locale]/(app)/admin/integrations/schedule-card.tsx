"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { MessageLookup } from "@/lib/engine-message";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionCard } from "@/components/ui/section-card";
import { Switch } from "@/components/ui/switch";
import { useReadOnly } from "@/components/profile-context";
import { NATIVE_SELECT } from "./form-styles";
import { errorText } from "./ss12000-messages";
import type { ScheduleInput, SourceView } from "./ss12000-types";
import { useSaveSchedule } from "./use-ss12000-source";

/*
 * Nattlig synk. Off until the admin turns it on (Ss12000Sources.scheduleEnabled
 * defaults to false), and then it only FETCHES: every night's diff waits for
 * review like a manual one. Automatic apply is a second, separate choice,
 * offered only while the schedule is on (the table's CHECK), and the card says
 * what it covers and what it never does — the set is the gateway's
 * (Ss12000SyncService.autoApply), not this page's.
 */

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

export function ScheduleCard({ source }: { source: SourceView }) {
  const t = useTranslations("integrations.schedule");
  const tErrors = useTranslations("integrations.errors") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const save = useSaveSchedule();
  // A press on either switch saves: a reader (Läsbehörighet) sees them set, not pressable.
  const readOnly = useReadOnly();
  const [hour, setHour] = useState(source.scheduleHourLocal);
  const [fullEvery, setFullEvery] = useState(String(source.fullEveryDays));

  const patch = (input: ScheduleInput) =>
    save.mutate(input, {
      onSuccess: () => toast.success(t("saved")),
      onError: (error) => toast.error(errorText(tErrors, error, tCommon("error"))),
    });
  const fullEveryDays = Number(fullEvery);
  const fullEveryValid = Number.isInteger(fullEveryDays) && fullEveryDays >= 1 && fullEveryDays <= 31;
  const dirty = hour !== source.scheduleHourLocal || (fullEveryValid && fullEveryDays !== source.fullEveryDays);

  return (
    <SectionCard id="ss-schedule-card" title={t("title")} description={t("body")}>
      <div className="space-y-4">
        {/* The rows, not only the switches: a label presses its switch as well, and a press saves. */}
        <div className="flex items-center justify-between gap-4 rounded-md border p-3" data-writes-inert="INTEGRATIONER">
          <Label htmlFor="ss-schedule">{t("enabled")}</Label>
          <Switch
            id="ss-schedule"
            checked={source.scheduleEnabled}
            disabled={readOnly || save.isPending}
            onCheckedChange={(checked) => patch({ scheduleEnabled: checked })}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0" data-writes-inert="INTEGRATIONER">
          <FormField id="ss-hour" label={t("hour")} hint={t("hourHint")}>
            <select className={NATIVE_SELECT} value={hour} onChange={(event) => setHour(Number(event.target.value))}>
              {HOURS.map((value) => (
                <option key={value} value={value}>
                  {t("hourOption", { hour: String(value).padStart(2, "0") })}
                </option>
              ))}
            </select>
          </FormField>
          <FormField id="ss-full" label={t("fullEveryDays")} hint={t("fullEveryDaysHint")}>
            <Input type="number" min={1} max={31} value={fullEvery} aria-invalid={!fullEveryValid || undefined} onChange={(event) => setFullEvery(event.target.value)} />
          </FormField>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!dirty || !fullEveryValid || save.isPending}
          onClick={() => patch({ scheduleHourLocal: hour, fullEveryDays })}
          data-writes="INTEGRATIONER"
        >
          {t("saveTimes")}
        </Button>

        <div className="space-y-2 rounded-md border p-3">
          <div className="flex items-start justify-between gap-4" data-writes-inert="INTEGRATIONER">
            <div className="space-y-1">
              <Label htmlFor="ss-auto">{t("autoApply")}</Label>
              <p id="ss-auto-hint" className="text-xs text-muted-foreground">
                {source.scheduleEnabled ? t("autoApplyBody") : t("autoApplyNeedsSchedule")}
              </p>
            </div>
            <Switch
              id="ss-auto"
              checked={source.scheduleAutoApply}
              disabled={readOnly || !source.scheduleEnabled || save.isPending}
              aria-describedby="ss-auto-hint"
              onCheckedChange={(checked) => patch({ scheduleAutoApply: checked })}
            />
          </div>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
            <li>{t("autoApplyDoes")}</li>
            <li>{t("autoApplyNever")}</li>
            <li>{t("autoApplyBrake")}</li>
          </ul>
        </div>
      </div>
    </SectionCard>
  );
}
