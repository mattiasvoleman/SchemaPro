"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Link } from "@/i18n/navigation";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Label } from "@/components/ui/label";
import { LoadError } from "@/components/ui/load-error";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { CALENDAR_FEED_KEYS, useCalendarFeedCounts, type FeedAudience } from "@/lib/calendar-feed";
import { usePublicationSettings, useUpdatePublicationSettings } from "@/lib/publication-queries";
import { cn } from "@/lib/utils";
import type { PublicationSettings } from "@/lib/publication-types";

/**
 * Kalenderprenumeration for the school (20261112091000): whether teachers,
 * pupils and guardians may each make a calendar feed of their published
 * week. All three are off until the admin turns one on. Turning one off
 * stops every feed of that audience at once, for good: switching it on
 * again revives none, so the page always asks first, with the count read
 * again as it asks (a count from when the page opened may be none while
 * someone made one since), and says it cannot tell when the count fails.
 */

type FeedFlag = "calendarFeedTeachers" | "calendarFeedStudents" | "calendarFeedGuardians";
const AUDIENCES: { flag: FeedFlag; audience: FeedAudience }[] = [
  { flag: "calendarFeedTeachers", audience: "TEACHER" },
  { flag: "calendarFeedStudents", audience: "STUDENT" },
  { flag: "calendarFeedGuardians", audience: "GUARDIAN" },
];

export default function CalendarFeedSettingsPage() {
  const t = useTranslations("calendarFeedSettings");
  const tCommon = useTranslations("common");
  const settings = usePublicationSettings();
  const counts = useCalendarFeedCounts();
  const update = useUpdatePublicationSettings();
  const queryClient = useQueryClient();
  // Which audience the dialog asks about outlives its closing, so the exit
  // animation keeps its title.
  const [stopping, setStopping] = useState<FeedFlag | null>(null);
  const [asking, setAsking] = useState(false);

  const save = async (flag: FeedFlag, audience: FeedAudience, on: boolean) => {
    // One save at a time; the switches stay focusable meanwhile.
    if (update.isPending) return;
    try {
      await update.mutateAsync({ [flag]: on });
      toast.success(t(`${on ? "turnedOn" : "turnedOff"}.${audience}`));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    } finally {
      setAsking(false);
      // The admin's own feed follows the switch too (an admin's is a teacher's).
      void queryClient.invalidateQueries({ queryKey: CALENDAR_FEED_KEYS.mine });
      void queryClient.invalidateQueries({ queryKey: CALENDAR_FEED_KEYS.counts });
    }
  };
  const change = (flag: FeedFlag, audience: FeedAudience, on: boolean) => {
    // One save at a time: a switch pressed meanwhile does nothing, and says so (aria-disabled).
    if (update.isPending) return;
    if (on) {
      void save(flag, audience, on);
      return;
    }
    void counts.refetch();
    setStopping(flag);
    setAsking(true);
  };
  const stoppingAudience = AUDIENCES.find((entry) => entry.flag === stopping)?.audience ?? null;
  const stopBody = (audience: FeedAudience) => {
    const count = counts.data?.[audience];
    return counts.isError || counts.isFetching || count === undefined ? t("stopBodyUnknown") : t("stopBody", { count });
  };

  const body = (data: PublicationSettings) => (
    <SectionCard id="calendar-feed-audiences" title={t("audiencesTitle")} description={t("audiencesBody")} headingLevel={2}>
      <div className="space-y-4">
        {AUDIENCES.map(({ flag, audience }) => (
          <div key={flag} className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <Label htmlFor={`feed-${flag}`}>{t(`audience.${audience}`)}</Label>
              <p className="text-sm text-muted-foreground">
                {counts.isError
                  ? t("countFailed")
                  : counts.data
                    ? t("live", { count: counts.data[audience] ?? 0 })
                    : t("countLoading")}
              </p>
            </div>
            <Switch
              id={`feed-${flag}`}
              checked={data[flag]}
              onCheckedChange={(on) => change(flag, audience, on)}
              aria-disabled={update.isPending}
              className={cn(update.isPending && "cursor-not-allowed opacity-50")}
            />
          </div>
        ))}
      </div>
    </SectionCard>
  );

  return (
    <Page>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/calendar-feed">{t("own")}</Link>
          </Button>
        }
      />
      <div className="space-y-6">
        {settings.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : settings.isError || !settings.data ? (
          <LoadError title={t("loadFailed")} />
        ) : (
          body(settings.data)
        )}
        <SectionCard id="calendar-feed-what" title={t("whatTitle")} headingLevel={2}>
          <ul className="list-disc space-y-2 pl-5 text-sm">
            <li>{t("whatTeacher")}</li>
            <li>{t("whatPupil")}</li>
            <li>{t("whatPublished")}</li>
            <li>{t("whatSecret")}</li>
            <li>{t("whatLog")}</li>
          </ul>
        </SectionCard>
      </div>
      <ConfirmDialog
        open={asking}
        onOpenChange={(open) => {
          if (!open) setAsking(false);
        }}
        title={stoppingAudience ? t(`stopTitle.${stoppingAudience}`) : ""}
        description={stoppingAudience ? stopBody(stoppingAudience) : ""}
        confirmLabel={t("stopConfirm")}
        destructive
        loading={update.isPending}
        onConfirm={() => {
          if (stopping && stoppingAudience) void save(stopping, stoppingAudience, false);
        }}
      />
    </Page>
  );
}
