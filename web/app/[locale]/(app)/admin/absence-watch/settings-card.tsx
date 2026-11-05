"use client";

import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useAbsenceWatchActions } from "@/lib/absence-watch-queries";
import {
  ABSENCE_WATCH_CADENCES,
  ABSENCE_WATCH_GROUPS,
  CADENCE_FIELD,
  type AbsenceWatchCadence,
  type AbsenceWatchGroup,
  type AbsenceWatchOverview,
  type AbsenceWatchSettingsChange,
} from "@/lib/absence-watch";
import { useAbsenceWatchText } from "@/components/absence-watch/use-absence-watch-text";
import { useReadOnly } from "@/components/profile-context";
import { FormField } from "@/components/ui/form-field";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Switch } from "@/components/ui/switch";

/**
 * The switch and how often each group gets its sammanställning.
 *
 * Off until an administrator turns it on, per school (a school with no row is
 * off). A press saves, so a läsare (Läsbehörighet) sees the switch and the
 * cadences set and cannot press them; one save at a time. The page says what
 * the sammanställningar hold, because turning it on starts e-mail to
 * mentors, rektor, kansli and guardians: counts only, never a name or a
 * reason.
 */
export function SettingsCard({ overview }: { overview: AbsenceWatchOverview }) {
  const { t, day } = useAbsenceWatchText();
  const tCommon = useTranslations("common");
  const readOnly = useReadOnly();
  const { updateSettings } = useAbsenceWatchActions();
  const { settings, limits } = overview;

  const save = async (change: AbsenceWatchSettingsChange, saved: string) => {
    // One save at a time; a control pressed meanwhile does nothing.
    if (updateSettings.isPending) return;
    try {
      await updateSettings.mutateAsync(change);
      toast.success(saved);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  return (
    <SectionCard id="absence-watch-settings" title={t("settings.title")} description={t("settings.description")}>
      <div className="flex items-start justify-between gap-4" data-writes-inert="DRIFT">
        <div className="min-w-0 space-y-1">
          <Label htmlFor="absence-watch-enabled">{t("settings.switchLabel")}</Label>
          <p id="absence-watch-enabled-hint" className="text-sm text-muted-foreground">
            {settings.enabled
              ? settings.enabledOn
                ? t("settings.onSince", { date: day(settings.enabledOn) })
                : t("settings.onHint")
              : t("settings.offHint")}
          </p>
        </div>
        <Switch
          id="absence-watch-enabled"
          checked={settings.enabled}
          disabled={readOnly}
          aria-describedby="absence-watch-enabled-hint"
          aria-disabled={updateSettings.isPending}
          onCheckedChange={(on) => void save({ enabled: on }, t(on ? "settings.turnedOn" : "settings.turnedOff"))}
        />
      </div>

      {settings.enabled && limits.length === 0 ? (
        <Notice tone="warning" title={t("settings.noLimitsTitle")}>
          {t("settings.noLimitsBody")}
        </Notice>
      ) : null}

      <div role="group" aria-labelledby="absence-watch-cadence-title" className="space-y-3 border-t pt-3" data-writes-inert="DRIFT">
        <div className="space-y-1">
          <h3 id="absence-watch-cadence-title" className="text-sm font-semibold">
            {t("settings.cadenceTitle")}
          </h3>
          <p className="text-sm text-muted-foreground">{t("settings.cadenceHint")}</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 [&>*]:min-w-0">
          {ABSENCE_WATCH_GROUPS.map((group: AbsenceWatchGroup) => (
            <FormField key={group} id={`absence-watch-cadence-${group}`} label={t(`group.${group}`)}>
              <NativeSelect
                value={settings.cadence[group]}
                disabled={readOnly}
                aria-disabled={updateSettings.isPending}
                onChange={(event) =>
                  void save(
                    { [CADENCE_FIELD[group]]: event.target.value as AbsenceWatchCadence },
                    t("settings.cadenceSaved", { group: t(`group.${group}`) }),
                  )
                }
              >
                {ABSENCE_WATCH_CADENCES.map((cadence) => (
                  <option key={cadence} value={cadence}>
                    {t(`cadence.${cadence}`)}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
          ))}
        </div>
      </div>
    </SectionCard>
  );
}
