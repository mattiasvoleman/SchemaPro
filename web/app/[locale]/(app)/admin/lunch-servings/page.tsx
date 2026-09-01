"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Link } from "@/i18n/navigation";
import { Pencil, Plus, Trash2, TriangleAlert, UtensilsCrossed } from "lucide-react";
import {
  useActiveYear,
  useCrudMutations,
  useGroups,
  useLunchServings,
  useLunchSettings,
  useLunchSittings,
} from "@/lib/queries";
import type { LunchServing } from "@/lib/types";
import { servingsFor } from "@/lib/lunch-servings";
import { lunchFlow, peakSeated } from "@/lib/lunch-flow";
import { formatTime, timeToMinutes } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** Förskoleklass through gymnasiets third year — the Swedish span. */
const GRADES = Array.from({ length: 13 }, (_, grade) => grade);
const WEEKDAYS = [1, 2, 3, 4, 5] as const;
/** The select's stand-in for `dayOfWeek: null`, which a Select cannot hold. */
const EVERY_DAY = "all";

interface ServingForm {
  minGradeLevel: string;
  maxGradeLevel: string;
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  seats: string;
}

const EMPTY_FORM: ServingForm = {
  minGradeLevel: "4",
  maxGradeLevel: "6",
  dayOfWeek: EVERY_DAY,
  startTime: "11:00",
  endTime: "11:40",
  seats: "",
};

export default function LunchServingsPage() {
  const t = useTranslations("lunchServings");
  const tCommon = useTranslations("common");
  const tDays = useTranslations("days");
  const tGrades = useTranslations("grades");
  const { data: servings, isLoading } = useLunchServings();
  const { data: lunchSettings } = useLunchSettings();
  const { activeYear } = useActiveYear();
  const { data: sittings } = useLunchSittings(activeYear?.id ?? null);
  const { data: groups } = useGroups();

  const mutations = useCrudMutations<{
    minGradeLevel: number;
    maxGradeLevel: number;
    dayOfWeek: number | null;
    startTime: string;
    endTime: string;
    seats: number | null;
  }>("/api/v1/lunch-servings", [["lunch-servings"]]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<LunchServing | null>(null);
  const [deleting, setDeleting] = useState<LunchServing | null>(null);
  const [form, setForm] = useState<ServingForm>(EMPTY_FORM);

  const spanLabel = (min: number, max: number): string =>
    min === max
      ? tGrades("grade", { grade: min })
      : `${tGrades("grade", { grade: min })}–${tGrades("grade", { grade: max })}`;

  /**
   * The stages the school has written about, in year order.
   *
   * Derived from the rows rather than from a fixed F-3/4-6/7-9, because the
   * school decides what a stage is — one row per single year is an equally
   * valid thing to say, and the flow below has to show it back.
   */
  const spans = useMemo(() => {
    const seen = new Map<string, { min: number; max: number }>();
    for (const serving of servings ?? []) {
      seen.set(`${serving.minGradeLevel}-${serving.maxGradeLevel}`, {
        min: serving.minGradeLevel,
        max: serving.maxGradeLevel,
      });
    }
    return [...seen.values()].sort((a, b) => a.min - b.min || a.max - b.max);
  }, [servings]);

  /** Group names for the kitchen's list; an id there would be useless. */
  const groupNameOf = useMemo(
    () => new Map((groups ?? []).map((group) => [group.id, group.name])),
    [groups],
  );

  /** The break's length, which decides whether a sitting is long enough. */
  const lunchMinutes = lunchSettings?.lunchEnabled
    ? (lunchSettings.lunchMinutes ?? null)
    : null;

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (serving: LunchServing) => {
    setEditing(serving);
    setForm({
      minGradeLevel: String(serving.minGradeLevel),
      maxGradeLevel: String(serving.maxGradeLevel),
      dayOfWeek: serving.dayOfWeek === null ? EVERY_DAY : String(serving.dayOfWeek),
      startTime: formatTime(serving.startTime),
      endTime: formatTime(serving.endTime),
      seats: serving.seats === null ? "" : String(serving.seats),
    });
    setDialogOpen(true);
  };

  const submit = async () => {
    const body = {
      minGradeLevel: Number(form.minGradeLevel),
      maxGradeLevel: Number(form.maxGradeLevel),
      dayOfWeek: form.dayOfWeek === EVERY_DAY ? null : Number(form.dayOfWeek),
      startTime: form.startTime,
      endTime: form.endTime,
      // "" is the admin leaving the field alone, which means the hall's own
      // limit — not a sitting for nobody. Number("") is 0 and would be refused.
      seats: form.seats.trim() === "" ? null : Number(form.seats),
    };
    try {
      if (editing) {
        await mutations.update.mutateAsync({ id: editing.id, ...body });
        toast.success(tCommon("updated"));
      } else {
        await mutations.create.mutateAsync(body);
        toast.success(tCommon("created"));
      }
      setDialogOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    try {
      await mutations.remove.mutateAsync(deleting.id);
      toast.success(tCommon("deleted"));
      setDeleting(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const formValid = form.startTime < form.endTime;

  return (
    <div>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Button onClick={openCreate}>
            <Plus />
            {t("add")}
          </Button>
        }
      />

      <p className="mb-4 max-w-prose text-sm text-muted-foreground">{t("hint")}</p>

      {/*
        A sitting is a window for a meal whose length lives on the lunch card.
        With no lunch defined the rows here constrain nothing at all, and a page
        that let an admin write six of them without saying so would be a page
        that wasted an afternoon.
      */}
      {lunchMinutes === null ? (
        <div
          role="status"
          className="mb-6 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <div className="space-y-1">
            <p>{t("noLunch")}</p>
            <Link
              href="/admin/constraints"
              className="font-medium underline underline-offset-4"
            >
              {t("lunchLink")}
            </Link>
          </div>
        </div>
      ) : null}

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : !servings || servings.length === 0 ? (
        <EmptyState
          icon={UtensilsCrossed}
          title={tCommon("noResults")}
          description={t("empty")}
        />
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-foreground">{t("gradeSpan")}</TableHead>
                  <TableHead className="text-foreground">{t("day")}</TableHead>
                  <TableHead className="text-foreground">{tCommon("time")}</TableHead>
                  <TableHead className="text-foreground">{t("seats")}</TableHead>
                  <TableHead className="w-24 text-right text-foreground">
                    {tCommon("actions")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {servings.map((serving) => (
                  <TableRow key={serving.id}>
                    <TableCell className="font-medium">
                      {spanLabel(serving.minGradeLevel, serving.maxGradeLevel)}
                    </TableCell>
                    <TableCell>
                      {serving.dayOfWeek === null ? (
                        <Badge variant="secondary">{t("everyDay")}</Badge>
                      ) : (
                        tDays(String(serving.dayOfWeek))
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {formatTime(serving.startTime)}–{formatTime(serving.endTime)}
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {serving.seats ?? t("seatsPlaceholder")}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openEdit(serving)}
                        aria-label={tCommon("edit")}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setDeleting(serving)}
                        aria-label={tCommon("delete")}
                      >
                        <Trash2 className="text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/*
            The rows above are what the school typed; this is the flow they make.
            Sittings reaching one stage add up and a weekday row shadows the
            every-day one — correct, and impossible to read off a list. Computed
            with servingsFor, the same function the app's own checks use, rather
            than a second implementation that could disagree with the solver.
          */}
          <section aria-labelledby="deklarerade-fonster" className="mt-8">
            <h2 id="deklarerade-fonster" className="text-lg font-semibold">
              {t("windowsTitle")}
            </h2>
            <p className="mb-3 text-sm text-muted-foreground">{t("windowsHint")}</p>
            <p className="mb-3 max-w-prose text-sm text-muted-foreground">
              {t("overlapHint")}
            </p>
            <div className="overflow-x-auto rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-foreground">{t("gradeSpan")}</TableHead>
                    {WEEKDAYS.map((day) => (
                      <TableHead key={day} className="text-foreground">
                        {tDays(String(day))}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {spans.map((span) => (
                    <TableRow key={`${span.min}-${span.max}`}>
                      <TableCell className="font-medium">
                        {spanLabel(span.min, span.max)}
                      </TableCell>
                      {WEEKDAYS.map((day) => {
                        const open = servingsFor(servings, span, day);
                        if (open.length === 0) {
                          return (
                            <TableCell key={day} className="text-muted-foreground">
                              {t("flowOpen")}
                            </TableCell>
                          );
                        }
                        return (
                          <TableCell key={day} className="tabular-nums">
                            <div className="flex flex-col gap-1">
                              {open.map((serving) => {
                                const minutes =
                                  timeToMinutes(serving.endTime) -
                                  timeToMinutes(serving.startTime);
                                const tooShort =
                                  lunchMinutes !== null && minutes < lunchMinutes;
                                return (
                                  <span key={serving.id}>
                                    {formatTime(serving.startTime)}–
                                    {formatTime(serving.endTime)}
                                    {tooShort ? (
                                      <Badge variant="destructive" className="ml-2">
                                        {t("tooShort", { minutes: lunchMinutes })}
                                      </Badge>
                                    ) : null}
                                  </span>
                                );
                              })}
                            </div>
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        </>
      )}

      {/*
        What the solver actually did, as opposed to what the school asked for.
        The table above is the rule; this is the day. It is the cheapest useful
        artefact in the whole feature — one page the kitchen can print — and it
        exists only after a generation run, which is why it is absent rather
        than empty until then.
      */}
      {sittings && sittings.length > 0 ? (
        <section aria-labelledby="kitchen-flow" className="mt-10">
          <h2 id="kitchen-flow" className="text-lg font-semibold">
            {t("flowTitle")}
          </h2>
          <p className="mb-3 text-sm text-muted-foreground">{t("flowSubtitle")}</p>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {WEEKDAYS.map((day) => {
              const waves = lunchFlow(sittings, day);
              if (waves.length === 0) return null;
              return (
                <div key={day} className="rounded-lg border bg-card p-4">
                  <h3 className="font-medium">{tDays(String(day))}</h3>
                  <p className="mb-2 text-sm text-muted-foreground">
                    {t("flowTotal", { count: peakSeated(sittings, day) })}
                  </p>
                  <ol className="space-y-1 text-sm">
                    {waves.map((wave) => (
                      <li key={wave.startMinutes} className="flex justify-between gap-3">
                        <span className="tabular-nums">
                          {clock(wave.startMinutes)}–{clock(wave.endMinutes)}
                        </span>
                        <span className="text-right">
                          {wave.studentGroupIds
                            .map((id) => groupNameOf.get(id) ?? "—")
                            .join(", ")}
                          <span className="ml-2 text-muted-foreground tabular-nums">
                            {t("flowSeated", { count: wave.seated })}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? t("edit") : t("add")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t("gradeSpan")}</Label>
              <div className="flex items-center gap-2">
                <Select
                  value={form.minGradeLevel}
                  onValueChange={(value) =>
                    setForm({
                      ...form,
                      minGradeLevel: value,
                      // Keep the pair ordered as the admin types rather than
                      // rejecting it afterwards.
                      maxGradeLevel:
                        Number(value) > Number(form.maxGradeLevel)
                          ? value
                          : form.maxGradeLevel,
                    })
                  }
                >
                  <SelectTrigger aria-label={t("gradeSpan")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {GRADES.map((grade) => (
                      <SelectItem key={grade} value={String(grade)}>
                        {tGrades("grade", { grade })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span aria-hidden="true">–</span>
                <Select
                  value={form.maxGradeLevel}
                  onValueChange={(value) =>
                    setForm({
                      ...form,
                      maxGradeLevel: value,
                      minGradeLevel:
                        Number(value) < Number(form.minGradeLevel)
                          ? value
                          : form.minGradeLevel,
                    })
                  }
                >
                  <SelectTrigger aria-label={`${t("gradeSpan")} – ${tCommon("to")}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {GRADES.map((grade) => (
                      <SelectItem key={grade} value={String(grade)}>
                        {tGrades("grade", { grade })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>{t("day")}</Label>
              <Select
                value={form.dayOfWeek}
                onValueChange={(value) => setForm({ ...form, dayOfWeek: value })}
              >
                <SelectTrigger aria-label={t("day")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={EVERY_DAY}>{t("everyDay")}</SelectItem>
                  {WEEKDAYS.map((day) => (
                    <SelectItem key={day} value={String(day)}>
                      {tDays(String(day))}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="sittning-start">{t("startTime")}</Label>
                <Input
                  id="sittning-start"
                  type="time"
                  value={form.startTime}
                  onChange={(event) => setForm({ ...form, startTime: event.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sittning-slut">{t("endTime")}</Label>
                <Input
                  id="sittning-slut"
                  type="time"
                  value={form.endTime}
                  onChange={(event) => setForm({ ...form, endTime: event.target.value })}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="sittning-platser">{t("seats")}</Label>
              <Input
                id="sittning-platser"
                type="number"
                min={1}
                placeholder={t("seatsPlaceholder")}
                value={form.seats}
                onChange={(event) => setForm({ ...form, seats: event.target.value })}
              />
              <p className="text-sm text-muted-foreground">{t("seatsHint")}</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {tCommon("cancel")}
            </Button>
            <Button onClick={submit} disabled={!formValid}>
              {tCommon("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={tCommon("delete")}
        description={
          deleting
            ? `${spanLabel(deleting.minGradeLevel, deleting.maxGradeLevel)} · ${
                deleting.dayOfWeek === null
                  ? t("everyDay")
                  : tDays(String(deleting.dayOfWeek))
              } ${formatTime(deleting.startTime)}–${formatTime(deleting.endTime)}`
            : ""
        }
        onConfirm={confirmDelete}
      />
    </div>
  );
}

/** Minutes since midnight as HH:MM, for the kitchen's list. */
function clock(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
