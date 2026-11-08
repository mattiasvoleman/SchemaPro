"use client";

import { useEffect, useRef, useState } from "react";
import {
  OCCASION_KINDS,
  TEMPLATE_KINDS,
  canSplit,
  draftOf,
  isEditable,
  lessonState,
  spotOfOccasion,
  spotOfTemplate,
  type ChangeKind,
  type CheckRow,
  type WeekView,
} from "@/lib/class-teacher";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { ChangeFormView, type LessonOfForm } from "./change-form";
import { useClassTeacherText } from "./use-class-teacher-text";
import { useDiscardDraft } from "./use-discard-draft";
import { VerdictView } from "./verdict-view";

/** Which form is open: a new change of a kind, or the lesson's draft being edited. */
interface Mode {
  kind: ChangeKind;
  editing: boolean;
}

/**
 * The lesson the klasslärare has chosen, and what can be done with it.
 *
 * A locked lesson says why, in the frame's own words, and offers nothing. An
 * editable one offers the actions of its layer (a dated lesson: move, cancel,
 * change room; a lesson of the weekly template: move it in the template, split
 * it), and a lesson that already has a draft shows the draft instead: one
 * draft per lesson, so a second change is an edit of the first.
 */
export function LessonPanel({
  classId,
  week,
  lesson,
  check,
  fetching,
  onReload,
  startEditing = false,
}: {
  classId: string;
  week: WeekView;
  lesson: LessonOfForm;
  check: CheckRow[] | undefined;
  fetching: boolean;
  onReload: () => void;
  /** Opened from "Redigera" in the list of drafts: the lesson's draft opens in its form at once. */
  startEditing?: boolean;
}) {
  const { t, day, dayName, span, reason, summary, verdict } = useClassTeacherText();
  const discard = useDiscardDraft(classId);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const view = lesson.view;
  const draft = draftOf(week, view.draftId);
  const [mode, setMode] = useState<Mode | null>(() => (startEditing && draft ? { kind: draft.kind, editing: true } : null));
  // A draft being edited that is no longer there (thrown away, or published, by somebody else): the form is closed
  // and does not turn into a new draft by itself.
  const editingGone = mode?.editing === true && draft === null;
  useEffect(() => {
    if (editingGone) setMode(null);
  }, [editingGone]);
  // Choosing a lesson moves the reader to what can be done with it (a form that opens at once takes the focus itself).
  useEffect(() => {
    if (mode === null) headingRef.current?.focus();
    // On arrival only: later changes of the mode place the focus themselves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const checked = draft ? check?.find((row) => row.change.id === draft.id) : undefined;
  const state = lessonState({ refusal: view.refusal, draftId: view.draftId, status: lesson.layer === "occasion" ? lesson.view.status : undefined });
  const spot = lesson.layer === "occasion" ? spotOfOccasion(lesson.view) : spotOfTemplate(lesson.view);
  const kinds = lesson.layer === "occasion" ? OCCASION_KINDS : TEMPLATE_KINDS;
  const roomName = (id: string | null) => (id ? (week.rooms.find((room) => room.id === id)?.name ?? null) : null);
  const ctx = { roomName };
  const when =
    lesson.layer === "occasion"
      ? `${day(lesson.view.date)} ${span(view.start, view.end)}`
      : `${dayName(lesson.view.dayOfWeek)} ${span(view.start, view.end)}`;
  const finished = () => {
    setMode(null);
    headingRef.current?.focus();
  };
  const discardProblem = draft ? discard.problems[draft.id] : undefined;

  return (
    <section aria-labelledby="lesson-panel-title" className="space-y-4 rounded-lg border bg-card p-4">
      <div className="space-y-1">
        <h2 id="lesson-panel-title" ref={headingRef} tabIndex={-1} className="text-base font-semibold focus:outline-none">
          {view.subjectName}
        </h2>
        <p className="text-sm">{when}</p>
        <p className="text-sm text-muted-foreground">
          {[
            view.mine ? t("lesson.mine") : t("lesson.notMine"),
            roomName(view.roomId) ? t("lesson.room", { room: roomName(view.roomId)! }) : t("lesson.noRoom"),
            lesson.layer === "template" && (lesson.view.recurrence === "ODD_WEEKS" || lesson.view.recurrence === "EVEN_WEEKS")
              ? t(`lesson.recurrence.${lesson.view.recurrence}`)
              : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <Badge variant={state === "editable" ? "success" : state === "draft" ? "warning" : "secondary"}>{t(`state.${state}`)}</Badge>
      </div>

      {view.refusal !== null ? (
        <Notice tone="neutral" title={t("panel.lockedTitle")}>
          {reason(view.refusal)}
        </Notice>
      ) : null}

      {draft ? (
        <div className="space-y-3 rounded-md border border-warning/50 bg-warning/10 p-3">
          <p className="text-sm font-medium">{t("panel.draftTitle")}</p>
          <p className="text-sm">{summary(draft, view.subjectName, ctx)}</p>
          {checked ? <VerdictView verdict={verdict(checked.verdict, ctx)} /> : null}
          {discardProblem ? (
            <Notice
              tone="destructive"
              title={discardProblem.kind === "rev" ? t("problem.rev") : discardProblem.kind === "gone" ? t("problem.gone") : t("problem.other")}
              onDismiss={() => discard.clear(draft.id)}
              action={
                discardProblem.kind === "rev" || discardProblem.kind === "gone" ? (
                  <Button type="button" variant="outline" size="sm" onClick={onReload} disabled={fetching}>
                    {t("form.reload")}
                  </Button>
                ) : undefined
              }
            >
              {discardProblem.kind === "rev" ? t("problem.revDiscardDetail") : null}
            </Notice>
          ) : null}
          {mode === null ? (
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setMode({ kind: draft.kind, editing: true })}>
                {t("panel.editDraft")}
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={discard.pendingId !== null} onClick={() => void discard.run(draft)}>
                {t("panel.discardDraft")}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {isEditable(view) && draft === null && mode === null ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">{t("panel.actionsTitle")}</p>
          <div role="group" aria-label={t("panel.actionsTitle")} className="flex flex-wrap gap-2">
            {kinds.map((kind) => (
              <Button
                key={kind}
                type="button"
                variant="outline"
                size="sm"
                disabled={kind === "TEMPLATE_SPLIT" && !canSplit(spot)}
                onClick={() => setMode({ kind, editing: false })}
              >
                {t(`panel.action.${kind}`)}
              </Button>
            ))}
          </div>
          {lesson.layer === "template" && !canSplit(spot) ? <p className="text-sm text-muted-foreground">{t("panel.cannotSplit")}</p> : null}
        </div>
      ) : null}

      {mode !== null && !editingGone ? (
        <ChangeFormView
          // A new form for each kind, and for each draft: the form's state is its own.
          key={`${mode.kind}-${mode.editing ? draft?.id : "new"}`}
          classId={classId}
          week={week}
          lesson={lesson}
          kind={mode.kind}
          draft={mode.editing ? draft : null}
          fetching={fetching}
          onDone={finished}
          onCancel={finished}
          onReload={onReload}
          onOpenExisting={(id) => {
            const existing = draftOf(week, id);
            if (existing) setMode({ kind: existing.kind, editing: true });
          }}
        />
      ) : null}
    </section>
  );
}
