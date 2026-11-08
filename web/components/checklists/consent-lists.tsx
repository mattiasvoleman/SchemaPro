"use client";

import { useState } from "react";
import { ClipboardCheck } from "lucide-react";
import { useChecklistGroups, useConsentLists } from "@/lib/checklists-queries";
import { classesOfGroups, type ConsentListItem } from "@/lib/checklists";
import { CHECKLIST_STATE_VARIANT } from "@/lib/status-variants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { FilterBar, FilterField } from "@/components/ui/filter-bar";
import { LoadError } from "@/components/ui/load-error";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import type { ChecklistAudience } from "./checklists";
import { ConsentCounts } from "./consent-counts";
import { useChecklistsText } from "./use-checklists-text";

/** The element that opens a list, so that going back to the lists can hand focus back to it. */
export const listOpenerId = (id: string) => `consent-list-open-${id}`;

/**
 * The consent lists the reader can see, newest first: a class's, with where each
 * stands in numbers and words. An ended list is left out unless asked for. Naming
 * no pupil, this read is not recorded; opening a list is.
 */
export function ConsentLists({ audience, onOpen }: { audience: ChecklistAudience; onOpen: (list: ConsentListItem) => void }) {
  const { t, tCommon, instantDay } = useChecklistsText();
  const groups = useChecklistGroups();
  const [classId, setClassId] = useState("");
  const [includeClosed, setIncludeClosed] = useState(false);
  const query = useConsentLists(classId, includeClosed);
  const classes = classesOfGroups(groups.data ?? []);
  const lists = query.data ?? [];
  const filtered = classId !== "" || includeClosed;

  const body = () => {
    if (query.isLoading) {
      return (
        <div aria-busy="true">
          <Skeleton className="h-32 w-full" />
        </div>
      );
    }
    if (query.isError || !query.data) {
      return (
        <LoadError
          variant="inline"
          title={t("lists.loadFailed")}
          hint={t("lists.loadFailedHint")}
          action={
            <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>
              {tCommon("retry")}
            </Button>
          }
        />
      );
    }
    if (lists.length === 0) {
      return filtered ? (
        <p className="rounded-md border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">{t("lists.noMatch")}</p>
      ) : (
        <EmptyState icon={ClipboardCheck} headingLevel={3} title={t("lists.emptyTitle")} description={t(`lists.empty.${audience}`)} />
      );
    }
    return (
      <ul className="divide-y rounded-md border">
        {lists.map((list) => (
          <li key={list.id} className="space-y-2 px-3 py-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <button
                id={listOpenerId(list.id)}
                type="button"
                className="rounded-sm text-left text-sm font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t("lists.open", { title: list.title, class: list.className })}
                onClick={() => onOpen(list)}
              >
                {list.title}
              </button>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted-foreground">{list.className}</span>
                {list.closedAt ? (
                  <Badge variant={CHECKLIST_STATE_VARIANT.LIST_CLOSED}>{t("lists.closedOn", { date: instantDay(list.closedAt) })}</Badge>
                ) : null}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {list.createdByName
                ? t("detail.madeBy", { date: instantDay(list.createdAt), name: list.createdByName })
                : t("detail.madeOn", { date: instantDay(list.createdAt) })}
            </p>
            <ConsentCounts counts={list.counts} />
          </li>
        ))}
      </ul>
    );
  };

  return (
    <>
      <FilterBar>
        <FilterField id="lists-class" label={t("lists.classFilter")}>
          <NativeSelect id="lists-class" className="w-44" value={classId} onChange={(event) => setClassId(event.target.value)}>
            <option value="">{t("lists.allClasses")}</option>
            {classes.map((one) => (
              <option key={one.id} value={one.id}>
                {one.name}
              </option>
            ))}
          </NativeSelect>
        </FilterField>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input
            type="checkbox"
            className="size-4 shrink-0 accent-primary"
            checked={includeClosed}
            onChange={(event) => setIncludeClosed(event.target.checked)}
          />
          {t("lists.includeClosed")}
        </label>
      </FilterBar>
      {body()}
    </>
  );
}
