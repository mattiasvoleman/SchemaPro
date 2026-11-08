"use client";

import { useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { useClassTeacherActions } from "@/lib/class-teacher-queries";
import {
  isPublishable,
  lessonOfDraft,
  problemOf,
  type ChangeProblem,
  type ChangeView,
  type CheckRow,
  type PublishOutcome,
  type WeekView,
} from "@/lib/class-teacher";
import { useProfile } from "@/components/profile-context";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { useClassTeacherText } from "./use-class-teacher-text";
import { useDiscardDraft } from "./use-discard-draft";
import { VerdictView } from "./verdict-view";

/** What publication said of each draft it was asked about, with the draft said in words as it stood. */
interface Published {
  items: Array<{ id: string; label: string; outcome: PublishOutcome }>;
}

/**
 * "Mina utkast": the class's waiting drafts, each judged as publication would
 * judge it (the gateway's check, read again every minute and when the window
 * is looked at again), with edit and discard, and, only when the school has
 * switched on that a klasslärare publishes for themselves, publish.
 *
 * The list is the CLASS's drafts, not only the reader's: another klasslärare
 * of the same class writes drafts too, and a draft of theirs is marked as
 * another's (the gateway names no author to a klasslärare).
 */
export function DraftsSection({
  classId,
  week,
  check,
  selfPublish,
  fetching,
  onReload,
  onOpen,
}: {
  classId: string;
  week: WeekView;
  check: UseQueryResult<CheckRow[]>;
  selfPublish: boolean;
  fetching: boolean;
  onReload: () => void;
  /** Opens the draft's lesson in the panel, with the draft in its form. */
  onOpen: (draft: ChangeView) => void;
}) {
  const { t, summary, verdict, outcome, problem: problemText } = useClassTeacherText();
  const { profile } = useProfile();
  const actions = useClassTeacherActions(classId);
  const discard = useDiscardDraft(classId);
  const [published, setPublished] = useState<Published | null>(null);
  const [publishProblem, setPublishProblem] = useState<ChangeProblem | null>(null);
  const roomName = (id: string | null) => (id ? (week.rooms.find((room) => room.id === id)?.name ?? null) : null);
  const ctx = { roomName };
  const drafts = week.drafts;
  const rowOf = (id: string) => check.data?.find((row) => row.change.id === id);
  const labelOf = (draft: ChangeView) => summary(draft, lessonOfDraft(week, draft)?.subjectName ?? null, ctx);

  const publish = async (ids?: string[]) => {
    if (actions.publish.isPending) return;
    setPublished(null);
    setPublishProblem(null);
    const labels = new Map(drafts.map((draft) => [draft.id, labelOf(draft)]));
    try {
      const { outcomes } = await actions.publish.mutateAsync(ids);
      setPublished({ items: outcomes.map((one) => ({ id: one.id, label: labels.get(one.id) ?? t("summary.lesson"), outcome: one })) });
    } catch (error) {
      setPublishProblem(problemOf(error));
    }
  };

  const anyPublishable = drafts.some((draft) => isPublishable(rowOf(draft.id)?.verdict));

  return (
    <SectionCard
      id="my-drafts"
      title={t("drafts.title")}
      description={selfPublish ? t("drafts.descriptionSelf") : t("drafts.description")}
      action={
        selfPublish && drafts.length > 0 ? (
          <Button type="button" size="sm" disabled={!anyPublishable || actions.publish.isPending} onClick={() => void publish()}>
            {actions.publish.isPending ? t("drafts.publishing") : t("drafts.publishAll")}
          </Button>
        ) : undefined
      }
    >
      {published ? (
        <Notice tone="neutral" title={t("outcome.title")} onDismiss={() => setPublished(null)}>
          <ul className="mt-1 space-y-2">
            {published.items.map((item) => (
              <li key={item.id} className="space-y-1">
                <p className="text-sm">{item.label}</p>
                <VerdictView verdict={outcome(item.outcome, ctx)} />
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      {publishProblem ? (
        <Notice tone="destructive" title={t("drafts.publishFailed")} onDismiss={() => setPublishProblem(null)}>
          {problemText(publishProblem).headline}
          {problemText(publishProblem).detail ? ` ${problemText(publishProblem).detail}` : ""}
        </Notice>
      ) : null}

      {drafts.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("drafts.empty")}</p>
      ) : (
        <ul className="space-y-3">
          {drafts.map((draft) => {
            const row = rowOf(draft.id);
            const label = labelOf(draft);
            const problem = discard.problems[draft.id];
            return (
              <li key={draft.id} className="space-y-2 rounded-md border p-3">
                <p className="text-sm font-medium">{label}</p>
                {draft.authorId !== profile.id ? <p className="text-xs text-muted-foreground">{t("drafts.byAnother")}</p> : null}
                {draft.note ? <p className="text-sm text-muted-foreground">{t("drafts.note", { note: draft.note })}</p> : null}
                {row ? (
                  <VerdictView verdict={verdict(row.verdict, ctx)} />
                ) : check.isError ? (
                  <p className="text-sm text-muted-foreground">{t("drafts.checkFailed")}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">{t("drafts.checking")}</p>
                )}
                {problem ? (
                  <Notice
                    tone="destructive"
                    title={problem.kind === "rev" ? t("problem.rev") : problem.kind === "gone" ? t("problem.gone") : t("problem.other")}
                    onDismiss={() => discard.clear(draft.id)}
                    action={
                      problem.kind === "rev" || problem.kind === "gone" ? (
                        <Button type="button" variant="outline" size="sm" onClick={onReload} disabled={fetching}>
                          {t("form.reload")}
                        </Button>
                      ) : undefined
                    }
                  >
                    {problem.kind === "rev" ? t("problem.revDiscardDetail") : null}
                  </Notice>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" aria-label={t("drafts.editNamed", { label })} onClick={() => onOpen(draft)}>
                    {t("drafts.edit")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={t("drafts.discardNamed", { label })}
                    disabled={discard.pendingId !== null}
                    onClick={() => void discard.run(draft)}
                  >
                    {t("drafts.discard")}
                  </Button>
                  {selfPublish ? (
                    <Button
                      type="button"
                      size="sm"
                      aria-label={t("drafts.publishNamed", { label })}
                      disabled={!isPublishable(row?.verdict) || actions.publish.isPending}
                      onClick={() => void publish([draft.id])}
                    >
                      {t("drafts.publish")}
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}
