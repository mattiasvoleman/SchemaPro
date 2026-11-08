"use client";

import { useState } from "react";
import { CalendarDays } from "lucide-react";
import { useMine } from "@/lib/class-teacher-queries";
import { ClassSchedule } from "@/components/class-teacher/class-schedule";
import { useClassTeacherText } from "@/components/class-teacher/use-class-teacher-text";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * /teacher/klass-schema — Klasslärarens schema (G5): a teacher an
 * administrator has appointed to a class for a läsår changes that class's
 * lessons, inside the frame the schemaläggare keeps.
 *
 * The frame is the database's (app.class_teacher_frame, asked through the
 * gateway): only the klasslärare's own lessons, only inside the hours the
 * schemaläggare opened, never a lesson shared with other teachers, a block, a
 * half-class, a replacing group or a shared room, and a published time only
 * by publication. Every change is a DRAFT that the schemaläggare publishes, or
 * the klasslärare does when the school has switched that on.
 *
 * Reached by its address for now: the menu entry is added with the menu (it
 * moves to the server in another change), and a teacher who is nobody's
 * klasslärare is told so here rather than refused.
 */
export default function ClassSchedulePage() {
  const { t } = useClassTeacherText();
  const mine = useMine();
  const [chosen, setChosen] = useState<string | null>(null);

  const classes = mine.data?.classes ?? [];
  const cls = classes.find((one) => one.id === chosen) ?? classes[0];

  return (
    <Page>
      <PageHeader title={t("title")} subtitle={t("subtitle")} intro={t("intro")} />
      {mine.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : mine.isError || !mine.data ? (
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      ) : !cls ? (
        <EmptyState icon={CalendarDays} headingLevel={2} title={t("noAppointment.title")} description={t("noAppointment.body")} />
      ) : (
        // One class at a time, and a class of its own state: another class starts at this week with nothing chosen.
        <ClassSchedule
          key={cls.id}
          cls={cls}
          classes={classes}
          onClassChange={setChosen}
          selfPublish={mine.data.selfPublish}
        />
      )}
    </Page>
  );
}
