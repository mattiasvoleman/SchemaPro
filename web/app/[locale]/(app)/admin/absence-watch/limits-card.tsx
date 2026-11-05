"use client";

import { Suspense, lazy, useState } from "react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";
import { Pencil, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { useAbsenceWatchActions } from "@/lib/absence-watch-queries";
import {
  ABSENCE_WATCH_BASES,
  ABSENCE_WATCH_GROUPS,
  ABSENCE_WATCH_KINDS,
  type AbsenceWatchLimit,
} from "@/lib/absence-watch";
import { useAbsenceWatchText } from "@/components/absence-watch/use-absence-watch-text";
import { useReadOnly } from "@/components/profile-context";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { RowActions } from "@/components/ui/row-actions";
import { SectionCard } from "@/components/ui/section-card";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard } from "@/components/ui/table-card";
import { DialogLoadBoundary } from "@/components/schedule/dialog-load-boundary";

/*
 * The form and the question before a removal are fetched on the first click,
 * not with the page: a click opens neither until somebody wants it, and Radix
 * Dialog is then in no chunk the page loads at first. A chunk that does not
 * arrive is said in a toast, and the next click fetches afresh (a lazy
 * component that failed once stays failed, so the next one is made anew).
 */
const lazyLimitDialog = () => lazy(() => import("./limit-dialog").then((module) => ({ default: module.LimitDialog })));
const lazyConfirmDialog = () =>
  lazy(() => import("@/components/ui/confirm-dialog").then((module) => ({ default: module.ConfirmDialog })));
let LimitDialog = lazyLimitDialog();
let ConfirmDialog = lazyConfirmDialog();

/** The limits in the order a reader looks for them: by group, then the kind, then the basis. */
function inOrder(limits: readonly AbsenceWatchLimit[]): AbsenceWatchLimit[] {
  const rank = (limit: AbsenceWatchLimit) =>
    ABSENCE_WATCH_GROUPS.indexOf(limit.recipientGroup) * 100 +
    ABSENCE_WATCH_KINDS.indexOf(limit.kind) * 10 +
    ABSENCE_WATCH_BASES.indexOf(limit.basis);
  return [...limits].sort((a, b) => rank(a) - rank(b));
}

/**
 * The school's limits: a table of what each mottagargrupp is told about, with
 * add, change and remove. A school has one limit per group, kind and basis, so
 * at most six per group. A change takes effect at the next night's count;
 * removing one closes the findings it made, which the dialog says first.
 */
export function LimitsCard({ limits }: { limits: readonly AbsenceWatchLimit[] }) {
  const { t, limitText } = useAbsenceWatchText();
  const tCommon = useTranslations("common");
  const readOnly = useReadOnly();
  const { deleteLimit } = useAbsenceWatchActions();
  // The form is mounted while it is open, so each opening starts from a clean one. Its limit is null to add one.
  const [form, setForm] = useState<{ limit: AbsenceWatchLimit | null } | null>(null);
  const [removing, setRemoving] = useState<AbsenceWatchLimit | null>(null);
  // Which attempt to fetch the dialogs this is: a new key remounts the boundary after a failure.
  const [attempt, setAttempt] = useState(0);

  const dialogsFailed = () => {
    toast.error(tCommon("confirmLoadFailed"));
    LimitDialog = lazyLimitDialog();
    ConfirmDialog = lazyConfirmDialog();
    setForm(null);
    setRemoving(null);
    setAttempt((count) => count + 1);
  };

  const remove = async () => {
    if (!removing) return;
    try {
      await deleteLimit.mutateAsync(removing.id);
      toast.success(t("limits.removed"));
      setRemoving(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const rows = inOrder(limits);

  return (
    <SectionCard
      id="absence-watch-limits"
      title={t("limits.title")}
      description={t("limits.description")}
      action={
        readOnly ? undefined : (
          <Button size="sm" variant="outline" onClick={() => setForm({ limit: null })} data-writes="DRIFT">
            <Plus aria-hidden="true" />
            {t("limits.add")}
          </Button>
        )
      }
    >
      {rows.length === 0 ? (
        <EmptyState
          icon={SlidersHorizontal}
          headingLevel={3}
          title={t("limits.emptyTitle")}
          description={t("limits.emptyBody")}
        />
      ) : (
        <TableCard caption={t("limits.caption")} tableClassName="min-w-[26rem]">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">{t("limits.group")}</TableHead>
              <TableHead scope="col">{t("limits.limit")}</TableHead>
              {readOnly ? null : (
                <TableHead scope="col" className="w-24 text-right" data-writes="DRIFT">
                  <span className="sr-only">{t("limits.actions")}</span>
                </TableHead>
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((limit) => {
              const text = limitText(limit);
              const name = `${t(`group.${limit.recipientGroup}`)}: ${text}`;
              return (
                <TableRow key={limit.id}>
                  <TableCell className="font-medium">{t(`group.${limit.recipientGroup}`)}</TableCell>
                  <TableCell>{text}</TableCell>
                  {readOnly ? null : (
                    <TableCell data-writes="DRIFT">
                      <RowActions
                        name={name}
                        actions={[
                          { key: "edit", label: tCommon("edit"), icon: Pencil, onSelect: () => setForm({ limit }) },
                          { key: "delete", label: tCommon("delete"), icon: Trash2, onSelect: () => setRemoving(limit) },
                        ]}
                      />
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </TableCard>
      )}

      {form || removing ? (
        <DialogLoadBoundary key={attempt} onError={dialogsFailed}>
          <Suspense fallback={null}>
            {form ? (
              <LimitDialog
                limit={form.limit}
                onClose={() => setForm(null)}
                onSaved={(message) => {
                  toast.success(message);
                  setForm(null);
                }}
              />
            ) : null}
            {removing ? (
              <ConfirmDialog
                open
                onOpenChange={(next) => {
                  if (!next && !deleteLimit.isPending) setRemoving(null);
                }}
                title={t("limits.removeTitle", { group: t(`group.${removing.recipientGroup}`) })}
                description={t("limits.removeBody", { limit: limitText(removing) })}
                confirmLabel={tCommon("delete")}
                loading={deleteLimit.isPending}
                onConfirm={() => void remove()}
              />
            ) : null}
          </Suspense>
        </DialogLoadBoundary>
      ) : null}
    </SectionCard>
  );
}
