"use client";

import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useClassTeacherAdminActions, useClassTeacherSettings } from "@/lib/class-teacher-queries";
import { Label } from "@/components/ui/label";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useAreaGate } from "./use-area-gate";

/**
 * Whether a klasslärare publishes their own class's drafts.
 *
 * Off until an administrator turns it on, per school (a school with no row is
 * off). It is Publicering's: a press saves, so a profile that does not write
 * the area sees the switch set and cannot press it, and the card says who
 * changes it. The card says in plain words what turning it on lets a
 * klasslärare do, because the choice moves the last look at the timetable from
 * the schemaläggare to the teacher.
 */
export function SettingsCard() {
  const t = useTranslations("classTeacherAdmin");
  const tCommon = useTranslations("common");
  const gate = useAreaGate();
  const may = gate.may("PUBLICERING");
  const settings = useClassTeacherSettings();
  const { updateSettings } = useClassTeacherAdminActions();

  const save = async (selfPublish: boolean) => {
    // One save at a time; a control pressed meanwhile does nothing.
    if (!may || updateSettings.isPending) return;
    try {
      await updateSettings.mutateAsync(selfPublish);
      toast.success(selfPublish ? t("settings.turnedOn") : t("settings.turnedOff"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  return (
    <SectionCard id="class-teacher-settings" title={t("settings.title")} description={t("settings.description")}>
      {settings.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-16 w-full" />
        </div>
      ) : settings.isError || !settings.data ? (
        <LoadError variant="inline" title={t("settings.loadFailed")} hint={t("loadFailedHint")} />
      ) : (
        <div className="space-y-2">
          <div className="flex items-start justify-between gap-4" data-writes-inert="PUBLICERING">
            <div className="min-w-0 space-y-1">
              <Label htmlFor="class-teacher-self-publish">{t("settings.switchLabel")}</Label>
              <p id="class-teacher-self-publish-hint" className="text-sm text-muted-foreground">
                {settings.data.selfPublish ? t("settings.onHint") : t("settings.offHint")}
              </p>
            </div>
            <Switch
              id="class-teacher-self-publish"
              checked={settings.data.selfPublish}
              disabled={!may}
              aria-describedby="class-teacher-self-publish-hint"
              aria-disabled={updateSettings.isPending}
              onCheckedChange={(on) => void save(on)}
            />
          </div>
          {!may ? <p className="text-sm">{gate.why("PUBLICERING")}</p> : null}
        </div>
      )}
    </SectionCard>
  );
}
