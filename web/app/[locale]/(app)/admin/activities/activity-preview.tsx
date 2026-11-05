"use client";

/*
 * What the gateway says an activity would do: the lessons it cancels, the
 * replacement lessons it writes, the classes they are for and who is
 * responsible for each, and what the admin should read before saying yes.
 *
 * THE CLASSES ARE WHERE THE TEACHERS ARE PICKED. Which classes get a
 * replacement lesson is the gateway's answer (a class with no lesson in the
 * days has none), so the teachers cannot be asked for before a preview. The
 * pick is part of what the digest covers, though: the page says so when the
 * picks differ from the preview on screen, and asks for a new one.
 *
 * NO WARNING REFUSES. A class without a teacher, a lesson that goes on for
 * some of its pupils, a teacher busy elsewhere: each is named, because the
 * school may mean it (one teacher following two classes), and none stops
 * the create.
 */

import { useRef } from "react";
import { useTranslations } from "next-intl";
import { X } from "lucide-react";
import type { ActivityForm, PreviewState } from "@/lib/schedule-activity-form";
import { ACTIVITY_TEACHERS_PER_CLASS_MAX } from "@/lib/schedule-activity-form";
import type { ActivityPreview } from "@/lib/schedule-activity-types";
import type { Person } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";
import { personName, useFormats } from "./activity-format";

export function ActivityPreviewView({
  preview,
  state,
  form,
  changing,
  teachers,
  nameOf,
  idPrefix,
  onPick,
  onNotify,
  adjustedAction,
  footer,
}: {
  preview: ActivityPreview;
  /** "adjusted": the picks, credits or description differ from what was previewed. */
  state: Exclude<PreviewState, "stale">;
  form: ActivityForm;
  /** A change of an existing activity, not a new one. */
  changing: boolean;
  /** The active teachers one may pick. */
  teachers: readonly Person[];
  /** A teacher's name by id; a picked teacher who has left the list still has one. */
  nameOf: (teacherId: string) => string;
  idPrefix: string;
  onPick: (groupId: string, teacherIds: string[]) => void;
  onNotify: (notify: boolean) => void;
  /** Asks for the preview again; shown beside the notice that the picks are not in this one. */
  adjustedAction: React.ReactNode;
  /** The create or the change, at the end of what is read before it. */
  footer: React.ReactNode;
}) {
  const t = useTranslations("scheduleActivities");
  const { dayText, timeText, periodText } = useFormats();
  const pickers = useRef(new Map<string, HTMLSelectElement>());
  const { warnings } = preview;
  const titleId = `${idPrefix}-preview-title`;
  const classesId = `${idPrefix}-classes`;
  const hasWarnings =
    warnings.classesWithoutTeacher.length > 0 ||
    warnings.continuing.length > 0 ||
    warnings.uncoveredPupils > 0 ||
    warnings.teacherClashes.length > 0;

  return (
    <section aria-labelledby={titleId} className="space-y-3 rounded-md border p-3">
      <h3 id={titleId} className="text-sm font-semibold">
        {t("previewTitle")}
      </h3>
      <div className="space-y-1">
        <p>{t("cancelledLessons", { count: preview.matched })}</p>
        <p>{t("replacementSummary", { count: preview.replacementLessons })}</p>
        {preview.change ? (
          <p>{t("changeSummary", { taken: preview.change.taken, released: preview.change.released })}</p>
        ) : null}
        <p>
          {t("excluded", {
            started: preview.excluded.started,
            notScheduled: preview.excluded.notScheduled,
            attendance: preview.excluded.attendance,
          })}
        </p>
        {preview.ungradedGroups.length > 0 ? <p>{t("ungraded", { groups: preview.ungradedGroups.join(", ") })}</p> : null}
        {preview.expandedGroups.length > 0 ? (
          <p>
            {t("expanded", {
              count: preview.expandedGroups.length,
              groups: preview.expandedGroups.map((group) => group.name).join(", "),
            })}
          </p>
        ) : null}
        {form.credits.length > 0 ? (
          <p>
            {preview.creditDates.length > 0
              ? t("creditDates", { count: preview.creditDates.length, dates: preview.creditDates.map(dayText).join(", ") })
              : t("creditNoDates")}
          </p>
        ) : null}
      </div>

      {preview.classes.length > 0 ? (
        <div className="space-y-2">
          <h4 id={classesId} className="text-sm font-medium">
            {t("classesTitle")}
          </h4>
          <p id={`${classesId}-hint`} className="text-xs text-muted-foreground">
            {t("classesHint")}
          </p>
          <ul aria-labelledby={classesId} aria-describedby={`${classesId}-hint`} className="divide-y rounded-md border">
            {preview.classes.map((entry) => {
              const picked = form.teachers[entry.groupId] ?? [];
              const free = teachers.filter((teacher) => !picked.includes(teacher.id));
              const selectId = `${idPrefix}-add-${entry.groupId}`;
              return (
                <li key={entry.groupId} className="space-y-2 p-2">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium">{entry.name}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {entry.firstDate && entry.lastDate && entry.firstDate !== entry.lastDate
                        ? t("classDaysPeriod", { count: entry.days, period: periodText(entry.firstDate, entry.lastDate) })
                        : t("classDays", { count: entry.days })}
                    </span>
                  </div>
                  {picked.length > 0 ? (
                    <ul aria-label={t("teachersOf", { name: entry.name })} className="flex flex-wrap gap-1.5">
                      {picked.map((teacherId, index) => (
                        <li
                          key={teacherId}
                          className="inline-flex items-center gap-1 rounded-md border bg-muted py-0.5 pl-2 text-xs"
                        >
                          {nameOf(teacherId)}
                          {index === 0 ? <span className="text-muted-foreground">({t("lead")})</span> : null}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-6"
                            aria-label={t("removeTeacher", { teacher: nameOf(teacherId), name: entry.name })}
                            onClick={() => {
                              onPick(entry.groupId, picked.filter((id) => id !== teacherId));
                              // The chip that had focus is gone: hand it to the picker beside it.
                              pickers.current.get(entry.groupId)?.focus();
                            }}
                          >
                            <X aria-hidden="true" />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-muted-foreground">{t("noTeacher")}</p>
                  )}
                  {picked.length < ACTIVITY_TEACHERS_PER_CLASS_MAX ? (
                    <div className="max-w-xs">
                      <label htmlFor={selectId} className="sr-only">
                        {t("addTeacher", { name: entry.name })}
                      </label>
                      <NativeSelect
                        id={selectId}
                        ref={(element) => {
                          if (element) pickers.current.set(entry.groupId, element);
                          else pickers.current.delete(entry.groupId);
                        }}
                        // A picker, not a field: it always reads "add", and what it adds shows as a chip.
                        value=""
                        onChange={(event) => {
                          if (event.target.value) onPick(entry.groupId, [...picked, event.target.value]);
                        }}
                      >
                        <option value="">{t("addTeacherPlaceholder")}</option>
                        {free.map((teacher) => (
                          <option key={teacher.id} value={teacher.id}>
                            {personName(teacher)}
                          </option>
                        ))}
                      </NativeSelect>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {/* Beside the pickers it follows, not at the top: a pick is made down here, and asking again is the next step. */}
      {state === "adjusted" ? (
        <Notice tone="warning" role={null} action={adjustedAction}>
          {t("previewAdjusted")}
        </Notice>
      ) : null}

      {hasWarnings ? (
        <div className="space-y-2">
          {warnings.classesWithoutTeacher.length > 0 ? (
            <Notice
              tone="warning"
              role={null}
              title={t("warnNoTeacherTitle", { count: warnings.classesWithoutTeacher.length })}
            >
              <p>{t("warnNoTeacherBody")}</p>
              <ul className="list-disc pl-5">
                {warnings.classesWithoutTeacher.map((name) => (
                  <li key={name}>{name}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          {warnings.continuing.length > 0 ? (
            <Notice tone="warning" role={null} title={t("warnContinuingTitle")}>
              <p>{t("warnContinuingBody")}</p>
              <ul className="list-disc pl-5">
                {warnings.continuing.map((entry) => (
                  <li key={entry.name}>{t("warnContinuingItem", { name: entry.name, lessons: entry.lessons })}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          {warnings.uncoveredPupils > 0 ? (
            <Notice tone="warning" role={null}>
              {t("warnUncovered", { count: warnings.uncoveredPupils })}
            </Notice>
          ) : null}
          {warnings.teacherClashes.length > 0 ? (
            <Notice tone="warning" role={null} title={t("warnClashTitle")}>
              <ul className="list-disc pl-5">
                {warnings.teacherClashes.map((clash) => (
                  <li key={`${clash.teacherId}|${clash.date}|${clash.groupName}|${clash.busyWith}`}>
                    {t("warnClashItem", {
                      teacher: nameOf(clash.teacherId),
                      busyWith: clash.busyWith,
                      date: dayText(clash.date),
                      group: clash.groupName,
                    })}
                  </li>
                ))}
              </ul>
            </Notice>
          ) : null}
        </div>
      ) : null}

      {preview.lessons.length > 0 ? (
        // Focusable, since it scrolls: a keyboard reader reaches the lessons below the fold.
        <div
          role="region"
          aria-label={t("lessonsLabel")}
          tabIndex={0}
          className="max-h-64 overflow-y-auto rounded-md border p-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ul className="space-y-0.5">
            {preview.lessons.map((lesson) => (
              <li key={lesson.id} className="tabular-nums">
                {dayText(lesson.date)} {timeText(lesson.startsAt)}–{timeText(lesson.endsAt)} · {lesson.subjectName} ·{" "}
                {lesson.groupName}
              </li>
            ))}
            {preview.matched > preview.lessons.length ? (
              <li>{t("andMore", { count: preview.matched - preview.lessons.length })}</li>
            ) : null}
          </ul>
        </div>
      ) : null}
      <div className="flex items-start gap-3 rounded-md border p-3">
        <input
          id={`${idPrefix}-notify`}
          type="checkbox"
          className="mt-0.5 size-4 shrink-0"
          checked={form.notify}
          aria-describedby={`${idPrefix}-notify-hint`}
          onChange={(event) => onNotify(event.target.checked)}
        />
        <div className="space-y-1">
          <label htmlFor={`${idPrefix}-notify`} className="text-sm font-medium">
            {t("notify")}
          </label>
          <p id={`${idPrefix}-notify-hint`} className="text-xs text-muted-foreground">
            {t(changing ? "notifyHintChange" : "notifyHint", preview.audience)}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap justify-end gap-2 border-t pt-3">{footer}</div>
    </section>
  );
}
