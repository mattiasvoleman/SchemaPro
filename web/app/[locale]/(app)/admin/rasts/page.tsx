"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Coffee, Pencil, Plus, Trash2 } from "lucide-react";
import { useCrudMutations, useRasts } from "@/lib/queries";
import type { Rast } from "@/lib/types";
import { rastWindows } from "@/lib/rasts";
import { formatTime } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { GradeSpanField } from "@/components/ui/grade-span-field";
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

/**
 * Raster — the minutes of a day a stage of the school is not taught.
 *
 * The declaration, and the whole of it. Unlike the meal, which needs a solved
 * sitting because the engine chooses which class eats when, nothing about a
 * rast is chosen: the school states it, the engine subtracts it from every
 * matching lesson's start domain, and publish dates it.
 *
 * THE PREVIEW IS THE POINT OF THIS PAGE. A stage's rows do not read as a day —
 * an every-day row and a Friday row that overlaps it are two lines in a table
 * and one different Friday in reality — so the table alone would let a school
 * write six rows and discover what they meant after a generation run. What is
 * drawn below the table is the resolved week, computed by lib/rasts.ts, which
 * is the same rule the engine's rasts.py applies.
 */

const WEEKDAYS = [1, 2, 3, 4, 5] as const;
/** The select's stand-in for `dayOfWeek: null`, which a Select cannot hold. */
const EVERY_DAY = "all";

interface RastForm {
  name: string;
  minGradeLevel: number | null;
  maxGradeLevel: number | null;
  dayOfWeek: string;
  startTime: string;
  endTime: string;
}

const EMPTY_FORM: RastForm = {
  name: "",
  minGradeLevel: 4,
  maxGradeLevel: 6,
  dayOfWeek: EVERY_DAY,
  startTime: "09:40",
  endTime: "10:00",
};

export default function RastsPage() {
  const t = useTranslations("rasts");
  const tCommon = useTranslations("common");
  const tDays = useTranslations("days");
  const tGrades = useTranslations("grades");
  const { data: rasts, isLoading } = useRasts();

  const mutations = useCrudMutations<{
    name: string;
    minGradeLevel: number;
    maxGradeLevel: number;
    dayOfWeek: number | null;
    startTime: string;
    endTime: string;
  }>("/api/v1/rasts", [["rasts"]]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Rast | null>(null);
  const [deleting, setDeleting] = useState<Rast | null>(null);
  const [form, setForm] = useState<RastForm>(EMPTY_FORM);

  const spanLabel = (min: number, max: number): string =>
    min === max
      ? tGrades("grade", { grade: min })
      : `${tGrades("grade", { grade: min })}–${tGrades("grade", { grade: max })}`;

  /**
   * The stages the school has written about, in year order.
   *
   * Derived from the rows rather than from a fixed F-3/4-6/7-9, because the
   * school decides what a stage is — one row per single year is an equally
   * valid thing to say, and the week below has to show it back.
   */
  const spans = useMemo(() => {
    const seen = new Map<string, { min: number; max: number }>();
    for (const rast of rasts ?? []) {
      seen.set(`${rast.minGradeLevel}-${rast.maxGradeLevel}`, {
        min: rast.minGradeLevel,
        max: rast.maxGradeLevel,
      });
    }
    return [...seen.values()].sort((a, b) => a.min - b.min || a.max - b.max);
  }, [rasts]);

  const openCreate = () => {
    setEditing(null);
    setForm({ ...EMPTY_FORM, name: t("defaultName") });
    setDialogOpen(true);
  };

  const openEdit = (rast: Rast) => {
    setEditing(rast);
    setForm({
      name: rast.name,
      minGradeLevel: rast.minGradeLevel,
      maxGradeLevel: rast.maxGradeLevel,
      dayOfWeek: rast.dayOfWeek === null ? EVERY_DAY : String(rast.dayOfWeek),
      startTime: formatTime(rast.startTime),
      endTime: formatTime(rast.endTime),
    });
    setDialogOpen(true);
  };

  const submit = async () => {
    const body = {
      name: form.name.trim(),
      minGradeLevel: form.minGradeLevel ?? 0,
      maxGradeLevel: form.maxGradeLevel ?? 12,
      dayOfWeek: form.dayOfWeek === EVERY_DAY ? null : Number(form.dayOfWeek),
      startTime: form.startTime,
      endTime: form.endTime,
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

  const formValid = form.name.trim() !== "" && form.startTime < form.endTime;

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

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : !rasts || rasts.length === 0 ? (
        <EmptyState icon={Coffee} title={tCommon("noResults")} description={t("empty")} />
      ) : (
        <>
          <section aria-labelledby="rasts-rows-title">
            <h2 id="rasts-rows-title" className="sr-only">
              {t("rowsTitle")}
            </h2>
            <div className="overflow-x-auto rounded-lg border bg-card">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-foreground">{t("name")}</TableHead>
                    <TableHead className="text-foreground">{t("gradeSpan")}</TableHead>
                    <TableHead className="text-foreground">{t("day")}</TableHead>
                    <TableHead className="text-foreground">{tCommon("time")}</TableHead>
                    <TableHead className="w-24 text-right text-foreground">
                      {tCommon("actions")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rasts.map((rast) => (
                    <TableRow key={rast.id}>
                      <TableCell className="font-medium">{rast.name}</TableCell>
                      <TableCell>
                        {spanLabel(rast.minGradeLevel, rast.maxGradeLevel)}
                      </TableCell>
                      <TableCell>
                        {rast.dayOfWeek === null ? (
                          <Badge variant="secondary">{t("everyDay")}</Badge>
                        ) : (
                          tDays(String(rast.dayOfWeek))
                        )}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {formatTime(rast.startTime)}–{formatTime(rast.endTime)}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => openEdit(rast)}
                          aria-label={t("editRast", { name: rast.name })}
                        >
                          <Pencil />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setDeleting(rast)}
                          aria-label={t("deleteRast", { name: rast.name })}
                        >
                          <Trash2 />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>

          {/*
            The resolved week.
            An every-day row and a weekday row that overlaps it are two lines in
            the table above and ONE different day in reality. A school that could
            only read the table would write six rows and find out what they meant
            after a generation run — so the same function the engine mirrors,
            lib/rasts.ts, is asked here and its answer is printed.
          */}
          <section aria-labelledby="rasts-week-title" className="mt-8">
            <h2 id="rasts-week-title" className="mb-1 text-lg font-semibold">
              {t("weekTitle")}
            </h2>
            <p className="mb-3 max-w-prose text-sm text-muted-foreground">
              {t("weekHint")}
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
                        const windows = rastWindows(rasts, span, day);
                        return (
                          <TableCell key={day} className="tabular-nums">
                            {windows.length === 0 ? (
                              <span className="text-muted-foreground">{t("noRast")}</span>
                            ) : (
                              <span className="flex flex-col gap-0.5">
                                {windows.map((window) => (
                                  <span key={window.id}>
                                    {hhmm(window.startMinutes)}–{hhmm(window.endMinutes)}
                                  </span>
                                ))}
                              </span>
                            )}
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

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? t("editTitle") : t("addTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="rast-name">{t("name")}</Label>
              <Input
                id="rast-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <GradeSpanField
              label={t("gradeSpan")}
              min={form.minGradeLevel}
              max={form.maxGradeLevel}
              onChange={(span) =>
                setForm({ ...form, minGradeLevel: span.min, maxGradeLevel: span.max })
              }
            />
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
                <Label htmlFor="rast-start">{t("startTime")}</Label>
                <Input
                  id="rast-start"
                  type="time"
                  value={form.startTime}
                  onChange={(e) => setForm({ ...form, startTime: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="rast-end">{t("endTime")}</Label>
                <Input
                  id="rast-end"
                  type="time"
                  value={form.endTime}
                  onChange={(e) => setForm({ ...form, endTime: e.target.value })}
                />
              </div>
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
        title={t("deleteTitle")}
        description={t("deleteBody", { name: deleting?.name ?? "" })}
        confirmLabel={tCommon("delete")}
        onConfirm={confirmDelete}
      />
    </div>
  );
}

/** Minutes from midnight as a wall clock, for the resolved week. */
function hhmm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
