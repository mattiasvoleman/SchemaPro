"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { useProfile } from "@/components/profile-context";
import { Button } from "@/components/ui/button";
import { LoadFailed } from "@/components/crisis/load-failed";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { profileDecides, type AdminProfile } from "@/lib/admin-areas";
import { useCrisisSettings, useSaveCrisisSettings } from "@/lib/crisis-admin-queries";
import { ALWAYS_START, STARTABLE_PROFILES, crisisErrorText } from "@/lib/crisis-view";
import type { MessageLookup } from "@/lib/engine-message";

/*
 * Inställningar: who may start an alarm and whether the guardians are told
 * afterwards. Both are decisions (Roller i skolan): everyone who opens the
 * page reads them, and rektor and full behörighet change them, as the
 * gateway's @Decides and the database's arm ask. Anybody else is told who
 * decides and sees the choices as they stand, not pressable.
 *
 * Rektor and full behörighet start, end and mark whatever is chosen
 * (app.crisis_may_start), so they are listed as always. What guardians are told
 * is said here in the words the notice uses: that an alarm happened and ended,
 * and nothing about any pupil, group or place.
 */

const OPTIONAL: readonly AdminProfile[] = STARTABLE_PROFILES.filter((profile) => !ALWAYS_START.includes(profile));

export function SettingsTab() {
  const t = useTranslations("crisis");
  const tProfile = useTranslations("adminAreas.profile");
  const tErrors = useTranslations("crisis.errors") as unknown as MessageLookup;
  const { profile } = useProfile();
  const decides = profileDecides(profile.adminProfile === undefined ? "FULL" : profile.adminProfile);
  const settings = useCrisisSettings();
  const save = useSaveCrisisSettings();
  const [chosen, setChosen] = useState<ReadonlySet<AdminProfile>>(new Set());
  const [notify, setNotify] = useState(false);

  // The form follows what the school has saved.
  useEffect(() => {
    if (!settings.data) return;
    setChosen(new Set(settings.data.startProfiles));
    setNotify(settings.data.notifyGuardiansAfter);
  }, [settings.data]);

  if (settings.isPending) {
    return (
      <div aria-busy="true">
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  if (settings.isError) {
    return <LoadFailed title={t("settings.loadFailed")} hint={t("settings.loadFailedHint")} headingLevel={2} />;
  }

  const saved = settings.data;
  const dirty =
    notify !== saved.notifyGuardiansAfter ||
    OPTIONAL.some((one) => chosen.has(one) !== saved.startProfiles.includes(one));

  const submit = () => {
    save.mutate(
      {
        // The deciders are always among those who start; the school chooses about the rest.
        startProfiles: STARTABLE_PROFILES.filter((one) => ALWAYS_START.includes(one) || chosen.has(one)),
        notifyGuardiansAfter: notify,
      },
      { onSuccess: () => toast.success(t("settings.saved")) },
    );
  };

  const toggle = (one: AdminProfile, on: boolean) =>
    setChosen((before) => {
      const next = new Set(before);
      if (on) next.add(one);
      else next.delete(one);
      return next;
    });

  return (
    <div className="max-w-3xl space-y-4">
      {decides ? null : <Notice tone="neutral">{t("settings.readOnly")}</Notice>}

      <SectionCard id="crisis-who" title={t("settings.whoTitle")} description={t("settings.whoBody")}>
        <ul className="space-y-2">
          {STARTABLE_PROFILES.map((one) => {
            const always = ALWAYS_START.includes(one);
            return (
              <li key={one}>
                <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border p-3">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4"
                    checked={always || chosen.has(one)}
                    disabled={always || !decides}
                    onChange={(event) => toggle(one, event.target.checked)}
                  />
                  <span className="text-sm">
                    <span className="font-medium">{tProfile(one)}</span>
                    {always ? <span className="block text-muted-foreground">{t("settings.always")}</span> : null}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      </SectionCard>

      <SectionCard id="crisis-guardians" title={t("settings.guardiansTitle")}>
        <div className="flex items-start justify-between gap-4 rounded-md border p-3">
          <div className="space-y-1 text-sm">
            <label htmlFor="crisis-notify" className="font-medium">
              {t("settings.guardiansLabel")}
            </label>
            <p id="crisis-notify-body" className="max-w-prose text-muted-foreground">
              {t("settings.guardiansBody")}
            </p>
          </div>
          <Switch
            id="crisis-notify"
            aria-describedby="crisis-notify-body"
            checked={notify}
            disabled={!decides}
            onCheckedChange={setNotify}
          />
        </div>
      </SectionCard>

      {save.isError ? <Notice tone="destructive">{crisisErrorText(tErrors, save.error, t("settings.saveFailed"))}</Notice> : null}
      {decides ? (
        <div className="flex justify-end">
          <Button type="button" disabled={!dirty || save.isPending} onClick={submit}>
            {save.isPending ? t("settings.saving") : t("settings.save")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
