"use client";

import { useState } from "react";
import { Archive, ArchiveRestore, ClipboardCheck, Pencil, Plus } from "lucide-react";
import { toast } from "sonner";
import { useChecklistActions, useTemplates } from "@/lib/checklists-queries";
import type { TemplateView } from "@/lib/checklists";
import { CHECKLIST_STATE_VARIANT } from "@/lib/status-variants";
import { useReadOnly } from "@/components/profile-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { RowActions } from "@/components/ui/row-actions";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { TemplateFormBody } from "./template-form";
import { useChecklistsText } from "./use-checklists-text";

/**
 * Mallar (the administrator's): the school's moments, each with the subject it
 * belongs to, made, changed, retired and brought back.
 *
 * There is no delete: a template that has proofs keeps them, and a proof is a
 * record the school may need after the pupil has left. A retired template stays
 * in this list, marked, and can no longer be ticked in; bringing it back makes
 * it tickable again, with every proof it had.
 */
export function TemplatesCard() {
  const { t, tCommon, refusal } = useChecklistsText();
  const readOnly = useReadOnly();
  const query = useTemplates(true);
  const { updateTemplate } = useChecklistActions();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const setActive = async (template: TemplateView, active: boolean) => {
    setProblem(null);
    try {
      await updateTemplate.mutateAsync({ id: template.id, patch: { active } });
      toast.success(t(active ? "templates.restored" : "templates.retired", { title: template.title }));
    } catch (error) {
      setProblem(refusal(error));
    }
  };

  const templates = query.data ?? [];

  const body = () => {
    if (query.isLoading) {
      return (
        <div aria-busy="true">
          <Skeleton className="h-24 w-full" />
        </div>
      );
    }
    if (query.isError || !query.data) {
      return (
        <LoadError
          variant="inline"
          title={t("templates.loadFailed")}
          hint={t("templates.loadFailedHint")}
          action={
            <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>
              {tCommon("retry")}
            </Button>
          }
        />
      );
    }
    if (templates.length === 0) {
      return editing === "new" ? null : (
        <EmptyState icon={ClipboardCheck} headingLevel={3} title={t("templates.emptyTitle")} description={t("templates.empty")} />
      );
    }
    return (
      <ul className="divide-y rounded-md border">
        {templates.map((template) =>
          editing === template.id ? (
            <li key={template.id} className="p-3">
              <TemplateFormBody template={template} onDone={() => setEditing(null)} onCancel={() => setEditing(null)} />
            </li>
          ) : (
            <li key={template.id} className="flex flex-wrap items-start justify-between gap-3 px-3 py-2.5 text-sm">
              <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{template.title}</span>
                  <span className="text-muted-foreground">{template.subjectName ?? t("templates.noSubject")}</span>
                  {template.active ? null : <Badge variant={CHECKLIST_STATE_VARIANT.TEMPLATE_RETIRED}>{t("templates.retiredBadge")}</Badge>}
                </div>
                {template.description ? <p className="whitespace-pre-wrap text-muted-foreground">{template.description}</p> : null}
              </div>
              {readOnly ? null : (
                <div data-writes="DRIFT">
                  <RowActions
                    name={template.title}
                    actions={[
                      { key: "edit", label: tCommon("edit"), icon: Pencil, onSelect: () => setEditing(template.id) },
                      template.active
                        ? { key: "retire", label: t("templates.retire"), icon: Archive, onSelect: () => void setActive(template, false) }
                        : { key: "restore", label: t("templates.restore"), icon: ArchiveRestore, onSelect: () => void setActive(template, true) },
                    ]}
                  />
                </div>
              )}
            </li>
          ),
        )}
      </ul>
    );
  };

  return (
    <SectionCard
      id="checklists-templates"
      title={t("templates.title")}
      description={t("templates.description")}
      action={
        readOnly || editing === "new" ? undefined : (
          <Button type="button" size="sm" variant="outline" onClick={() => setEditing("new")} data-writes="DRIFT">
            <Plus aria-hidden="true" />
            {t("templates.new")}
          </Button>
        )
      }
    >
      {problem ? (
        <Notice tone="destructive" title={t("templates.failed")}>
          {problem}
        </Notice>
      ) : null}
      {editing === "new" ? <TemplateFormBody template={null} onDone={() => setEditing(null)} onCancel={() => setEditing(null)} /> : null}
      {body()}
    </SectionCard>
  );
}
