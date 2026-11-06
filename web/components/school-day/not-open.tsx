"use client";

import { CalendarOff } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { useSchoolDayText } from "./use-school-day-text";

/**
 * What a teacher is told while the school has chosen nothing for teachers (the
 * default): a calm page and the way to the room booking, which has the rooms
 * and their hours. Not an error screen; the gateway's 403 is a state of the
 * page here.
 */
export function NotOpen() {
  const { t } = useSchoolDayText();
  return (
    <EmptyState
      icon={CalendarOff}
      headingLevel={2}
      title={t("notOpen.title")}
      description={t("notOpen.body")}
      action={
        <Button asChild variant="outline" size="sm">
          <Link href="/teacher/rooms">{t("notOpen.rooms")}</Link>
        </Button>
      }
    />
  );
}
