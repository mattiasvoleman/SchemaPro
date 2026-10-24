"use client";

import { useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { CalendarClock, Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { ApiError } from "@/lib/api";
import { usePeople } from "@/lib/queries";
import { sortByPersonName } from "@/lib/sorting";
import {
  brokenBreakCount,
  clockOf,
  datesOfGap,
  gapsOfBreak,
  gridRowsOf,
  otherShiftsOf,
  weekdaysOf,
  type SupervisionArea,
  type SupervisionGap,
  type SupervisionRota,
  type SupervisionShift,
} from "@/lib/supervision";
import { useReadOnly } from "@/components/profile-context";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { YearSelect, useYearScope } from "@/components/schedule/year-select";
import { useSpanLabel } from "@/components/schedule/stage-week-matrix";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { RowActions } from "@/components/ui/row-actions";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard } from "@/components/ui/table-card";
import { useSites } from "../rooms/use-sites";
import { AreaDialog } from "./area-dialog";
import { ShiftDialog, type ShiftSeed } from "./shift-dialog";
import {
  useAreaMutations,
  useShiftMutations,
  useSupervisionAreas,
  useSupervisionRota,
  type AreaBody,
  type ShiftBody,
} from "./use-supervision";

/**
 * Rastvaktsschema (migration 20261207090000): the places the school watches
 * during the pupils' breaks, who watches which break where, and the breaks
 * nobody watches.
 *
 * WHAT IS THE GATEWAY'S. Which breaks an area is watched in — its årskurser's
 * rasts and lunch, laid together where they overlap — and which of them are
 * short of rastvakter, on which dates, come from GET /supervision-rota
 * (src/supervision/supervision-coverage.ts), as do each teacher's minutes
 * beside their ram. This page draws them: a grid per area with a row per
 * break and a column per weekday, the gaps listed first, and the teachers'
 * minutes last. A pass in a cell is the pass that runs some minute of that
 * break, on any of its dates; a pass in no break is under Övriga pass.
 *
 * LÄSARE (Läsbehörighet): every control that writes is marked for planering
 * (data-writes), and a pass in a cell is its teacher's name rather than a
 * button that opens a form.
 */

const SHORT_DAY = ["", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

interface ShiftDialogState {
  shift: SupervisionShift | null;
  seed: ShiftSeed;
}

export default function SupervisionPage() {
  const t = useTranslations("supervision");
  const tCommon = useTranslations("common");
  const tDays = useTranslations("days");
  const readOnly = useReadOnly();
  const scope = useYearScope();
  const areasQuery = useSupervisionAreas();
  const rotaQuery = useSupervisionRota(scope.yearId);
  const peopleQuery = usePeople();
  const people = peopleQuery.data;
  const { data: sitesData } = useSites();
  const areaMutations = useAreaMutations();
  const shiftMutations = useShiftMutations();
  const spanLabel = useSpanLabel();

  const [areaDialog, setAreaDialog] = useState<{ area: SupervisionArea | null } | null>(null);
  const [deletingArea, setDeletingArea] = useState<SupervisionArea | null>(null);
  const [shiftDialog, setShiftDialog] = useState<ShiftDialogState | null>(null);
  const [deletingShift, setDeletingShift] = useState<SupervisionShift | null>(null);

  const rota = rotaQuery.data;
  // The list of areas from the rota when it has come, so the grid and the
  // card never disagree; the areas route alone before a year exists.
  const areas = rota?.areas ?? areasQuery.data ?? [];
  const sites = sitesData?.sites ?? [];
  const siteName = (id: string | null) => sites.find((site) => site.id === id)?.name ?? null;

  /**
   * A teacher by name, "(inaktiv)" after one the register has deactivated:
   * the teacher lists and the dialog's select. A pass in the grid says from
   * when instead (inactiveFrom): it watches until the day before.
   */
  const nameOf = useMemo(() => {
    const byId = new Map(
      (people ?? []).map((person) => {
        const name = `${person.firstName} ${person.lastName}`;
        return [person.id, person.isActive ? name : t("grid.inactive", { name })];
      }),
    );
    return (userId: string) => byId.get(userId) ?? userId.slice(0, 8);
  }, [people, t]);
  /** A teacher's name alone, for a sentence that says their state itself. */
  const plainName = (userId: string) => {
    const person = people?.find((row) => row.id === userId);
    return person ? `${person.firstName} ${person.lastName}` : userId.slice(0, 8);
  };
  /** Surname order, as every list of people in the app: the index of each person in it. */
  const order = useMemo(() => new Map(sortByPersonName(people ?? []).map((person, index) => [person.id, index])), [people]);
  /** Who may be given a pass: the school's active staff, by surname. The edited pass keeps its own teacher, whatever they are now. */
  const staffFor = (keep: string | null) =>
    sortByPersonName(
      (people ?? []).filter(
        (person) => person.id === keep || (person.isActive && (person.role === "TEACHER" || person.role === "SCHOOL_ADMIN")),
      ),
    ).map((person) => ({ id: person.id, name: nameOf(person.id) }));
  const weekdays = rota ? weekdaysOf(rota) : [1, 2, 3, 4, 5];
  const shortDay = (day: number) => tCommon(SHORT_DAY[day] ?? "monday");
  /** A weekday inside a sentence: "måndag", where the column says "Måndag". */
  const dayName = (day: number) => t("dayName", { day: String(day) });
  const areaName = (id: string) => areas.find((area) => area.id === id)?.name ?? "";

  const errorText = (error: unknown, scopeKey: "areas" | "shift") =>
    error instanceof ApiError && error.code && t.has(`${scopeKey}.errors.${error.code}`)
      ? t(`${scopeKey}.errors.${error.code}`)
      : error instanceof Error
        ? error.message
        : tCommon("error");

  const saveArea = async (body: AreaBody) => {
    const editing = areaDialog?.area ?? null;
    if (editing) {
      await areaMutations.update.mutateAsync({ id: editing.id, ...body });
      toast.success(t("areas.saved", { name: body.name }));
    } else {
      await areaMutations.create.mutateAsync(body);
      toast.success(t("areas.created", { name: body.name }));
    }
  };
  const removeArea = async () => {
    if (!deletingArea) return;
    try {
      await areaMutations.remove.mutateAsync(deletingArea.id);
      toast.success(t("areas.deleted", { name: deletingArea.name }));
      deleted.current = "area";
      setDeletingArea(null);
    } catch (error) {
      toast.error(errorText(error, "areas"));
    }
  };

  /** The pass as the gateway stored it: the dialog says when it runs during a lesson. */
  const saveShift = async (body: ShiftBody): Promise<SupervisionShift | undefined> => {
    const editing = shiftDialog?.shift ?? null;
    if (editing) {
      const saved = await shiftMutations.update.mutateAsync({ id: editing.id, ...body });
      toast.success(t("shift.saved"));
      return saved;
    }
    if (scope.yearId) {
      const created = await shiftMutations.create.mutateAsync({ academicYearId: scope.yearId, ...body });
      toast.success(t("shift.created"));
      return created;
    }
    return undefined;
  };
  /** After a delete the control that opened the dialog is gone: focus goes to the page's own add button. */
  const deleted = useRef<"shift" | "area" | null>(null);
  const focusAfterDelete = (event: Event) => {
    const target = deleted.current === "area" ? "supervision-add-area" : deleted.current === "shift" ? "supervision-add-shift" : null;
    deleted.current = null;
    const element = target ? document.getElementById(target) : null;
    if (!element) return;
    event.preventDefault();
    element.focus();
  };
  const removeShift = async () => {
    if (!deletingShift) return;
    try {
      await shiftMutations.remove.mutateAsync(deletingShift.id);
      toast.success(t("shift.deleted"));
      deleted.current = "shift";
      setDeletingShift(null);
      setShiftDialog(null);
    } catch (error) {
      toast.error(errorText(error, "shift"));
    }
  };

  const openNewShift = (seed: ShiftSeed = {}) => setShiftDialog({ shift: null, seed });
  /** A gap's area, day, break and dates as the new pass's; a bound on the year's own stays empty. */
  const seedOfGap = (gap: SupervisionGap): ShiftSeed => ({
    areaId: gap.areaId,
    dayOfWeek: gap.dayOfWeek,
    startTime: gap.startTime,
    endTime: gap.endTime,
    ...datesOfGap(gap),
  });

  // The names too: a pass is its teacher's name, and a grid of ids is no schedule.
  const loading =
    scope.isLoading || (scope.yearId !== null && rotaQuery.isLoading) || areasQuery.isLoading || peopleQuery.isLoading;
  const failed = scope.isError || (rotaQuery.isError && !rota);

  return (
    <Page>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <>
            <YearSelect value={scope.yearId} label={t("yearLabel")} onValueChange={scope.setYearId} />
            <Button
              id="supervision-add-shift"
              data-writes="PLANERING"
              onClick={() => openNewShift(areas[0] ? { areaId: areas[0].id } : {})}
              disabled={!rota || areas.length === 0}
            >
              <Plus aria-hidden="true" />
              {t("addShift")}
            </Button>
          </>
        }
      />

      {loading ? (
        <div aria-busy="true" className="space-y-4">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : failed ? (
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} />
      ) : scope.yearId === null ? (
        <EmptyState icon={CalendarClock} title={t("noYearTitle")} description={t("noYear")} />
      ) : (
        <div className="space-y-6">
          {rotaQuery.isError ? <LoadError variant="inline" title={t("loadFailed")} hint={tCommon("refetchFailedHint")} /> : null}
          {peopleQuery.isError ? <LoadError variant="inline" title={t("peopleFailed")} /> : null}

          {rota && areas.length > 0 ? (
            <GapsCard rota={rota} areaName={areaName} dayName={dayName} onAdd={(gap) => openNewShift(seedOfGap(gap))} />
          ) : null}

          {rota && areas.length === 0 ? (
            <EmptyState icon={ShieldCheck} title={t("noAreasTitle")} description={t("noAreas")} />
          ) : null}

          {rota
            ? areas.map((area) => {
                const rows = gridRowsOf(rota, area.id);
                const others = otherShiftsOf(rota, area.id);
                const shiftById = new Map(rota.shifts.map((shift) => [shift.id, shift]));
                const passLabel = (shift: SupervisionShift) => {
                  const dates =
                    shift.validFrom && shift.validTo
                      ? t("grid.fromTo", { from: shift.validFrom, to: shift.validTo })
                      : shift.validFrom
                        ? t("grid.from", { date: shift.validFrom })
                        : shift.validTo
                          ? t("grid.to", { date: shift.validTo })
                          : null;
                  // A deactivated teacher's pass watches until the day before: the
                  // day says from when the break is unwatched.
                  const name = shift.inactiveFrom
                    ? t("grid.inactiveFrom", { name: plainName(shift.userId), date: shift.inactiveFrom })
                    : nameOf(shift.userId);
                  const lessons =
                    shift.lessonClashes.length > 0
                      ? t("grid.duringLesson", {
                          lessons: shift.lessonClashes.map((lesson) => `${lesson.subject} ${lesson.group}`).join(", "),
                        })
                      : null;
                  return { name, dates, lessons };
                };
                const pass = (shift: SupervisionShift, withTime: boolean) => {
                  const { name, dates, lessons } = passLabel(shift);
                  // The button's name says what its text says, the dates and a lesson too.
                  const label =
                    t("grid.edit", { name, day: dayName(shift.dayOfWeek), start: clockOf(shift.startTime), end: clockOf(shift.endTime) }) +
                    (dates ? `, ${dates}` : "") +
                    (lessons ? `, ${lessons}` : "");
                  const time = withTime ? t("grid.passTime", { start: clockOf(shift.startTime), end: clockOf(shift.endTime) }) : null;
                  const text = (
                    <>
                      <span className="font-medium">{name}</span>
                      {time ? <span className="block text-xs text-muted-foreground tabular-nums">{time}</span> : null}
                      {dates ? <span className="block text-xs text-muted-foreground">{dates}</span> : null}
                      {lessons ? (
                        <span className="block text-xs font-medium text-warning-foreground dark:text-warning print:text-warning-foreground dark:print:text-warning-foreground">
                          {lessons}
                        </span>
                      ) : null}
                    </>
                  );
                  return (
                    <li key={shift.id}>
                      {readOnly ? (
                        <span className="block text-sm">{text}</span>
                      ) : (
                        <button
                          type="button"
                          data-writes="PLANERING"
                          className="block w-full rounded-sm text-left text-sm hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                          aria-label={label}
                          onClick={() => setShiftDialog({ shift, seed: {} })}
                        >
                          {text}
                        </button>
                      )}
                    </li>
                  );
                };
                return (
                  <SectionCard
                    key={area.id}
                    id={`area-${area.id}`}
                    title={area.name}
                    description={[
                      area.minGradeLevel !== null && area.maxGradeLevel !== null
                        ? spanLabel(area.minGradeLevel, area.maxGradeLevel)
                        : t("areas.everyStage"),
                      siteName(area.siteId),
                      t("grid.needs", { count: area.guardsNeeded }),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  >
                    {rows.length === 0 ? (
                      <p className="text-sm text-muted-foreground">{t("grid.noBreaks")}</p>
                    ) : (
                      <TableCard caption={t("grid.caption", { area: area.name })}>
                        <TableHeader>
                          <TableRow>
                            <TableHead scope="col">{t("grid.break")}</TableHead>
                            {weekdays.map((day) => (
                              <TableHead key={day} scope="col">
                                <abbr title={tDays(String(day))} className="no-underline">
                                  {shortDay(day)}
                                </abbr>
                              </TableHead>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {rows.map((row) => (
                            <TableRow key={row.key}>
                              <TableHead scope="row" className="align-top font-normal">
                                <span className="block tabular-nums font-medium">
                                  {clockOf(row.startTime)}–{clockOf(row.endTime)}
                                </span>
                                <span className="block text-xs text-muted-foreground">{row.names.join(", ")}</span>
                              </TableHead>
                              {weekdays.map((day) => {
                                const brk = row.days.get(day);
                                if (!brk) {
                                  return (
                                    <TableCell key={day} className="align-top text-xs text-muted-foreground">
                                      {t("grid.notThatDay")}
                                    </TableCell>
                                  );
                                }
                                const short = gapsOfBreak(rota, brk).length > 0;
                                const shifts = brk.shiftIds
                                  .map((id) => shiftById.get(id))
                                  .filter((shift): shift is SupervisionShift => shift !== undefined);
                                return (
                                  <TableCell key={day} className={short ? "align-top bg-warning/10" : "align-top"}>
                                    {short ? (
                                      <span className="mb-1 block text-xs font-medium text-warning-foreground dark:text-warning print:text-warning-foreground dark:print:text-warning-foreground">
                                        {t("grid.short")}
                                      </span>
                                    ) : null}
                                    <ul className="space-y-1">
                                      {shifts.map((shift) =>
                                        pass(shift, shift.startTime !== brk.startTime || shift.endTime !== brk.endTime),
                                      )}
                                    </ul>
                                    <Button
                                      data-writes="PLANERING"
                                      type="button"
                                      variant="ghost"
                                      size="sm"
                                      className="mt-1 h-7 px-2"
                                      aria-label={t("grid.add", { area: area.name, day: dayName(day), start: clockOf(brk.startTime) })}
                                      onClick={() =>
                                        openNewShift({ areaId: area.id, dayOfWeek: day, startTime: brk.startTime, endTime: brk.endTime })
                                      }
                                    >
                                      <Plus aria-hidden="true" />
                                    </Button>
                                  </TableCell>
                                );
                              })}
                            </TableRow>
                          ))}
                        </TableBody>
                      </TableCard>
                    )}
                    {others.length > 0 ? (
                      <div className="mt-4 space-y-2">
                        <h3 className="text-sm font-semibold">{t("grid.other")}</h3>
                        <p className="text-xs text-muted-foreground">{t("grid.otherHint")}</p>
                        <ul className="grid gap-2 sm:grid-cols-2">
                          {others.map((shift) => (
                            <li key={shift.id} className="rounded-md border p-2">
                              <span className="block text-xs text-muted-foreground">{tDays(String(shift.dayOfWeek))}</span>
                              <ul>{pass(shift, true)}</ul>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </SectionCard>
                );
              })
            : null}

          {rota ? <TeachersCard rota={rota} nameOf={nameOf} order={order} /> : null}

          <SectionCard
            id="supervision-areas"
            title={t("areas.title")}
            description={t("areas.description")}
            action={
              <Button
                id="supervision-add-area"
                data-writes="PLANERING"
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setAreaDialog({ area: null })}
              >
                <Plus aria-hidden="true" />
                {t("areas.add")}
              </Button>
            }
          >
            {areas.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noAreas")}</p>
            ) : (
              <TableCard caption={t("areas.caption")}>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("areas.columns.name")}</TableHead>
                    {sites.length > 0 ? <TableHead>{t("areas.columns.site")}</TableHead> : null}
                    <TableHead>{t("areas.columns.grades")}</TableHead>
                    <TableHead>{t("areas.columns.during")}</TableHead>
                    <TableHead className="text-right">{t("areas.columns.guards")}</TableHead>
                    <TableHead>{t("areas.columns.teaching")}</TableHead>
                    <TableHead className="text-right">{t("areas.columns.shifts")}</TableHead>
                    <TableHead className="w-24 text-right">{tCommon("actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {areas.map((area) => (
                    <TableRow key={area.id}>
                      <TableCell className="font-medium">{area.name}</TableCell>
                      {sites.length > 0 ? <TableCell>{siteName(area.siteId) ?? "—"}</TableCell> : null}
                      <TableCell>
                        {area.minGradeLevel !== null && area.maxGradeLevel !== null
                          ? spanLabel(area.minGradeLevel, area.maxGradeLevel)
                          : t("areas.everyStage")}
                      </TableCell>
                      <TableCell>
                        {area.duringRasts && area.duringLunch
                          ? t("areas.duringBoth")
                          : area.duringRasts
                            ? t("areas.duringRasts")
                            : area.duringLunch
                              ? t("areas.duringLunch")
                              : t("areas.duringNone")}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{area.guardsNeeded}</TableCell>
                      <TableCell>{area.countsAsTeaching ? t("areas.yes") : t("areas.no")}</TableCell>
                      <TableCell className="text-right tabular-nums">{area.shiftCount}</TableCell>
                      <TableCell className="text-right">
                        <div data-writes="PLANERING" className="contents">
                          <RowActions
                            name={area.name}
                            actions={[
                              {
                                label: tCommon("edit"),
                                icon: Pencil,
                                ariaLabel: tCommon("editNamed", { name: area.name }),
                                onSelect: () => setAreaDialog({ area }),
                              },
                              {
                                label: tCommon("delete"),
                                icon: Trash2,
                                ariaLabel: tCommon("deleteNamed", { name: area.name }),
                                onSelect: () => setDeletingArea(area),
                              },
                            ]}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </TableCard>
            )}
          </SectionCard>
        </div>
      )}

      <AreaDialog
        open={areaDialog !== null}
        onOpenChange={(open) => !open && setAreaDialog(null)}
        area={areaDialog?.area ?? null}
        sites={sites}
        saving={areaMutations.create.isPending || areaMutations.update.isPending}
        onSave={saveArea}
      />
      <ConfirmDialog
        open={deletingArea !== null}
        onOpenChange={(open) => !open && setDeletingArea(null)}
        title={tCommon("deleteConfirmTitle", { name: deletingArea?.name ?? "" })}
        description={t("areas.deleteBody", { count: deletingArea?.shiftCount ?? 0 })}
        confirmLabel={tCommon("delete")}
        loading={areaMutations.remove.isPending}
        onConfirm={removeArea}
        onCloseAutoFocus={focusAfterDelete}
      />
      <ShiftDialog
        open={shiftDialog !== null}
        onOpenChange={(open) => !open && setShiftDialog(null)}
        shift={shiftDialog?.shift ?? null}
        seed={shiftDialog?.seed ?? {}}
        areas={areas}
        teachers={staffFor(shiftDialog?.shift?.userId ?? null)}
        plainName={plainName}
        shifts={rota?.shifts ?? []}
        weekdays={weekdays}
        year={rota?.year ?? null}
        saving={shiftMutations.create.isPending || shiftMutations.update.isPending}
        onSave={saveShift}
        onDelete={shiftDialog?.shift ? () => setDeletingShift(shiftDialog.shift) : undefined}
      />
      <ConfirmDialog
        open={deletingShift !== null}
        onOpenChange={(open) => !open && setDeletingShift(null)}
        title={t("shift.deleteTitle")}
        description={
          deletingShift
            ? t("shift.deleteBody", {
                name: nameOf(deletingShift.userId),
                day: dayName(deletingShift.dayOfWeek),
                start: clockOf(deletingShift.startTime),
                end: clockOf(deletingShift.endTime),
                area: areaName(deletingShift.areaId),
              })
            : ""
        }
        confirmLabel={tCommon("delete")}
        loading={shiftMutations.remove.isPending}
        onConfirm={removeShift}
        onCloseAutoFocus={focusAfterDelete}
      />
    </Page>
  );
}

/** The breaks short of rastvakter, area by area and day by day, each with the dates it is short. */
function GapsCard({
  rota,
  areaName,
  dayName,
  onAdd,
}: {
  rota: SupervisionRota;
  areaName: (id: string) => string;
  dayName: (day: number) => string;
  onAdd: (gap: SupervisionGap) => void;
}) {
  const tGaps = useTranslations("supervision.gaps");
  // Nothing to say when no break needs anybody: no rast yet, or every area at 0.
  if (rota.gaps.length === 0 && !rota.breaks.some((row) => row.needed > 0)) return null;
  if (rota.gaps.length === 0) {
    return (
      <Notice tone="success" title={tGaps("title")}>
        {tGaps("none")}
      </Notice>
    );
  }
  const order = new Map(rota.areas.map((area, index) => [area.id, index]));
  const gaps = [...rota.gaps].sort(
    (a, b) =>
      (order.get(a.areaId) ?? 0) - (order.get(b.areaId) ?? 0) ||
      a.dayOfWeek - b.dayOfWeek ||
      a.startTime.localeCompare(b.startTime) ||
      a.from.localeCompare(b.from),
  );
  return (
    <SectionCard id="supervision-gaps" title={tGaps("count", { count: brokenBreakCount(gaps) })} description={tGaps("description")}>
      <ul className="divide-y">
        {gaps.map((gap) => {
          const where = tGaps("where", {
            area: areaName(gap.areaId),
            day: dayName(gap.dayOfWeek),
            start: clockOf(gap.startTime),
            end: clockOf(gap.endTime),
          });
          return (
            <li
              key={`${gap.areaId}-${gap.dayOfWeek}-${gap.startTime}-${gap.from}`}
              className="flex flex-wrap items-start justify-between gap-2 py-2"
            >
              <div className="space-y-0.5 text-sm">
                <p className="font-medium">
                  {where} <span className="font-normal text-muted-foreground">({gap.names.join(", ")})</span>
                </p>
                <p>
                  {gap.fewest === 0
                    ? tGaps("nobody", { from: clockOf(gap.shortFrom), to: clockOf(gap.shortTo) })
                    : tGaps("short", { fewest: gap.fewest, needed: gap.needed, from: clockOf(gap.shortFrom), to: clockOf(gap.shortTo) })}{" "}
                  <span className="text-muted-foreground">
                    {gap.fromYearStart && gap.toYearEnd
                      ? tGaps("wholeYear")
                      : gap.fromYearStart
                        ? tGaps("to", { date: gap.to })
                        : gap.toYearEnd
                          ? tGaps("from", { date: gap.from })
                          : tGaps("dates", { from: gap.from, to: gap.to })}
                  </span>
                </p>
              </div>
              <Button
                data-writes="PLANERING"
                type="button"
                variant="outline"
                size="sm"
                aria-label={tGaps("add", { area: areaName(gap.areaId), day: dayName(gap.dayOfWeek), start: clockOf(gap.startTime) })}
                onClick={() => onAdd(gap)}
              >
                <Plus aria-hidden="true" />
              </Button>
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}

/** Each teacher's passes in minutes per week beside the ram their RASTVAKT uppdrag set. */
function TeachersCard({
  rota,
  nameOf,
  order,
}: {
  rota: SupervisionRota;
  nameOf: (userId: string) => string;
  /** Each person's place in surname order. */
  order: ReadonlyMap<string, number>;
}) {
  const tTeachers = useTranslations("supervision.teachers");
  const place = (userId: string) => order.get(userId) ?? Number.MAX_SAFE_INTEGER;
  const teachers = [...rota.teachers].sort((a, b) => place(a.userId) - place(b.userId));
  return (
    <SectionCard id="supervision-teachers" title={tTeachers("title")} description={tTeachers("description")}>
      {teachers.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tTeachers("empty")}</p>
      ) : (
        <TableCard caption={tTeachers("caption")}>
          <TableHeader>
            <TableRow>
              <TableHead>{tTeachers("columns.teacher")}</TableHead>
              <TableHead className="text-right">{tTeachers("columns.shifts")}</TableHead>
              <TableHead className="text-right">{tTeachers("columns.minutes")}</TableHead>
              <TableHead className="text-right">{tTeachers("columns.ram")}</TableHead>
              <TableHead>{tTeachers("columns.versus")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {teachers.map((row) => {
              const difference = row.ramMinutesPerWeek === null ? null : row.minutesPerWeek - row.ramMinutesPerWeek;
              return (
                <TableRow key={row.userId}>
                  <TableCell className="font-medium">{nameOf(row.userId)}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.shiftCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.minutesPerWeek}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {row.ramMinutesPerWeek === null ? tTeachers("noRam") : tTeachers("minutes", { minutes: row.ramMinutesPerWeek })}
                  </TableCell>
                  <TableCell>
                    {difference === null
                      ? "—"
                      : difference > 0
                        ? tTeachers("over", { minutes: difference })
                        : difference < 0
                          ? tTeachers("under", { minutes: -difference })
                          : tTeachers("atRam")}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </TableCard>
      )}
    </SectionCard>
  );
}
