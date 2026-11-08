"use client";

import { useState } from "react";
import { ListChecks } from "lucide-react";
import { useChecklistGroups, useTemplates } from "@/lib/checklists-queries";
import { activeTemplates, groupLabel, templateLabel, type GroupChoice } from "@/lib/checklists";
import { useReadOnly } from "@/components/profile-context";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form-field";
import { LoadError } from "@/components/ui/load-error";
import { NativeSelect } from "@/components/ui/native-select";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import type { ChecklistAudience } from "./checklists";
import { RosterSection } from "./roster-section";
import { useChecklistsText } from "./use-checklists-text";

/**
 * Bocka av: choose a template and a group, and tick the pupils who have had the
 * instruction. The groups are the reader's: a teacher's own lessons' groups,
 * which they can tick in, and the classes they mentor, which they can only look
 * at; an administrator's are all.
 *
 * Nothing about pupils is read until both are chosen (the gateway records each
 * roster in the läslogg), and the roster is the section below, drawn afresh for
 * each choice.
 */
export function TickPanel({ audience }: { audience: ChecklistAudience }) {
  const { t, tCommon } = useChecklistsText();
  const readOnly = useReadOnly();
  const templates = useTemplates(audience === "admin");
  const groups = useChecklistGroups();
  const [chosenTemplate, setTemplateId] = useState("");
  const [chosenGroup, setGroupId] = useState("");

  const body = () => {
    if (templates.isLoading || groups.isLoading) {
      return (
        <div aria-busy="true">
          <Skeleton className="h-24 w-full" />
        </div>
      );
    }
    if (templates.isError || groups.isError || !templates.data || !groups.data) {
      return (
        <LoadError
          variant="inline"
          title={t("tick.loadFailed")}
          hint={t("tick.loadFailedHint")}
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void templates.refetch();
                void groups.refetch();
              }}
            >
              {tCommon("retry")}
            </Button>
          }
        />
      );
    }
    const active = activeTemplates(templates.data);
    if (active.length === 0) {
      return (
        <EmptyState
          icon={ListChecks}
          headingLevel={3}
          title={t("tick.noTemplatesTitle")}
          description={t(`tick.noTemplates.${audience}`)}
        />
      );
    }
    if (groups.data.length === 0) {
      return <EmptyState icon={ListChecks} headingLevel={3} title={t("tick.noGroupsTitle")} description={t(`tick.noGroups.${audience}`)} />;
    }
    // A choice the lists no longer hold (a template retired in another tab, a group the year left) is no choice.
    const templateId = active.some((template) => template.id === chosenTemplate) ? chosenTemplate : "";
    const groupId = groups.data.some((group) => group.id === chosenGroup) ? chosenGroup : "";
    const tickable = groups.data.filter((group) => group.canTick);
    const lookOnly = groups.data.filter((group) => !group.canTick);
    const option = (group: GroupChoice) => (
      <option key={group.id} value={group.id}>
        {groupLabel(group)}
      </option>
    );
    return (
      <>
        <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
          <FormField id="tick-template" label={t("tick.templateLabel")}>
            <NativeSelect value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
              <option value="">{t("tick.chooseTemplate")}</option>
              {active.map((template) => (
                <option key={template.id} value={template.id}>
                  {templateLabel(template)}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField id="tick-group" label={t("tick.groupLabel")} hint={lookOnly.length > 0 ? t("tick.groupHint") : undefined}>
            <NativeSelect value={groupId} onChange={(event) => setGroupId(event.target.value)}>
              <option value="">{t("tick.chooseGroup")}</option>
              {lookOnly.length === 0 ? (
                tickable.map(option)
              ) : (
                <>
                  <optgroup label={t("tick.yourGroups")}>{tickable.map(option)}</optgroup>
                  <optgroup label={t("tick.lookOnly")}>{lookOnly.map(option)}</optgroup>
                </>
              )}
            </NativeSelect>
          </FormField>
        </div>
        {templateId && groupId ? (
          <RosterSection key={`${templateId}:${groupId}`} templateId={templateId} groupId={groupId} readOnly={readOnly} />
        ) : (
          <p className="text-sm text-muted-foreground">{t("tick.choose")}</p>
        )}
      </>
    );
  };

  return (
    <SectionCard id="checklists-tick" title={t("tick.title")} description={t(`tick.description.${audience}`)}>
      {body()}
    </SectionCard>
  );
}
