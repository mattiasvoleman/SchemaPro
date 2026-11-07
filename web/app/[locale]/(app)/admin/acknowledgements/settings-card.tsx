"use client";

import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useAckActions, useAckSettings } from "@/lib/ack-queries";
import { REMIND_DAY_OPTIONS, type AckSettings, type AckSettingsChange } from "@/lib/ack";
import { useAckText } from "@/components/acknowledgements/use-ack-text";
import { useReadOnly } from "@/components/profile-context";
import { FormField } from "@/components/ui/form-field";
import { Label } from "@/components/ui/label";
import { LoadError } from "@/components/ui/load-error";
import { NativeSelect } from "@/components/ui/native-select";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

/** The value of the select's "no reminder" option; the days are their own numbers. */
const NONE = "none";

/**
 * The school's switch and how many days pass before the one reminder.
 *
 * Off until an administrator turns it on, per school (a school with no row is
 * off, and two days). A press saves, so a läsare (Läsbehörighet) sees the
 * switch and the days set and cannot press them; one save at a time. The card
 * says what turning it on does, because it lets staff send a notice to
 * guardians.
 */
export function SettingsCard() {
  const { t } = useAckText();
  const tCommon = useTranslations("common");
  const readOnly = useReadOnly();
  const settings = useAckSettings();
  const { updateSettings } = useAckActions();

  const save = async (change: AckSettingsChange, saved: string) => {
    // One save at a time; a control pressed meanwhile does nothing.
    if (updateSettings.isPending) return;
    try {
      await updateSettings.mutateAsync(change);
      toast.success(saved);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const body = (current: AckSettings) => (
    <>
      <div className="flex items-start justify-between gap-4" data-writes-inert="DRIFT">
        <div className="min-w-0 space-y-1">
          <Label htmlFor="ack-enabled">{t("settings.switchLabel")}</Label>
          <p id="ack-enabled-hint" className="text-sm text-muted-foreground">
            {current.enabled ? t("settings.onHint") : t("settings.offHint")}
          </p>
        </div>
        <Switch
          id="ack-enabled"
          checked={current.enabled}
          disabled={readOnly}
          aria-describedby="ack-enabled-hint"
          aria-disabled={updateSettings.isPending}
          onCheckedChange={(on) => void save({ enabled: on }, t(on ? "settings.turnedOn" : "settings.turnedOff"))}
        />
      </div>

      <div className="border-t pt-3" data-writes-inert="DRIFT">
        <FormField id="ack-remind" label={t("settings.remindLabel")} hint={t("settings.remindHint")} className="max-w-xs">
          <NativeSelect
            value={current.remindAfterDays === null ? NONE : String(current.remindAfterDays)}
            disabled={readOnly}
            aria-disabled={updateSettings.isPending}
            onChange={(event) =>
              void save(
                { remindAfterDays: event.target.value === NONE ? null : Number(event.target.value) },
                t("settings.remindSaved"),
              )
            }
          >
            <option value={NONE}>{t("settings.remindNone")}</option>
            {REMIND_DAY_OPTIONS.map((days) => (
              <option key={days} value={String(days)}>
                {t("settings.remindOption", { days })}
              </option>
            ))}
          </NativeSelect>
        </FormField>
      </div>
    </>
  );

  return (
    <SectionCard id="ack-settings" title={t("settings.title")} description={t("settings.description")}>
      {settings.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-32 w-full" />
        </div>
      ) : settings.isError || !settings.data ? (
        <LoadError variant="inline" title={t("settings.loadFailed")} hint={t("settings.loadFailedHint")} />
      ) : (
        body(settings.data)
      )}
    </SectionCard>
  );
}
