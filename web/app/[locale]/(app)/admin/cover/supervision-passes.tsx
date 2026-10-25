"use client";

import { Fragment, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Ban, ShieldCheck, Undo2, UserPlus } from "lucide-react";
import type { MessageLookup } from "@/lib/engine-message";
import { savedToast } from "@/lib/staffing-warnings";
import { usePassActions } from "@/lib/cover-queries";
import type { PassBoardItem, PassSummary } from "@/lib/cover-types";
import { chainLookup, coverErrorText, errorCode } from "@/lib/cover-view";
import { passActions, passesByDate, passKey, passStatusKey } from "@/lib/pass-view";
import { PASS_STATUS_VARIANT } from "@/lib/status-variants";
import { useSupervisionAreas } from "../supervision/use-supervision";
import { PassCandidatesDialog } from "./pass-candidates-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";
import { TableCard } from "@/components/ui/table-card";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export interface SupervisionPassesProps {
  items: PassBoardItem[];
  summary: PassSummary | undefined;
  view: "day" | "week";
  /** "måndag 2 september": a day header in the week view. */
  dayText: (date: string) => string;
  /** "10:00–10:20" on the reader's clock. */
  timeText: (item: { startsAt: string; endsAt: string }) => string;
  nameOf: (userId: string) => string;
  teachers: { id: string; name: string }[];
  /** The clock the buttons follow, a minute at a time (the board's). */
  now: number;
}

/**
 * RASTVAKT I VARDAGEN (20261210090000) on the Vikarietavla: every
 * rastvaktspass of an absent teacher over the board's window, its state, its
 * vikarie, and the decisions the gateway allows — "Tillsätt vikarie" (the
 * candidates), "Utan ersättare" (another rastvakt is enough), Ångra.
 *
 * A section of its own under the lessons, lazy as the board's dialogs are:
 * a school without passes never downloads it. As on the lessons' rows,
 * nothing here says why anyone is away, and the pass's note is never shown.
 */
export function SupervisionPasses({ items, summary, view, dayText, timeText, nameOf, teachers, now }: SupervisionPassesProps) {
  const t = useTranslations("coverPasses");
  const tCover = useTranslations("coverBoard");
  const tErrors = useTranslations("coverErrors") as unknown as MessageLookup;
  const tEngine = useTranslations("engineMessages") as unknown as MessageLookup;
  const tCommon = useTranslations("common");
  const tWarnings = chainLookup(tErrors, tEngine);
  const { data: areas } = useSupervisionAreas();
  const areaName = useMemo(() => new Map((areas ?? []).map((area) => [area.id, area.name])), [areas]);
  const { decide, undo } = usePassActions();
  const [candidatesFor, setCandidatesFor] = useState<PassBoardItem | null>(null);
  const busy = decide.isPending || undo.isPending;

  const placeOf = (item: PassBoardItem) => areaName.get(item.areaId) ?? "—";
  const passText = (item: PassBoardItem) => `${placeOf(item)}, ${timeText(item)}`;

  const failed = (error: unknown) =>
    toast.error(errorCode(error) === "COVER_STALE" ? t("staleRefetched") : coverErrorText(tErrors, error, tCommon("error")));

  const run = async (item: PassBoardItem, kind: "SUBSTITUTE" | "NO_COVER", substituteId?: string) => {
    try {
      const result = await decide.mutateAsync({
        shiftId: item.shiftId,
        date: item.date,
        absenceId: item.absenceId,
        kind,
        ...(substituteId ? { substituteId } : {}),
        expected: item.status,
      });
      if (kind === "SUBSTITUTE") {
        savedToast(tWarnings, t("toastCovered"), result.warnings);
        setCandidatesFor(null);
      } else {
        toast.success(t("toastNoCover"));
      }
    } catch (error) {
      failed(error);
    }
  };

  const runUndo = async (item: PassBoardItem) => {
    try {
      await undo.mutateAsync({ shiftId: item.shiftId, date: item.date });
      toast.success(t("toastUndone"));
    } catch (error) {
      failed(error);
    }
  };

  const notes = (item: PassBoardItem) => (
    <>
      {/* A vikarie away is news only while a new one can still be chosen. */}
      {item.decisionStale && !item.passed ? (
        <span className="block whitespace-normal text-xs text-muted-foreground">{t("decisionStale")}</span>
      ) : null}
      {item.outsideAbsence ? (
        <span className="block whitespace-normal text-xs text-muted-foreground">{t("outsideAbsence")}</span>
      ) : null}
      {/* Nothing refuses a lov or a deactivation over a booked pass: the board says it, and Ångra tells the vikarie. */}
      {item.runs === false && !item.passed ? (
        <span className="block whitespace-normal text-xs text-muted-foreground">{t("notRunning")}</span>
      ) : null}
    </>
  );

  /** One pass's decisions, the same in the table and the phone list; every one Drift's. */
  const controls = (item: PassBoardItem, className: string) => {
    const actions = passActions(item, now);
    if (!actions.assign && !actions.noCover && !actions.undo) return null;
    const named = (action: string) =>
      tCommon("actionNamed", { action, name: `${nameOf(item.absentTeacherId)}: ${passText(item)}` });
    return (
      <div className={className} data-writes="DRIFT">
        {actions.assign ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            aria-label={named(t("assign"))}
            onClick={() => setCandidatesFor(item)}
          >
            <UserPlus />
            {t("assign")}
          </Button>
        ) : null}
        {actions.noCover ? (
          <Button size="sm" variant="ghost" disabled={busy} aria-label={named(t("noCover"))} onClick={() => void run(item, "NO_COVER")}>
            <Ban />
            {t("noCover")}
          </Button>
        ) : null}
        {actions.undo ? (
          <Button size="sm" variant="ghost" disabled={busy} aria-label={named(t("undo"))} onClick={() => void runUndo(item)}>
            <Undo2 />
            {t("undo")}
          </Button>
        ) : null}
      </div>
    );
  };

  const row = (item: PassBoardItem) => {
    const key = passStatusKey(item);
    return (
      <TableRow key={passKey(item)}>
        <TableCell className="whitespace-nowrap tabular-nums">{timeText(item)}</TableCell>
        <TableCell className="font-medium">{placeOf(item)}</TableCell>
        <TableCell className="whitespace-nowrap">{nameOf(item.absentTeacherId)}</TableCell>
        <TableCell className="whitespace-nowrap">
          <Badge variant={PASS_STATUS_VARIANT[key]}>{t(`status.${key}`)}</Badge>
          {notes(item)}
        </TableCell>
        <TableCell className="whitespace-nowrap">
          {item.substituteId ? nameOf(item.substituteId) : <span className="text-muted-foreground">—</span>}
        </TableCell>
        <TableCell className="text-right">{controls(item, "flex items-center justify-end gap-1")}</TableCell>
      </TableRow>
    );
  };

  const listItem = (item: PassBoardItem) => {
    const key = passStatusKey(item);
    return (
      <li key={passKey(item)} className="space-y-1 px-3 py-2 text-sm">
        <p className="font-medium">
          <span className="tabular-nums">{timeText(item)}</span>
          {` · ${placeOf(item)}`}
        </p>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-muted-foreground">{nameOf(item.absentTeacherId)}</span>
          <Badge variant={PASS_STATUS_VARIANT[key]}>{t(`status.${key}`)}</Badge>
        </div>
        {item.substituteId ? <p className="text-muted-foreground">{tCover("substituteLine", { name: nameOf(item.substituteId) })}</p> : null}
        {notes(item)}
        {controls(item, "flex flex-wrap items-center gap-1 pt-1")}
      </li>
    );
  };

  const days = passesByDate(items);
  const ordered = days.flatMap((day) => day.passes);

  return (
    <SectionCard
      id="cover-passes"
      title={t("title")}
      icon={ShieldCheck}
      description={
        summary
          ? t("summary", { open: summary.open, covered: summary.covered, handled: summary.handled, passed: summary.passedOpen })
          : t("body")
      }
    >
      {/* The list on a phone, the table from sm, split by CSS alone (the lessons' rule). */}
      <ul aria-label={t("tableCaption")} className="divide-y rounded-md border bg-card sm:hidden">
        {view === "day"
          ? ordered.map(listItem)
          : days.map((day) => (
              <Fragment key={day.date}>
                <li className="bg-muted/40 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {dayText(day.date)}
                </li>
                {day.passes.map(listItem)}
              </Fragment>
            ))}
      </ul>
      <TableCard caption={t("tableCaption")} className="hidden sm:block">
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{tCommon("time")}</TableHead>
            <TableHead scope="col">{t("columnArea")}</TableHead>
            <TableHead scope="col">{tCover("columnAbsent")}</TableHead>
            <TableHead scope="col">{tCommon("status")}</TableHead>
            <TableHead scope="col">{tCover("columnSubstitute")}</TableHead>
            <TableHead scope="col" className="text-right">
              {tCommon("actions")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {view === "day"
            ? ordered.map(row)
            : days.map((day) => (
                <Fragment key={day.date}>
                  <TableRow className="bg-muted/40 hover:bg-muted/40">
                    <TableCell colSpan={6} className="py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {dayText(day.date)}
                    </TableCell>
                  </TableRow>
                  {day.passes.map(row)}
                </Fragment>
              ))}
        </TableBody>
      </TableCard>

      <PassCandidatesDialog
        item={candidatesFor}
        passText={candidatesFor ? passText(candidatesFor) : ""}
        nameOf={nameOf}
        teachers={teachers}
        pending={decide.isPending}
        onOpenChange={(open) => !open && setCandidatesFor(null)}
        onAssign={(item, substituteId) => void run(item, "SUBSTITUTE", substituteId)}
      />
    </SectionCard>
  );
}
