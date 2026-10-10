"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { MessageLookup } from "@/lib/engine-message";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("body")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2">
          <Switch
            id="ss-schedule"
            checked={source.scheduleEnabled}
            disabled={save.isPending}
            onCheckedChange={(checked) => patch({ scheduleEnabled: checked })}
          />
          <Label htmlFor="ss-schedule">{t("enabled")}</Label>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="ss-hour">{t("hour")}</Label>
            <select id="ss-hour" className={NATIVE_SELECT} value={hour} onChange={(event) => setHour(Number(event.target.value))}>
              {HOURS.map((value) => (
                <option key={value} value={value}>
                  {t("hourOption", { hour: String(value).padStart(2, "0") })}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{t("hourHint")}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="ss-full">{t("fullEveryDays")}</Label>
            <Input id="ss-full" type="number" min={1} max={31} value={fullEvery} aria-invalid={!fullEveryValid} onChange={(event) => setFullEvery(event.target.value)} />
            <p className="text-xs text-muted-foreground">{t("fullEveryDaysHint")}</p>
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!dirty || !fullEveryValid || save.isPending}
          onClick={() => patch({ scheduleHourLocal: hour, fullEveryDays })}
        >
          {t("saveTimes")}
        </Button>

        <div className="space-y-2 rounded-md border p-3">
          <div className="flex items-center gap-2">
            <Switch
              id="ss-auto"
              checked={source.scheduleAutoApply}
              disabled={!source.scheduleEnabled || save.isPending}
              onCheckedChange={(checked) => patch({ scheduleAutoApply: checked })}
            />
            <Label htmlFor="ss-auto">{t("autoApply")}</Label>
          </div>
          <p className="text-xs text-muted-foreground">{source.scheduleEnabled ? t("autoApplyBody") : t("autoApplyNeedsSchedule")}</p>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
            <li>{t("autoApplyDoes")}</li>
            <li>{t("autoApplyNever")}</li>
            <li>{t("autoApplyBrake")}</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
