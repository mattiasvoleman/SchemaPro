"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Notice } from "@/components/ui/notice";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { BulkEntity } from "@/components/bulk/bulk-selection";
import { ApiError } from "@/lib/api";
import type { BulkDeleteBody, BulkRefusal, BulkResult, BulkUpdateBody } from "@/lib/bulk-api";

/*
 * Massåtgärder's two dialogs, the same on Klasser and Personer; each list
 * hands them its own calls, names, fields and consequences
 * (admin/groups/groups-bulk-dialogs.tsx, admin/people/students-bulk-dialogs.tsx).
 * Fetched on the first click of Redigera or Ta bort.
 *
 * THE REST GOES, BY DECISION. A gateway call is all or nothing
 * (src/common/bulk.ts). Ta bort asks first with a dry run and shows what goes,
 * what goes with it, and what would not go and why; its button then deletes
 * the rows that would, by name and count. Redigera saves at once, and when a
 * row refuses, nothing is saved and the dialog lists why, with a button for
 * the others. Either way the rows acted on are the ones the dialog showed.
 */

/**
 * The codes whose reason the reader's language gives; any other shows the
 * gateway's sentence. The bulk routes give Prisma's generic answers a code of
 * their own (BULK_ROW_*), so no English sentence for a log reaches the list.
 */
const KNOWN_REFUSALS = [
  "BULK_ROW_NOT_FOUND",
  "BULK_ROW_TAKEN",
  "BULK_ROW_REFERENCE_GONE",
  "NOT_A_STUDENT",
  "REPLACING_GROUP_NOT_A_TEACHING_GROUP",
  "USER_IS_PSEUDONYMISED",
  "USER_HAS_BOOKED_PASS_COVERS",
  "STUDENT_HOME_GROUP_NOT_A_CLASS",
] as const;

const known = (code: string | null | undefined): code is (typeof KNOWN_REFUSALS)[number] =>
  code != null && (KNOWN_REFUSALS as readonly string[]).includes(code);

/** A failed call's sentence: the reader's language for a known code, the gateway's otherwise. */
const errorText = (error: unknown, fallback: string, t: (key: string) => string) =>
  error instanceof ApiError && known(error.code)
    ? t(`refusal.${error.code}`)
    : error instanceof Error
      ? error.message
      : fallback;

/** Each refused row by name, and why. */
export function RefusalList({ refused, nameOf }: { refused: BulkRefusal[]; nameOf: (id: string) => string }) {
  const t = useTranslations("bulk");
  return (
    <ul className="mt-1 space-y-1">
      {refused.map((refusal) => (
        <li key={refusal.id}>
          <span className="font-medium">{nameOf(refusal.id)}</span>
          {": "}
          {known(refusal.code) ? t(`refusal.${refusal.code}`, refusal.params ?? {}) : refusal.message}
        </li>
      ))}
    </ul>
  );
}

/** The rows a dialog acts on, by name: a scrolling list a keyboard can reach. */
function NameList({ ids, nameOf, label }: { ids: string[]; nameOf: (id: string) => string; label: string }) {
  return (
    <ul
      // Scrolls when long; focusable so the keyboard can scroll it too.
      tabIndex={0}
      aria-label={label}
      className="mt-1 max-h-40 divide-y overflow-y-auto rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {ids.map((id) => (
        <li key={id} className="px-3 py-1.5">
          {nameOf(id)}
        </li>
      ))}
    </ul>
  );
}

/**
 * What a list says goes with its rows: removed with them, left without them,
 * and anything else to know. `exhaustive` when every row that hangs on them
 * is counted: only then may the dialog say that nothing else does.
 */
export interface DeleteLines {
  goes: string[];
  loses: string[];
  notes: string[];
  exhaustive: boolean;
}

export interface BulkDeleteDialogProps<Consequences> {
  entity: BulkEntity;
  /** The ticked rows. */
  ids: string[];
  nameOf: (id: string) => string;
  remove: (body: BulkDeleteBody) => Promise<BulkResult<Consequences>>;
  describe: (consequences: Consequences) => DeleteLines;
  onClose: () => void;
  onDeleted: (count: number) => void;
}

/**
 * Ta bort for many rows: a dry run when it opens, then what goes, what goes
 * with it and what would not go, and a button that deletes exactly the rows
 * it named. When the real call meets a refusal the dry run did not (somebody
 * changed a row meanwhile), nothing is deleted and the dialog asks again.
 */
export function BulkDeleteDialog<Consequences>({
  entity,
  ids,
  nameOf,
  remove,
  describe,
  onClose,
  onDeleted,
}: BulkDeleteDialogProps<Consequences>) {
  const t = useTranslations("bulk");
  const tCommon = useTranslations("common");
  const [report, setReport] = useState<BulkResult<Consequences> | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const [busy, setBusy] = useState<"checking" | "deleting" | null>("checking");

  const check = async () => {
    setBusy("checking");
    setFailed(null);
    try {
      setReport(await remove({ ids, dryRun: true }));
    } catch (error) {
      // No list beside a failed check: a button under an old one would
      // delete what the reader can no longer see is still so.
      setReport(null);
      setFailed(errorText(error, tCommon("error"), t));
    } finally {
      setBusy(null);
    }
  };

  // Once, as the dialog opens: the selection is fixed while it is open.
  useEffect(() => {
    void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Deletes the rows the check named, with its counts: the gateway counts
   * again and deletes nothing when a kind grew (consequencesGrew), answering
   * the new counts, which the dialog shows to be confirmed again. A refusal
   * found only now (a row changed meanwhile) is asked afresh with a dry run.
   */
  const confirm = async () => {
    if (!report) return;
    setBusy("deleting");
    setFailed(null);
    let result: BulkResult<Consequences>;
    try {
      result = await remove({ ids: report.done, dryRun: false, expected: report.consequences as object | undefined });
    } catch (error) {
      setFailed(errorText(error, tCommon("error"), t));
      setBusy(null);
      return;
    }
    if (result.applied) {
      setBusy(null);
      onDeleted(result.done.length);
      return;
    }
    setChanged(true);
    if (result.consequencesGrew && result.consequences) {
      setReport(result);
      setBusy(null);
      return;
    }
    await check();
  };

  const lines = report?.consequences
    ? describe(report.consequences)
    : { goes: [], loses: [], notes: [], exhaustive: false };
  const going = report?.done.length ?? 0;

  return (
    <Dialog open onOpenChange={(open) => !open && busy !== "deleting" && onClose()}>
      <DialogContent
        className="max-w-lg"
        closeDisabled={busy === "deleting"}
        onEscapeKeyDown={(event) => {
          if (busy === "deleting") event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (busy === "deleting") event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("deleteTitle", { entity, count: ids.length })}</DialogTitle>
          <DialogDescription>{t("deleteIntro")}</DialogDescription>
        </DialogHeader>

        {busy === "checking" ? (
          <div aria-busy="true" className="space-y-2">
            <p className="text-sm text-muted-foreground">{t("deleteChecking")}</p>
            <Skeleton className="h-24 w-full" />
          </div>
        ) : null}

        {failed ? (
          <Notice
            tone="destructive"
            title={report ? undefined : t("deleteCheckFailed")}
            action={
              report ? undefined : (
                <Button variant="outline" size="sm" onClick={() => void check()}>
                  {tCommon("retry")}
                </Button>
              )
            }
          >
            {failed}
          </Notice>
        ) : null}

        {report && busy !== "checking" ? (
          <div className="space-y-3 text-sm">
            {changed ? <Notice tone="warning">{t("changedMeanwhile")}</Notice> : null}
            {going > 0 ? (
              <section aria-labelledby="bulk-delete-goes" className="space-y-1">
                <h3 id="bulk-delete-goes" className="font-medium">
                  {t("goesTitle", { entity, count: going })}
                </h3>
                <NameList ids={report.done} nameOf={nameOf} label={t("goesTitle", { entity, count: going })} />
              </section>
            ) : null}
            {going > 0 ? (
              lines.goes.length > 0 || lines.loses.length > 0 || !lines.exhaustive ? (
                <>
                  {lines.goes.length > 0 ? (
                    <section aria-labelledby="bulk-delete-with" className="space-y-1">
                      <h3 id="bulk-delete-with" className="font-medium">
                        {t("withThem")}
                      </h3>
                      <ul className="list-disc space-y-0.5 ps-5">
                        {lines.goes.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                  {lines.loses.length > 0 ? (
                    <section aria-labelledby="bulk-delete-loses" className="space-y-1">
                      <h3 id="bulk-delete-loses" className="font-medium">
                        {t("losesTitle")}
                      </h3>
                      <ul className="list-disc space-y-0.5 ps-5">
                        {lines.loses.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    </section>
                  ) : null}
                </>
              ) : (
                <p>{t("nothingElse")}</p>
              )
            ) : null}
            {going > 0 ? lines.notes.map((note) => <p key={note} className="text-muted-foreground">{note}</p>) : null}
            {report.refused.length > 0 ? (
              <Notice tone="warning" title={t("refusedDelete", { count: report.refused.length })}>
                <RefusalList refused={report.refused} nameOf={nameOf} />
              </Notice>
            ) : null}
            {going > 0 ? (
              <p className="font-medium">{tCommon("deleteConfirmBody")}</p>
            ) : (
              <p>{t("nothingToDelete")}</p>
            )}
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy === "deleting"}>
            {going > 0 ? tCommon("cancel") : tCommon("close")}
          </Button>
          {report && going > 0 ? (
            <Button variant="destructive" onClick={() => void confirm()} disabled={busy !== null}>
              {report.refused.length > 0 ? t("deleteOthers", { count: going }) : t("deleteCount", { count: going })}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "Olika värden": the value the select shows while the ticked rows differ and nothing is chosen. */
export const KEEP = "__keep__";

export interface BulkSelectFieldProps {
  id: string;
  label: string;
  hint?: string;
  options: { value: string; label: string }[];
  /** The value every ticked row holds, or null when they differ. */
  shared: string | null;
  /** The value chosen, or null to leave each row as it is. */
  value: string | null;
  onChange: (value: string | null) => void;
  /** Ticked rows, for "Sätts på alla 12". */
  count: number;
}

/**
 * One field of Redigera. Rows that differ show "Olika värden", and the field
 * is left as each row has it until a value is chosen; choosing "Olika värden"
 * again, or the value every row already has, leaves it again. Below it, what
 * a save does with the field.
 */
export function BulkSelectField({ id, label, hint, options, shared, value, onChange, count }: BulkSelectFieldProps) {
  const t = useTranslations("bulk");
  const status = value !== null ? t("fieldSets", { count }) : shared === null ? t("fieldMixed") : t("fieldSame");
  return (
    <FormField id={id} label={label} hint={hint ? `${hint} ${status}` : status}>
      {(control) => (
        <Select
          value={value ?? shared ?? KEEP}
          onValueChange={(next) => onChange(next === KEEP || next === shared ? null : next)}
        >
          <SelectTrigger {...control}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {shared === null ? <SelectItem value={KEEP}>{t("mixed")}</SelectItem> : null}
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </FormField>
  );
}

export interface BulkEditDialogProps<Changes> {
  entity: BulkEntity;
  ids: string[];
  nameOf: (id: string) => string;
  update: (body: BulkUpdateBody<Changes>) => Promise<BulkResult<never>>;
  /** What the fields would set, or null while none is chosen. */
  changes: Changes | null;
  /** The fields: BulkSelectField, one per field the list offers. */
  children: ReactNode;
  onClose: () => void;
  onSaved: (count: number) => void;
}

/**
 * Redigera for many rows: the list's fields, a save over every ticked row,
 * and when a row refuses the change, nothing saved, each refusal by name, and
 * a button that saves the others.
 */
export function BulkEditDialog<Changes>({
  entity,
  ids,
  nameOf,
  update,
  changes,
  children,
  onClose,
  onSaved,
}: BulkEditDialogProps<Changes>) {
  const t = useTranslations("bulk");
  const tCommon = useTranslations("common");
  const [refusal, setRefusal] = useState<BulkResult<never> | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const changesKey = JSON.stringify(changes);

  // A refusal is about the change it was asked; another change is asked afresh.
  useEffect(() => {
    setRefusal(null);
    setFailed(null);
  }, [changesKey]);

  const save = async (targets: string[]) => {
    if (changes === null) return;
    setSaving(true);
    setFailed(null);
    try {
      const result = await update({ ids: targets, changes, dryRun: false });
      if (result.applied) {
        onSaved(result.done.length);
        return;
      }
      setRefusal(result);
    } catch (error) {
      setFailed(errorText(error, tCommon("error"), t));
    } finally {
      setSaving(false);
    }
  };

  const others = refusal?.done ?? [];

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent
        className="max-w-lg"
        closeDisabled={saving}
        onEscapeKeyDown={(event) => {
          if (saving) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (saving) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("editTitle", { entity, count: ids.length })}</DialogTitle>
          <DialogDescription>{t("editIntro")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">{children}</div>
        {failed ? <Notice tone="destructive">{failed}</Notice> : null}
        {refusal ? (
          <Notice tone="warning" title={t("refusedEdit", { count: refusal.refused.length })}>
            <RefusalList refused={refusal.refused} nameOf={nameOf} />
            <p className="mt-2">{others.length > 0 ? t("nothingSavedOthers", { count: others.length }) : t("nothingSaved")}</p>
          </Notice>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            {tCommon("cancel")}
          </Button>
          {refusal ? (
            others.length > 0 ? (
              <Button onClick={() => void save(others)} disabled={saving}>
                {t("saveOthers", { count: others.length })}
              </Button>
            ) : null
          ) : (
            <Button onClick={() => void save(ids)} disabled={saving || changes === null}>
              {t("saveCount", { count: ids.length })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
