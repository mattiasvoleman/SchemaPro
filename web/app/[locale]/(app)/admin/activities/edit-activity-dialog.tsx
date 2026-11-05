"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { ScheduleActivity } from "@/lib/schedule-activity-types";
import type { AcademicYear, Person, StudentGroup, Subject } from "@/lib/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ActivityFormBody } from "./activity-form";

/*
 * Ändra: the activity's own form, filled in. A change describes the whole
 * activity again and the gateway judges it as one thing, so there is no
 * field-by-field patch: the admin changes what they mean to and previews the
 * result, which says what is put back and what is newly cancelled.
 *
 * The credit lines are not in the activity's view, and a change writes the
 * credits ahead anew from the lines it is sent. They are read back from
 * Tillgodoräknad tid before the form opens, so a change of the name or the
 * teachers does not take the credits away.
 */
export function EditActivityDialog({
  activity,
  year,
  groups,
  subjects,
  people,
  onClose,
}: {
  activity: ScheduleActivity | null;
  year: AcademicYear;
  groups: readonly StudentGroup[];
  subjects: readonly Subject[];
  people: readonly Person[];
  onClose: () => void;
}) {
  const t = useTranslations("scheduleActivities");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={activity !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="max-w-3xl"
        closeDisabled={busy}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("changeTitle", { name: activity?.name ?? "" })}</DialogTitle>
          <DialogDescription>{t("changeBody")}</DialogDescription>
        </DialogHeader>
        {activity ? (
          <ActivityFormBody
            key={activity.id}
            year={year}
            groups={groups}
            subjects={subjects}
            people={people}
            activity={activity}
            creditLines={activity.creditLines}
            idPrefix="activity-change"
            onDone={onClose}
            onCancel={onClose}
            onBusyChange={setBusy}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
