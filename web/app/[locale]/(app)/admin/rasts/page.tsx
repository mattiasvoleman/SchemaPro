"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Coffee, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useCrudMutations, useRasts } from "@/lib/queries";
import type { Rast } from "@/lib/types";
import { clock } from "@/lib/clock";
import { rastWindows } from "@/lib/rasts";
import { formatTime } from "@/lib/utils";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import {
  StageWeekMatrix,
  WEEKDAYS,
  stagesOf,
  useSpanLabel,
} from "@/components/schedule/stage-week-matrix";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form-field";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { LoadError } from "@/components/ui/load-error";
import { RowActions } from "@/components/ui/row-actions";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCard } from "@/components/ui/table-card";
import { GradeSpanField } from "@/components/ui/grade-span-field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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

/** The select's stand-in for `dayOfWeek: null`, which a Select cannot hold. */
const EVERY_DAY = "all";

interface RastForm {
  name: string;
  minGradeLevel: number;
  maxGradeLevel: number;
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  requiresLessonBefore: boolean;
}

const EMPTY_FORM: RastForm = {
  name: "",
  minGradeLevel: 4,
  maxGradeLevel: 6,
  dayOfWeek: EVERY_DAY,
  startTime: "09:40",
  endTime: "10:00",
  // Off, like the column's default: a school that has not asked for the rule
  // keeps the week it has, and the rule is not free for the solver.
  requiresLessonBefore: false,
};

export default function RastsPage() {
  const t = useTranslations("rasts");
  const tCommon = useTranslations("common");
  const tDays = useTranslations("days");
  const { data: rasts, isLoading, isError } = useRasts();

  const mutations = useCrudMutations<{
    name: string;
    minGradeLevel: number;
    maxGradeLevel: number;
    dayOfWeek: number | null;
    startTime: string;
    endTime: string;
    requiresLessonBefore: boolean;
  }>("/api/v1/rasts", [["rasts"]]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Rast | null>(null);
  const [deleting, setDeleting] = useState<Rast | null>(null);
  const [form, setForm] = useState<RastForm>(EMPTY_FORM);

  const spanLabel = useSpanLabel();

  /** The stages the school has written about, in year order (see stagesOf). */
  const spans = useMemo(() => stagesOf(rasts), [rasts]);

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
      requiresLessonBefore: rast.requiresLessonBefore,
      startTime: formatTime(rast.startTime),
      endTime: formatTime(rast.endTime),
    });
    setDialogOpen(true);
  };

  const submit = async () => {
    const body = {
      name: form.name.trim(),
      minGradeLevel: form.minGradeLevel,
      maxGradeLevel: form.maxGradeLevel,
      dayOfWeek: form.dayOfWeek === EVERY_DAY ? null : Number(form.dayOfWeek),
      startTime: form.startTime,
      endTime: form.endTime,
      requiresLessonBefore: form.requiresLessonBefore,
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

  const saving = mutations.create.isPending || mutations.update.isPending;

  return (
    <Page>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        intro={t("hint")}
        actions={
          <Button onClick={openCreate}>
            <Plus aria-hidden="true" />
            {t("add")}
          </Button>
        }
      />

      {isError && rasts !== undefined ? (
        // A failed refetch keeps the rasts as last read, with this above them.
        <LoadError variant="inline" title={t("loadFailed")} hint={tCommon("refetchFailedHint")} />
      ) : null}

      {isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : isError && rasts === undefined ? (
        /*
          Not the empty state: "no rasts" means lessons may run back to back,
          and a failed request is not evidence of that.
        */
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      ) : !rasts || rasts.length === 0 ? (
        <EmptyState icon={Coffee} title={t("emptyTitle")} description={t("empty")} headingLevel={2} />
      ) : (
        <>
          <section aria-labelledby="rasts-rows-title">
            <h2 id="rasts-rows-title" className="sr-only">
              {t("rowsTitle")}
            </h2>
            <TableCard caption={t("rowsTitle")}>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col" className="text-foreground">{t("name")}</TableHead>
                  <TableHead scope="col" className="text-foreground">{t("gradeSpan")}</TableHead>
                  <TableHead scope="col" className="text-foreground">{t("day")}</TableHead>
                  <TableHead scope="col" className="text-foreground">{tCommon("time")}</TableHead>
                  <TableHead scope="col" className="w-24 text-right text-foreground">
                    {tCommon("actions")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rasts.map((rast) => (
                  <TableRow key={rast.id}>
                    <TableCell className="font-medium">
                      <span className="flex flex-wrap items-center gap-2">
                        {rast.name}
                        {/*
                          Beside the name rather than in a column of its own:
                          the flag is off for most schools, and a column that
                          is empty on every row costs width the day and the
                          clock need more.
                        */}
                        {rast.requiresLessonBefore ? (
                          <Badge variant="secondary">{t("lessonBeforeShort")}</Badge>
                        ) : null}
                      </span>
                    </TableCell>
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
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {formatTime(rast.startTime)}–{formatTime(rast.endTime)}
                    </TableCell>
                    <TableCell className="text-right">
                      <RowActions
                        name={rast.name}
                        actions={[
                          {
                            label: tCommon("edit"),
                            icon: Pencil,
                            onSelect: () => openEdit(rast),
                            ariaLabel: t("editRast", { name: rast.name }),
                          },
                          {
                            label: tCommon("delete"),
                            icon: Trash2,
                            onSelect: () => setDeleting(rast),
                            ariaLabel: t("deleteRast", { name: rast.name }),
                          },
                        ]}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </TableCard>
          </section>

          {/*
            The resolved week.
            An every-day row and a weekday row that overlaps it are two lines in
            the table above and ONE different day in reality. A school that could
            only read the table would write six rows and find out what they meant
            after a generation run — so the same function the engine mirrors,
            lib/rasts.ts, is asked here and its answer is printed.
          */}
          <StageWeekMatrix
            id="rasts-week"
            title={t("weekTitle")}
            description={t("weekHint")}
            stageLabel={t("gradeSpan")}
            spans={spans}
            renderCell={(span, day) => {
              const windows = rastWindows(rasts, span, day);
              if (windows.length === 0) {
                return <span className="text-muted-foreground">{t("noRast")}</span>;
              }
              return (
                <span className="flex flex-col gap-0.5">
                  {windows.map((window) => (
                    <span key={window.id}>
                      {clock(window.startMinutes)}–{clock(window.endMinutes)}
                    </span>
                  ))}
                </span>
              );
            }}
          />
        </>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? t("editTitle") : t("addTitle")}</DialogTitle>
            <DialogDescription>{t("dialogDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <FormField id="rast-name" label={t("name")}>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </FormField>
            {/* No "every year": the DTO requires both bounds, so the form has
                no null to hold and nothing to fall back to at the submit. */}
            <GradeSpanField
              label={t("gradeSpan")}
              fromLabel={t("gradeFromLabel")}
              toLabel={t("gradeToLabel")}
              min={form.minGradeLevel}
              max={form.maxGradeLevel}
              onChange={(span) =>
                setForm({ ...form, minGradeLevel: span.min, maxGradeLevel: span.max })
              }
            />
            <FormField id="rast-day" label={t("day")}>
              {(control) => (
                <Select
                  value={form.dayOfWeek}
                  onValueChange={(value) => setForm({ ...form, dayOfWeek: value })}
                >
                  <SelectTrigger {...control}>
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
              )}
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
              <FormField id="rast-start" label={t("startTime")}>
                <Input
                  type="time"
                  value={form.startTime}
                  onChange={(e) => setForm({ ...form, startTime: e.target.value })}
                />
              </FormField>
              <FormField id="rast-end" label={t("endTime")}>
                <Input
                  type="time"
                  value={form.endTime}
                  onChange={(e) => setForm({ ...form, endTime: e.target.value })}
                />
              </FormField>
            </div>
            <div className="flex items-start justify-between gap-4 rounded-md border p-3">
              <div className="space-y-1">
                <Label htmlFor="rast-lesson-before">{t("lessonBefore")}</Label>
                <p id="rast-lesson-before-hint" className="text-xs text-muted-foreground">
                  {t("lessonBeforeHint")}
                </p>
              </div>
              <Switch
                id="rast-lesson-before"
                aria-describedby="rast-lesson-before-hint"
                checked={form.requiresLessonBefore}
                onCheckedChange={(checked) =>
                  setForm({ ...form, requiresLessonBefore: checked })
                }
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {tCommon("cancel")}
            </Button>
            <Button onClick={submit} disabled={!formValid || saving}>
              {saving ? (
                <>
                  <Loader2 className="animate-spin" aria-hidden="true" />
                  {tCommon("saving")}
                </>
              ) : (
                tCommon("save")
              )}
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
        loading={mutations.remove.isPending}
        onConfirm={confirmDelete}
      />
    </Page>
  );
}
