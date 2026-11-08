"use client";

import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { useSchoolDayActions, useSchoolDaySettings } from "@/lib/school-day-queries";
import { profileDecides } from "@/lib/admin-areas";
import { useProfile, useReadOnly } from "@/components/profile-context";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Elevens lektion för dagen: whether a guardian is told when their child is
 * moved to a parallel lesson for a day. The school's choice, off until it
 * says so, and a decision like the teachers' share beside it: every
 * administrator reads it, a decider (rektor, full) saves it. The teachers of
 * the two lessons are told whatever is chosen here.
 */
export function MoveNoticeCard() {
  const t = useTranslations("lessonMoves.settings");
  const tCommon = useTranslations("common");
  const readOnly = useReadOnly();
  const me = useProfile().profile;
  const decides = profileDecides(me?.adminProfile === undefined ? "FULL" : me.adminProfile) && !readOnly;
  const settings = useSchoolDaySettings();
  const { updateSettings } = useSchoolDayActions();

  const choose = async (next: boolean) => {
    if (!settings.data || updateSettings.isPending) return;
    try {
      await updateSettings.mutateAsync({ teacherView: settings.data.teacherView, guardianNoticeOnMove: next });
      toast.success(t("saved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  return (
    <SectionCard id="lesson-move-notice" title={t("title")} description={t("description")} className="print:hidden">
      {settings.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-10 w-full" />
        </div>
      ) : settings.isError || !settings.data ? (
        <LoadError variant="inline" title={t("loadFailed")} hint={t("loadFailedHint")} />
      ) : (
        <div className="flex items-start gap-3" data-writes-inert="DECIDES">
          <input
            id="lesson-move-guardian-notice"
            type="checkbox"
            className="mt-1 size-4"
            checked={settings.data.guardianNoticeOnMove === true}
            disabled={!decides || updateSettings.isPending}
            aria-describedby="lesson-move-guardian-notice-hint"
            onChange={(event) => void choose(event.target.checked)}
          />
          <div className="min-w-0 space-y-0.5">
            <label htmlFor="lesson-move-guardian-notice" className="text-sm font-medium">
              {t("guardianNotice")}
            </label>
            <p id="lesson-move-guardian-notice-hint" className="text-sm text-muted-foreground">
              {t("hint")}
            </p>
          </div>
        </div>
      )}
    </SectionCard>
  );
}
