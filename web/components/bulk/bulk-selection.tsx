"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { Pencil, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { HeaderState } from "@/lib/bulk-selection";
import { cn } from "@/lib/utils";

/*
 * Massval's controls, the same on Klasser and Personer: a box in the table
 * header that ticks every row shown, a box on each row, and the bar that
 * counts them and acts on them. Drawn on the page's first load, so they are
 * kept to native checkboxes and three buttons; the dialogs the bar opens are
 * fetched on the first click (components/bulk/bulk-dialogs.tsx).
 */

/** The most rows one action takes: the gateway's BULK_MAX (src/common/bulk.ts). */
export const BULK_MAX = 500;

/** What the list holds, for the words the bar and the dialogs use. */
export type BulkEntity = "groups" | "students";

const BOX = "size-4 align-middle accent-primary";

/** The header's box: ticks every row shown, or unticks them; "some" draws it half ticked. */
export function SelectAllCheckbox({
  state,
  shown,
  entity,
  onToggle,
}: {
  state: HeaderState;
  /** How many rows are shown: what "alla" means, said in the box's name. */
  shown: number;
  entity: BulkEntity;
  onToggle: () => void;
}) {
  const t = useTranslations("bulk");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className={BOX}
      aria-label={t("selectAll", { entity, count: shown })}
      checked={state === "all"}
      disabled={shown === 0}
      onChange={onToggle}
    />
  );
}

/**
 * A row's box. Shift-click ticks every row between it and the row clicked
 * before, as in a mail list; Space on the box, with Shift held, does the same.
 */
export function SelectRowCheckbox({
  name,
  checked,
  onToggle,
}: {
  name: string;
  checked: boolean;
  onToggle: (extend: boolean) => void;
}) {
  const t = useTranslations("bulk");
  return (
    <input
      type="checkbox"
      className={BOX}
      aria-label={t("selectRow", { name })}
      checked={checked}
      // The click carries Shift; the change event does not. React wants an
      // onChange beside `checked`, and the click is the one that toggles.
      onChange={() => undefined}
      onClick={(event) => onToggle(event.shiftKey)}
    />
  );
}

export interface BulkSelectionBarProps {
  entity: BulkEntity;
  /** Ticked rows. */
  count: number;
  /** Rows shown. */
  shown: number;
  onClear: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** The area the bar's writes are (data-writes): hidden from a profile that does not write it. */
  writes: string;
}

/**
 * The bar under the list while anything is ticked: how many of how many
 * shown, Avmarkera, Redigera and Ta bort. Held at the bottom of the screen on
 * a long list, as the attendance roster holds its save, so a pupil ticked
 * three hundred rows down is acted on without scrolling back.
 *
 * The count is a live region mounted with the page, not with the bar: a
 * region mounted together with its text is often not read out.
 */
export function BulkSelectionBar({ entity, count, shown, onClear, onEdit, onDelete, writes }: BulkSelectionBarProps) {
  const t = useTranslations("bulk");
  const tooMany = count > BULK_MAX;
  return (
    <div
      data-writes={writes}
      className={cn(
        count > 0
          ? "sticky bottom-4 z-10 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border bg-card px-4 py-2.5 shadow-md"
          : "sr-only",
      )}
    >
      <p role="status" className="text-sm font-medium">
        {count > 0 ? t("selected", { entity, count, shown }) : ""}
      </p>
      {count > 0 ? (
        <>
          {tooMany ? (
            <p className="text-sm text-muted-foreground">{t("tooMany", { max: BULK_MAX })}</p>
          ) : (
            <p className="hidden text-xs text-muted-foreground lg:block">{t("shiftHint")}</p>
          )}
          <div className="ms-auto flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" onClick={onClear}>
              <X aria-hidden="true" />
              {t("clear")}
            </Button>
            <Button size="sm" variant="outline" onClick={onEdit} disabled={tooMany}>
              <Pencil aria-hidden="true" />
              {t("edit")}
            </Button>
            <Button size="sm" variant="destructive" onClick={onDelete} disabled={tooMany}>
              <Trash2 aria-hidden="true" />
              {t("delete")}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
