"use client";

import { useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { useClassTeacherAdminActions, useDrafts } from "@/lib/class-teacher-queries";
import { problemOf, type DraftRowView, type PublishOutcome } from "@/lib/class-teacher";
import { useRooms } from "@/lib/queries";
import { useClassTeacherText } from "@/components/class-teacher/use-class-teacher-text";
import { VerdictView } from "@/components/class-teacher/verdict-view";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { useAreaGate } from "./use-area-gate";

/** What publication said of a class's drafts, with each draft said in words as it stood. */
interface Published {
  classId: string;
  items: Array<{ id: string; label: string; outcome: PublishOutcome }>;
}

/**
 * The waiting drafts of every class, for the schemaläggare to review: who
 * wrote each, which lesson it is about, what it asks for, and the verdict the
 * check gives it now (the same check publication makes). A class's drafts are
 * published together, through the services the editor itself uses, and the
 * outcome is told draft by draft; a draft can also be thrown away.
 *
 * Publishing takes Schemaläggning, Drift and Publicering together (it writes
 * the timetable, the calendar and the publication), discarding a draft takes
 * Publicering; a profile without them sees the drafts and the verdicts and is
 * told why the buttons are not there.
 */
export function DraftsCard() {
  const t = useTranslations("classTeacherAdmin");
  const tCommon = useTranslations("common");
  const { t: tShared, summary, verdict, outcome } = useClassTeacherText();
  const gate = useAreaGate();
  const mayDiscard = gate.may("PUBLICERING");
  const mayPublish = gate.may("SCHEMALAGGNING", "DRIFT", "PUBLICERING");
  const drafts = useDrafts();
  const rooms = useRooms();
  const { discardDraft, publishClass } = useClassTeacherAdminActions();
  const [published, setPublished] = useState<Published | null>(null);
  const [discarding, setDiscarding] = useState<{ row: DraftRowView; label: string } | null>(null);

  const roomName = (id: string | null) => (id ? (rooms.data?.find((room) => room.id === id)?.name ?? null) : null);
  const ctx = { roomName };
  const labelOf = (row: DraftRowView) => summary(row.change, row.subjectName, ctx);
  const rows = drafts.data ?? [];
  const classes = [...new Set(rows.map((row) => row.change.studentGroupId))].map((id) => ({
    id,
    name: rows.find((row) => row.change.studentGroupId === id)?.className ?? "",
    rows: rows.filter((row) => row.change.studentGroupId === id),
  }));

  const fail = (error: unknown) => {
    const problem = problemOf(error);
    toast.error(problem.kind === "areaNotYours" ? problem.message : error instanceof Error ? error.message : tCommon("error"));
  };

  const publish = async (cls: (typeof classes)[number]) => {
    if (publishClass.isPending) return;
    setPublished(null);
    const labels = new Map(cls.rows.map((row) => [row.change.id, labelOf(row)]));
    try {
      const { outcomes } = await publishClass.mutateAsync({ classId: cls.id });
      setPublished({ classId: cls.id, items: outcomes.map((one) => ({ id: one.id, label: labels.get(one.id) ?? tShared("summary.lesson"), outcome: one })) });
    } catch (error) {
      fail(error);
    }
  };

  const discard = async () => {
    if (!discarding || discardDraft.isPending) return;
    try {
      await discardDraft.mutateAsync(discarding.row.change.id);
      toast.success(t("drafts.discarded"));
    } catch (error) {
      fail(error);
    }
    setDiscarding(null);
  };

  return (
    <SectionCard id="class-teacher-drafts" title={t("drafts.title")} description={t("drafts.description")}>
      {drafts.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-32 w-full" />
        </div>
      ) : drafts.isError || !drafts.data ? (
        <LoadError variant="inline" title={t("drafts.loadFailed")} hint={t("loadFailedHint")} />
      ) : classes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("drafts.empty")}</p>
      ) : (
        <div className="space-y-5">
          {classes.map((cls) => (
            <section key={cls.id} aria-labelledby={`class-teacher-drafts-${cls.id}`} className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 id={`class-teacher-drafts-${cls.id}`} className="text-sm font-semibold">
                  {t("drafts.classHeading", { name: cls.name, count: cls.rows.length })}
                </h3>
                <Button
                  type="button"
                  size="sm"
                  data-writes="SCHEMALAGGNING DRIFT PUBLICERING"
                  disabled={!mayPublish || publishClass.isPending}
                  aria-label={t("drafts.publishClassNamed", { name: cls.name })}
                  onClick={() => void publish(cls)}
                >
                  {publishClass.isPending && publishClass.variables?.classId === cls.id ? t("drafts.publishing") : t("drafts.publishClass")}
                </Button>
              </div>

              {published && published.classId === cls.id ? (
                <Notice tone="neutral" title={tShared("outcome.title")} onDismiss={() => setPublished(null)}>
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

              <ul className="space-y-2">
                {cls.rows.map((row) => {
                  const label = labelOf(row);
                  return (
                    <li key={row.change.id} className="space-y-2 rounded-md border p-3">
                      <p className="text-sm font-medium">{label}</p>
                      <p className="text-xs text-muted-foreground">
                        {row.authorName ? t("drafts.by", { name: row.authorName }) : t("drafts.byUnknown")}
                      </p>
                      {row.change.note ? <p className="text-sm text-muted-foreground">{tShared("drafts.note", { note: row.change.note })}</p> : null}
                      <VerdictView verdict={verdict(row.verdict, ctx)} />
                      <div className="flex justify-end">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          data-writes="PUBLICERING"
                          disabled={!mayDiscard}
                          aria-label={t("drafts.discardNamed", { label })}
                          onClick={() => setDiscarding({ row, label })}
                        >
                          {t("drafts.discard")}
                        </Button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      )}
      {!mayPublish && rows.length > 0 ? <p className="text-sm">{gate.why("SCHEMALAGGNING", "DRIFT", "PUBLICERING")}</p> : null}

      <ConfirmDialog
        open={discarding !== null}
        onOpenChange={(open) => {
          if (!open) setDiscarding(null);
        }}
        title={t("drafts.discardTitle")}
        description={discarding ? t("drafts.discardBody", { label: discarding.label }) : undefined}
        confirmLabel={t("drafts.discard")}
        loading={discardDraft.isPending}
        onConfirm={() => void discard()}
      />
    </SectionCard>
  );
}
