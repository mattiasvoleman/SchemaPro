"use client";

import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useReportingActions, useReportingSettings } from "@/lib/reporting-rate-queries";
import { OPEN_AFTER_DAYS, type ReportingSettings, type ReportingSettingsChange } from "@/lib/reporting-rate";
import { useReportingRateText } from "@/components/reporting-rate/use-reporting-rate-text";
import { useReadOnly } from "@/components/profile-context";
import { FormField } from "@/components/ui/form-field";
import { Label } from "@/components/ui/label";
import { LoadError } from "@/components/ui/load-error";
import { NativeSelect } from "@/components/ui/native-select";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

const DAYS = Array.from({ length: OPEN_AFTER_DAYS.max - OPEN_AFTER_DAYS.min + 1 }, (_, index) => OPEN_AFTER_DAYS.min + index);

/**
 * The two notices and when a lesson counts as open for long.
 *
 * Both are off until an administrator turns them on, per school (a school with
 * no row has both off and two days). A press saves, so a läsare (Läsbehörighet)
 * sees the switches set and cannot press them; one save at a time. The page
 * says what the notices hold, because turning one on starts e-mail and push:
 * counts and a period, never a name, a subject or a class.
 */
export function SettingsCard() {
  const { t } = useReportingRateText();
  const tCommon = useTranslations("common");
  const readOnly = useReadOnly();
  const settings = useReportingSettings();
  const { updateSettings } = useReportingActions();

  const save = async (change: ReportingSettingsChange, saved: string) => {
    // One save at a time; a control pressed meanwhile does nothing.
    if (updateSettings.isPending) return;
    try {
      await updateSettings.mutateAsync(change);
      toast.success(saved);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const body = (current: ReportingSettings) => (
    <>
      <div className="flex items-start justify-between gap-4" data-writes-inert="DRIFT">
        <div className="min-w-0 space-y-1">
          <Label htmlFor="reporting-rate-reminders">{t("settings.remindersLabel")}</Label>
          <p id="reporting-rate-reminders-hint" className="text-sm text-muted-foreground">
            {current.teacherReminders
              ? t("settings.remindersOn", { days: current.openAfterDays })
              : t("settings.remindersOff")}
          </p>
        </div>
        <Switch
          id="reporting-rate-reminders"
          checked={current.teacherReminders}
          disabled={readOnly}
          aria-describedby="reporting-rate-reminders-hint"
          aria-disabled={updateSettings.isPending}
          onCheckedChange={(on) =>
            void save({ teacherReminders: on }, t(on ? "settings.remindersTurnedOn" : "settings.remindersTurnedOff"))
          }
        />
      </div>

      <div className="flex items-start justify-between gap-4 border-t pt-3" data-writes-inert="DRIFT">
        <div className="min-w-0 space-y-1">
          <Label htmlFor="reporting-rate-digest">{t("settings.digestLabel")}</Label>
          <p id="reporting-rate-digest-hint" className="text-sm text-muted-foreground">
            {current.rektorDigest ? t("settings.digestOn") : t("settings.digestOff")}
          </p>
        </div>
        <Switch
          id="reporting-rate-digest"
          checked={current.rektorDigest}
          disabled={readOnly}
          aria-describedby="reporting-rate-digest-hint"
          aria-disabled={updateSettings.isPending}
          onCheckedChange={(on) =>
            void save({ rektorDigest: on }, t(on ? "settings.digestTurnedOn" : "settings.digestTurnedOff"))
          }
        />
      </div>

      <div className="border-t pt-3" data-writes-inert="DRIFT">
        <FormField id="reporting-rate-open-after" label={t("settings.openAfterLabel")} hint={t("settings.openAfterHint")} className="max-w-xs">
          <NativeSelect
            value={current.openAfterDays}
            disabled={readOnly}
            aria-disabled={updateSettings.isPending}
            onChange={(event) =>
              void save({ openAfterDays: Number(event.target.value) }, t("settings.openAfterSaved"))
            }
          >
            {DAYS.map((days) => (
              <option key={days} value={days}>
                {t("settings.openAfterOption", { days })}
              </option>
            ))}
          </NativeSelect>
        </FormField>
      </div>
    </>
  );

  return (
    <SectionCard id="reporting-rate-settings" title={t("settings.title")} description={t("settings.description")}>
      {settings.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-40 w-full" />
        </div>
      ) : settings.isError || !settings.data ? (
        <LoadError variant="inline" title={t("settings.loadFailed")} hint={t("settings.loadFailedHint")} />
      ) : (
        body(settings.data)
      )}
    </SectionCard>
  );
}
