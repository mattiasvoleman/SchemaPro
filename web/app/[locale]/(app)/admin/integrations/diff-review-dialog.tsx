"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, ShieldAlert } from "lucide-react";
import { Link } from "@/i18n/navigation";
import type { MessageLookup } from "@/lib/engine-message";
import { usePeople } from "@/lib/queries";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  endedGuardianLinks,
  isChosen,
  isSelectable,
  matchesFilter,
  personNames,
  readChange,
  selectionBody,
  summarise,
  withAll,
  type ChangeFilter,
} from "./diff-view";
import { CHECKBOX, NATIVE_SELECT } from "./form-styles";
import { codeText, errorCodeOf, errorText, formatWhen } from "./ss12000-messages";
import type { ChangeEntity, SyncChange, SyncRun } from "./ss12000-types";
import { useApplyRun, useDiscardRun, useRunChanges } from "./use-ss12000-sync";

/*
 * The dry run's diff, and the one place it is applied.
 *
 * Every change of the run is read (all pages) before anything can be
 * applied, so what the dialog counts is what the gateway would apply. The
 * gateway's defaults arrive ticked or unticked — a person with a protected
 * identity, an email change for somebody already invited, a relink to an
 * inactive row, a duty role that would give a TEACHER login, all unticked —
 * and the admin's choice is sent as the difference from them
 * (diff-view.ts). Conflicts and notes are named and never applied.
 *
 * The apply is one transaction at the gateway: either all of the chosen
 * changes are made or none. Its refusals are answered here: the school or
 * the register moved since the fetch (SS12000_DIFF_STALE: sync again), more
 * deactivations than max(5, 10 %) of the linked people (confirm them
 * explicitly), another apply in progress (SS12000_BUSY).
 *
 * A guardian the register no longer names for a child is never unlinked by a
 * sync. The dialog lists those children with a link to the people register's
 * guardian dialog, and the apply waits until the admin has said they saw it.
 *
 * A run that is no longer DIFF_READY is shown read-only. Its names and
 * addresses are gone (the database nulls them on every other status), so its
 * rows read by kind, operation and code.
 */

const ENTITIES: ChangeEntity[] = ["PERSON", "GROUP", "CLASS_MEMBERSHIP", "GROUP_MEMBERSHIP", "RESPONSIBLE", "DUTY_LINK", "ORGANISATION"];
const PAGE = 200;

export function DiffReviewDialog({ run, fullEveryDays, onClose }: { run: SyncRun; fullEveryDays: number; onClose: () => void }) {
  const t = useTranslations("integrations.review");
  const tSync = useTranslations("integrations.sync");
  const tErrors = useTranslations("integrations.errors") as unknown as MessageLookup;
  const tCodes = useTranslations("integrations.codes") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const [loaded, setLoaded] = useState(0);
  const changes = useRunChanges(run.id, setLoaded);
  const { data: people } = usePeople();
  const apply = useApplyRun(run.id);
  const discard = useDiscardRun(run.id);

  const [overrides, setOverrides] = useState<Map<string, boolean>>(() => new Map());
  const [filter, setFilter] = useState<ChangeFilter>({ entity: "ALL", attention: false });
  const [shown, setShown] = useState(PAGE);
  const [confirming, setConfirming] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [guardiansSeen, setGuardiansSeen] = useState(false);
  const [massLimit, setMassLimit] = useState<{ deactivations: number; limit: number } | null>(null);
  const [massConfirmed, setMassConfirmed] = useState(false);
  const [stale, setStale] = useState(false);

  const all = useMemo(() => changes.data?.changes ?? [], [changes.data]);
  const complete = changes.isSuccess;
  const truncated = changes.data?.truncated === true;
  const editable = run.status === "DIFF_READY";
  const names = useMemo(() => personNames(all), [all]);
  const peopleById = useMemo(() => new Map((people ?? []).map((person) => [person.id, `${person.firstName} ${person.lastName}`])), [people]);
  const localName = (id: string) => peopleById.get(id) ?? null;
  const summary = summarise(all, overrides, run.status);
  const visible = all.filter((change) => matchesFilter(change, filter));
  const guardianEnds = endedGuardianLinks(all);
  const minimised = !editable && all.length > 0 && all.every((change) => change.before === null && change.after === null);
  const canApply =
    editable && complete && !truncated && run.basisHash !== null && (guardianEnds.length === 0 || guardiansSeen) && !stale;

  const detailText = (change: SyncChange) => {
    const reading = readChange(change, names, localName);
    if (!reading.detail) return { subject: reading.subject, detail: null };
    const values = { ...reading.detail.values };
    if (values["role"] && t.has(`roles.${values["role"]}`)) values["role"] = t(`roles.${values["role"]}`);
    const key = `detail.${reading.detail.key}`;
    return { subject: reading.subject, detail: t.has(key) ? t(key, values) : null };
  };

  const closeConfirm = () => {
    setConfirming(false);
    setMassLimit(null);
  };

  const doApply = (confirmMassDeactivation: boolean) => {
    if (!run.basisHash) return;
    apply.mutate(
      { basisHash: run.basisHash, ...selectionBody(all, overrides, run.status), ...(confirmMassDeactivation ? { confirmMassDeactivation: true } : {}) },
      {
        onSuccess: (result) => {
          const counts = result.counts?.["applied"];
          toast.success(t("applied", { applied: counts?.["admin"] ?? summary.chosen, skipped: counts?.["skipped"] ?? 0 }));
          setConfirming(false);
          onClose();
        },
        onError: (error) => {
          const code = errorCodeOf(error);
          if (code === "SS12000_MASS_DEACTIVATION") {
            const params = (error as { params?: Record<string, string | number> }).params ?? {};
            setMassLimit({ deactivations: Number(params["deactivations"] ?? summary.deactivations), limit: Number(params["limit"] ?? 0) });
            setMassConfirmed(false);
            return;
          }
          if (code === "SS12000_DIFF_STALE") {
            setStale(true);
            setConfirming(false);
          }
          toast.error(errorText(tErrors, error, tCommon("error")));
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && !apply.isPending && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto" closeDisabled={apply.isPending}>
        <DialogHeader>
          <DialogTitle>{editable ? t("title") : t("titleReadOnly")}</DialogTitle>
          <DialogDescription>
            {t("subtitle", {
              when: formatWhen(locale, run.startedAt),
              trigger: tSync(`trigger.${run.trigger}`),
              mode: tSync(`mode.${run.mode}`),
              status: tSync(`status.${run.status}`),
            })}
          </DialogDescription>
        </DialogHeader>

        {changes.isError ? (
          <p role="alert" className="text-sm">
            {errorText(tErrors, changes.error, tCommon("error"))}
          </p>
        ) : !complete ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {t("loading", { count: loaded })}
          </p>
        ) : null}

        {complete ? (
          <div className="space-y-4">
            <p className="text-sm" role="status">
              {editable
                ? t("summary", { chosen: summary.chosen, selectable: summary.selectable, notes: summary.notes })
                : t("summaryReadOnly", { total: all.length, notes: summary.notes })}
              {summary.applied > 0 ? ` ${t("alreadyApplied", { count: summary.applied })}` : null}
            </p>
            {minimised ? <p className="text-xs text-muted-foreground">{t("minimised")}</p> : null}
            {truncated && editable ? (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                {t("truncated")}
              </p>
            ) : null}
            {stale ? (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                {t("stale")}
              </p>
            ) : null}
            {editable && summary.protectedChosen > 0 ? (
              <p className="flex items-center gap-2 text-sm">
                <ShieldAlert className="h-4 w-4" aria-hidden />
                {t("protectedChosen", { count: summary.protectedChosen })}
              </p>
            ) : null}

            {editable && guardianEnds.length > 0 ? (
              <div className="space-y-2 rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">
                <p className="font-medium">{t("guardiansEndedTitle", { count: guardianEnds.length })}</p>
                <p>{t("guardiansEndedBody")}</p>
                <ul className="list-disc space-y-0.5 pl-5">
                  {guardianEnds.slice(0, 20).map((entry) => (
                    <li key={`${entry.pupilId}-${entry.guardianName ?? ""}`}>
                      <Link className="underline" href={`/admin/people?guardians=${entry.pupilId}`}>
                        {t("guardiansEndedLink", {
                          pupil: localName(entry.pupilId) ?? t("unknownPerson"),
                          guardian: entry.guardianName ?? t("unknownPerson"),
                        })}
                      </Link>
                    </li>
                  ))}
                </ul>
                <div className="flex items-start gap-2">
                  <input id="ss-guardians-seen" type="checkbox" className={`${CHECKBOX} mt-0.5`} checked={guardiansSeen} onChange={(event) => setGuardiansSeen(event.target.checked)} />
                  <label htmlFor="ss-guardians-seen">{t("guardiansEndedSeen")}</label>
                </div>
              </div>
            ) : null}

            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <Label htmlFor="ss-filter-entity">{t("filterEntity")}</Label>
                <select
                  id="ss-filter-entity"
                  className={NATIVE_SELECT}
                  value={filter.entity}
                  onChange={(event) => {
                    setFilter((current) => ({ ...current, entity: event.target.value as ChangeFilter["entity"] }));
                    setShown(PAGE);
                  }}
                >
                  <option value="ALL">{t("filterAll", { count: all.length })}</option>
                  {ENTITIES.map((entity) => {
                    const count = all.filter((change) => change.entity === entity).length;
                    return count > 0 ? (
                      <option key={entity} value={entity}>
                        {t("entityCount", { entity: t(`entities.${entity}`), count })}
                      </option>
                    ) : null;
                  })}
                </select>
              </div>
              <label className="flex items-center gap-2 pb-2 text-sm">
                <input
                  type="checkbox"
                  className={CHECKBOX}
                  checked={filter.attention}
                  onChange={(event) => {
                    setFilter((current) => ({ ...current, attention: event.target.checked }));
                    setShown(PAGE);
                  }}
                />
                {t("filterAttention")}
              </label>
              {editable ? (
                <div className="flex gap-2 pb-1">
                  <Button type="button" size="sm" variant="outline" onClick={() => setOverrides((current) => withAll(current, visible, run.status, true))}>
                    {t("selectVisible")}
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => setOverrides((current) => withAll(current, visible, run.status, false))}>
                    {t("deselectVisible")}
                  </Button>
                </div>
              ) : null}
            </div>

            {visible.length === 0 ? <p className="text-sm text-muted-foreground">{t("emptyFilter")}</p> : null}
            <ul className="divide-y rounded-md border" aria-label={t("listLabel")}>
              {visible.slice(0, shown).map((change) => {
                const { subject, detail } = detailText(change);
                const selectable = isSelectable(change, run.status);
                const inputId = `ss-change-${change.id}`;
                return (
                  <li key={change.id} className="flex items-start gap-3 px-3 py-2 text-sm">
                    {selectable ? (
                      <input
                        id={inputId}
                        type="checkbox"
                        className={`${CHECKBOX} mt-0.5`}
                        checked={isChosen(change, overrides)}
                        onChange={(event) =>
                          setOverrides((current) => new Map(current).set(change.id, event.target.checked))
                        }
                      />
                    ) : (
                      <span className="h-4 w-4 shrink-0" aria-hidden />
                    )}
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant={change.op === "CONFLICT" ? "warning" : change.op === "DEACTIVATE" ? "destructive" : change.op === "INFO" ? "outline" : "secondary"}>
                          {t(`ops.${change.op}`)}
                        </Badge>
                        <span className="text-xs text-muted-foreground">{t(`entities.${change.entity}`)}</span>
                        <label htmlFor={selectable ? inputId : undefined} className="font-medium">
                          {subject ?? t("unknownPerson")}
                        </label>
                        {change.protectedIdentity ? <Badge variant="warning">{t("protected")}</Badge> : null}
                        {change.applied ? <Badge variant="success">{t("appliedBadge")}</Badge> : null}
                        {editable && change.autoApplicable && !change.applied ? (
                          <span className="text-xs text-muted-foreground">{t("autoApplicable")}</span>
                        ) : null}
                      </div>
                      {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
                      {change.conflictCode ? <p className="text-xs">{codeText(tCodes, change.conflictCode)}</p> : null}
                    </div>
                  </li>
                );
              })}
            </ul>
            {visible.length > shown ? (
              <Button type="button" size="sm" variant="outline" onClick={() => setShown((current) => current + PAGE)}>
                {t("showMore", { count: visible.length - shown })}
              </Button>
            ) : null}
          </div>
        ) : null}

        {editable ? (
          <DialogFooter className="flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => setDiscarding(true)} disabled={apply.isPending || discard.isPending}>
              {t("discard")}
            </Button>
            <Button type="button" onClick={() => setConfirming(true)} disabled={!canApply || summary.chosen === 0 || apply.isPending}>
              {t("apply", { count: summary.chosen })}
            </Button>
          </DialogFooter>
        ) : null}

        <Dialog open={confirming} onOpenChange={(open) => !open && !apply.isPending && closeConfirm()}>
          <DialogContent className="max-w-md" closeDisabled={apply.isPending}>
            <DialogHeader>
              <DialogTitle>{t("confirmTitle", { count: summary.chosen })}</DialogTitle>
              <DialogDescription>{t("confirmBody")}</DialogDescription>
            </DialogHeader>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {summary.deactivations > 0 ? <li>{t("confirmDeactivations", { count: summary.deactivations })}</li> : null}
              <li>{t("confirmDeselected", { count: summary.selectable - summary.chosen, days: fullEveryDays })}</li>
              <li>{t("confirmNothingDeleted")}</li>
            </ul>
            {massLimit ? (
              <div role="alert" className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <p>{t("massDeactivation", { deactivations: massLimit.deactivations, limit: massLimit.limit })}</p>
                <div className="flex items-start gap-2">
                  <input id="ss-mass" type="checkbox" className={`${CHECKBOX} mt-0.5`} checked={massConfirmed} onChange={(event) => setMassConfirmed(event.target.checked)} />
                  <label htmlFor="ss-mass">{t("massDeactivationConfirm")}</label>
                </div>
              </div>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeConfirm} disabled={apply.isPending}>
                {tCommon("cancel")}
              </Button>
              <Button type="button" onClick={() => doApply(massLimit !== null)} disabled={apply.isPending || (massLimit !== null && !massConfirmed)}>
                {apply.isPending ? <Loader2 className="animate-spin" /> : null}
                {t("applyNow")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <ConfirmDialog
          open={discarding}
          onOpenChange={setDiscarding}
          title={t("discardTitle")}
          description={t("discardBody", { days: fullEveryDays })}
          confirmLabel={t("discard")}
          loading={discard.isPending}
          onConfirm={() =>
            discard.mutate(undefined, {
              onSuccess: () => {
                toast.success(t("discarded"));
                setDiscarding(false);
                onClose();
              },
              onError: (error) => toast.error(errorText(tErrors, error, tCommon("error"))),
            })
          }
        />
      </DialogContent>
    </Dialog>
  );
}
