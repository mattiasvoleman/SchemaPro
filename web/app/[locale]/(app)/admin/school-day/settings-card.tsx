"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useSchoolDayActions, useSchoolDaySettings } from "@/lib/school-day-queries";
import { TEACHER_VIEWS, type TeacherView } from "@/lib/school-day";
import { profileDecides } from "@/lib/admin-areas";
import { useProfile, useReadOnly } from "@/components/profile-context";
import { useSchoolDayText } from "@/components/school-day/use-school-day-text";
import { Button } from "@/components/ui/button";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * What the school lets a teacher have of Skolans dag: nothing (until it
 * decides), the rooms, or the whole schedule. One row per school, a decision
 * like the others that are rektor's: every administrator reads it, and the
 * choice and the save are a decider's (rektor, full), as the gateway's
 * @Decides and the database's arm ask. Anybody else is told who decides and
 * sees what was chosen.
 *
 * Each option says in one honest sentence what it gives, because the choice
 * puts the staff's day on a screen: the third never gives who is free (absence,
 * uppdrag and rastvakt are not a teacher's to read), and no option names a
 * person with a protected identity to a teacher.
 */
export function SettingsCard() {
  const { t } = useSchoolDayText();
  const tCommon = useTranslations("common");
  const readOnly = useReadOnly();
  const me = useProfile().profile;
  const decides = profileDecides(me?.adminProfile === undefined ? "FULL" : me.adminProfile) && !readOnly;
  const settings = useSchoolDaySettings();
  const { updateSettings } = useSchoolDayActions();
  // What the reader has picked and not yet saved; null: what is saved.
  const [picked, setPicked] = useState<TeacherView | null>(null);

  const saved = settings.data?.teacherView;
  const current = picked ?? saved;
  const save = async () => {
    if (!current || updateSettings.isPending) return;
    try {
      await updateSettings.mutateAsync(current);
      setPicked(null);
      toast.success(t("settings.saved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  return (
    <SectionCard
      id="school-day-settings"
      title={t("settings.title")}
      description={t("settings.description")}
      className="print:hidden"
      footer={
        settings.data ? (
          <Button data-writes="DECIDES" disabled={!decides || picked === null || picked === saved || updateSettings.isPending} onClick={() => void save()}>
            {tCommon("save")}
          </Button>
        ) : undefined
      }
    >
      {settings.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-32 w-full" />
        </div>
      ) : settings.isError || !settings.data ? (
        <LoadError variant="inline" title={t("settings.loadFailed")} hint={t("settings.loadFailedHint")} />
      ) : (
        <fieldset className="space-y-3" data-writes-inert="DECIDES">
          <legend className="sr-only">{t("settings.title")}</legend>
          {TEACHER_VIEWS.map((one) => (
            <div key={one} className="flex items-start gap-3">
              <input
                id={`school-day-view-${one}`}
                type="radio"
                name="school-day-teacher-view"
                className="mt-1 size-4"
                value={one}
                checked={current === one}
                disabled={!decides}
                aria-describedby={`school-day-view-${one}-hint`}
                onChange={() => setPicked(one)}
              />
              <div className="min-w-0 space-y-0.5">
                <label htmlFor={`school-day-view-${one}`} className="text-sm font-medium">
                  {t(`settings.option.${one}`)}
                </label>
                <p id={`school-day-view-${one}-hint`} className="text-sm text-muted-foreground">
                  {t(`settings.hint.${one}`)}
                </p>
              </div>
            </div>
          ))}
          {!decides ? <p className="text-sm text-muted-foreground">{t("settings.deciders")}</p> : null}
        </fieldset>
      )}
    </SectionCard>
  );
}
