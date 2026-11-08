"use client";

import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { useClassTeacherActions, usePreview } from "@/lib/class-teacher-queries";
import {
  WEEKDAYS,
  createTarget,
  formOfChange,
  formProblems,
  initialForm,
  isFault,
  previewTarget,
  problemOf,
  spotOfOccasion,
  spotOfTemplate,
  splitMinutes,
  updateTarget,
  type ChangeForm,
  type ChangeKind,
  type ChangeProblem,
  type ChangeView,
  type FormFieldName,
  type OccasionView,
  type PreviewBody,
  type TemplateLessonView,
  type WeekView,
} from "@/lib/class-teacher";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";
import { useClassTeacherText } from "./use-class-teacher-text";
import { VerdictView } from "./verdict-view";

/** How long the form stands still before the gateway is asked what the change would clash with. */
export const PREVIEW_DELAY_MS = 400;

export type LessonOfForm =
  | { layer: "occasion"; view: OccasionView }
  | { layer: "template"; view: TemplateLessonView };

/**
 * The form of one change: a move, a cancellation, another room, a move in the
 * weekly template or a split. It checks what it can itself (an end after its
 * start, a split's minutes adding up to the lesson) and asks the gateway, a
 * moment after the last keystroke, what the change would meet in the
 * timetable: the same check the schemaläggare's editor makes, shown under the
 * fields as "Konflikter" in a polite live region so a screen reader hears it
 * change without losing its place.
 *
 * Saving writes a DRAFT (nothing is published). A new draft is held to the
 * lesson's version as the page read it; an edit is held to the draft's
 * revision. When either has moved on, the answer is a 409 and the form says so
 * and keeps what was typed: nothing is overwritten silently, and the writer
 * chooses between taking the new draft and saving theirs over it.
 */
export function ChangeFormView({
  classId,
  week,
  lesson,
  kind,
  draft,
  fetching,
  onDone,
  onCancel,
  onReload,
  onOpenExisting,
}: {
  classId: string;
  week: WeekView;
  lesson: LessonOfForm;
  kind: ChangeKind;
  /** The draft being edited; null for a new one. */
  draft: ChangeView | null;
  /** The week is being read again (so a retry would still use an old revision). */
  fetching: boolean;
  onDone: () => void;
  onCancel: () => void;
  onReload: () => void;
  onOpenExisting: (draftId: string) => void;
}) {
  const { t, dayName, reason, problem, verdict: verdictText } = useClassTeacherText();
  const uid = useId();
  const fieldId = (name: string) => `${uid}-${name}`;
  const actions = useClassTeacherActions(classId);
  const spot = lesson.layer === "occasion" ? spotOfOccasion(lesson.view) : spotOfTemplate(lesson.view);

  const [form, setForm] = useState<ChangeForm>(() => (draft ? formOfChange(draft, spot) : initialForm(kind, spot)));
  const [failure, setFailure] = useState<ChangeProblem | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);

  const set = (patch: Partial<ChangeForm>) => setForm((current) => ({ ...current, ...patch }));
  const issues = formProblems(kind, form, spot);
  const faultOf = (field: FormFieldName): string | undefined => {
    const issue = issues.find((one) => one.field === field && isFault(one));
    return issue ? t(`form.problem.${issue.code}`) : undefined;
  };
  const roomName = (id: string | null) => (id ? (week.rooms.find((room) => room.id === id)?.name ?? null) : null);
  const ctx = { roomName };

  // The live check. Only a sendable form is asked about, a moment after it stood still.
  const previewBody: PreviewBody | null =
    issues.length === 0
      ? {
          kind,
          ...(lesson.layer === "occasion" ? { calendarLessonId: lesson.view.id } : { masterLessonId: lesson.view.id }),
          ...previewTarget(kind, form),
        }
      : null;
  const settled = useDebouncedValue(previewBody, PREVIEW_DELAY_MS);
  const preview = usePreview(classId, settled);
  const current = previewBody !== null && JSON.stringify(previewBody) === JSON.stringify(settled);
  const answered = current && !preview.isFetching;
  const live = answered && preview.data ? preview.data.verdict : null;
  const refused = live?.state === "REFUSED" || live?.state === "GONE";
  const previewProblem = answered && preview.isError ? problemOf(preview.error) : null;

  const pending = actions.create.isPending || actions.update.isPending;
  const save = async () => {
    if (pending || issues.length > 0) return;
    setFailure(null);
    try {
      if (draft) {
        await actions.update.mutateAsync({ id: draft.id, body: { rev: draft.rev, ...updateTarget(kind, form) } });
        toast.success(t("form.savedEdit"));
      } else {
        await actions.create.mutateAsync({
          kind,
          ...(lesson.layer === "occasion" ? { calendarLessonId: lesson.view.id } : { masterLessonId: lesson.view.id }),
          baseVersion: lesson.view.version,
          ...createTarget(kind, form),
        });
        toast.success(t("form.saved"));
      }
      onDone();
    } catch (error) {
      setFailure(problemOf(error));
    }
  };

  const dayField = (label: string) => (
    <FormField id={fieldId("day")} label={label} error={faultOf("dayOfWeek")}>
      <NativeSelect value={form.dayOfWeek} onChange={(event) => set({ dayOfWeek: event.target.value })}>
        <option value="">{t("form.pickDay")}</option>
        {WEEKDAYS.map((one) => (
          <option key={one} value={String(one)}>
            {dayName(one)}
          </option>
        ))}
      </NativeSelect>
    </FormField>
  );
  const timeFields = () => (
    <>
      <FormField id={fieldId("start")} label={t("form.start")} error={faultOf("start")}>
        <Input type="time" step={300} value={form.start} onChange={(event) => set({ start: event.target.value })} />
      </FormField>
      <FormField id={fieldId("end")} label={t("form.end")} error={faultOf("end")}>
        <Input type="time" step={300} value={form.end} onChange={(event) => set({ end: event.target.value })} />
      </FormField>
    </>
  );
  const roomField = (required: boolean) => (
    <FormField id={fieldId("room")} label={t("form.room")} error={faultOf("roomId")} hint={required ? undefined : t("form.roomHint")}>
      <NativeSelect value={form.roomId} onChange={(event) => set({ roomId: event.target.value })}>
        <option value="">{required ? t("form.pickRoom") : t("form.keepRoom")}</option>
        {week.rooms.map((room) => (
          <option key={room.id} value={room.id} disabled={room.refusal !== null}>
            {room.refusal === null ? room.name : t("form.roomRefused", { room: room.name, reason: reason(room.refusal) })}
          </option>
        ))}
      </NativeSelect>
    </FormField>
  );
  const noteField = () => (
    <FormField
      id={fieldId("note")}
      label={t("form.note")}
      optional
      hint={kind === "OCCASION_CANCEL" ? t("form.noteCancelHint") : t("form.noteHint")}
      error={faultOf("note")}
    >
      <Input maxLength={200} value={form.note} onChange={(event) => set({ note: event.target.value })} />
    </FormField>
  );

  /** What the writer can do about a 409, beside the notice that says it. */
  const failureAction = () => {
    if (!failure) return null;
    switch (failure.kind) {
      case "stale":
      case "gone":
        return (
          <Button type="button" variant="outline" size="sm" onClick={onReload} disabled={fetching}>
            {t("form.reload")}
          </Button>
        );
      case "rev":
        return (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={fetching || !draft}
              onClick={() => {
                if (draft) setForm(formOfChange(draft, spot));
                setFailure(null);
              }}
            >
              {t("form.takeTheirs")}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={fetching} onClick={() => void save()}>
              {t("form.keepMine")}
            </Button>
          </div>
        );
      case "exists":
        return (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={fetching || lesson.view.draftId === null}
            onClick={() => lesson.view.draftId && onOpenExisting(lesson.view.draftId)}
          >
            {t("form.openExisting")}
          </Button>
        );
      default:
        return null;
    }
  };

  const minutes = kind === "TEMPLATE_SPLIT" ? splitMinutes(form, spot) : null;
  const grid = "grid gap-3 sm:grid-cols-2 [&>*]:min-w-0";

  return (
    <form
      className="space-y-4"
      aria-labelledby={fieldId("title")}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="space-y-1">
        <h3 id={fieldId("title")} ref={headingRef} tabIndex={-1} className="text-sm font-semibold focus:outline-none">
          {draft ? t("form.editTitle", { action: t(`form.title.${kind}`) }) : t(`form.title.${kind}`)}
        </h3>
        <p className="text-sm text-muted-foreground">{t(`form.intro.${kind}`)}</p>
      </div>

      {kind === "OCCASION_MOVE" ? (
        <div className={grid}>
          <FormField id={fieldId("date")} label={t("form.date")} error={faultOf("date")} className="sm:col-span-2">
            <Input type="date" value={form.date} onChange={(event) => set({ date: event.target.value })} />
          </FormField>
          {timeFields()}
          <div className="sm:col-span-2">{roomField(false)}</div>
        </div>
      ) : null}

      {kind === "OCCASION_ROOM" ? <div className={grid}>{roomField(true)}</div> : null}

      {kind === "TEMPLATE_MOVE" ? (
        <div className={grid}>
          <div className="sm:col-span-2">{dayField(t("form.dayOfWeek"))}</div>
          {timeFields()}
          <div className="sm:col-span-2">{roomField(false)}</div>
        </div>
      ) : null}

      {kind === "TEMPLATE_SPLIT" ? (
        <div className="space-y-4">
          <fieldset className="space-y-2 rounded-md border p-3">
            <legend className="px-1 text-sm font-medium">{t("form.firstPart")}</legend>
            <p className="text-sm text-muted-foreground">
              {t("form.firstPartKeeps", { day: dayName(spot.dayOfWeek).toLocaleLowerCase(), start: spot.start })}
            </p>
            <FormField id={fieldId("keepEnd")} label={t("form.keepEnd")} error={faultOf("keepEnd")} className="max-w-48">
              <Input type="time" step={300} value={form.keepEnd} onChange={(event) => set({ keepEnd: event.target.value })} />
            </FormField>
          </fieldset>
          <fieldset className="space-y-2 rounded-md border p-3">
            <legend className="px-1 text-sm font-medium">{t("form.secondPart")}</legend>
            <div className={grid}>
              <div className="sm:col-span-2">{dayField(t("form.dayOfWeek"))}</div>
              {timeFields()}
              <div className="sm:col-span-2">{roomField(false)}</div>
            </div>
          </fieldset>
          {minutes && Number.isFinite(minutes.first) && Number.isFinite(minutes.second) ? (
            <p className="text-sm" data-testid="split-minutes">
              {t("form.minutes", { first: minutes.first, second: minutes.second, sum: minutes.first + minutes.second, total: minutes.total })}
            </p>
          ) : null}
        </div>
      ) : null}

      {noteField()}

      {issues.filter((issue) => issue.field === "form").map((issue) => (
        <p key={issue.code} className={issue.code === "NO_CHANGE" ? "text-sm text-muted-foreground" : "text-sm text-destructive"}>
          {t(`form.problem.${issue.code}`)}
        </p>
      ))}

      <div className="space-y-2" aria-labelledby={fieldId("conflicts")} role="group">
        <p id={fieldId("conflicts")} className="text-sm font-medium">
          {t("preview.title")}
        </p>
        {/* Mounted from the first render, so that what is put in it is announced. */}
        <div role="status" aria-live="polite" aria-atomic="false" data-testid="preview-region">
          {previewBody === null ? (
            <p className="text-sm text-muted-foreground">{t("preview.fixForm")}</p>
          ) : !answered ? (
            <p className="text-sm text-muted-foreground">{t("preview.checking")}</p>
          ) : previewProblem ? (
            <VerdictView
              verdict={{
                tone: "destructive",
                headline: problem(previewProblem).headline,
                lines: [(previewProblem.kind === "frame" && previewProblem.reason === null ? null : problem(previewProblem).detail) ?? t("preview.failed")],
              }}
            />
          ) : live ? (
            live.state === "OK" && !live.removes?.lessons ? (
              <VerdictView verdict={{ tone: "ok", headline: t("preview.ok"), lines: [] }} />
            ) : (
              <VerdictView verdict={verdictText(live, ctx)} />
            )
          ) : (
            <p className="text-sm text-muted-foreground">{t("preview.failed")}</p>
          )}
        </div>
        {live?.state === "CONFLICT" ? <p className="text-sm text-muted-foreground">{t("preview.conflictAdvice")}</p> : null}
      </div>

      {failure ? (
        <Notice
          tone="destructive"
          title={problem(failure).headline}
          onDismiss={() => setFailure(null)}
          action={failureAction()}
        >
          {problem(failure).detail}
        </Notice>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          {t("form.cancel")}
        </Button>
        <Button type="submit" disabled={issues.length > 0 || refused || pending}>
          {pending ? t("form.saving") : draft ? t("form.saveEdit") : t("form.save")}
        </Button>
      </div>
    </form>
  );
}
