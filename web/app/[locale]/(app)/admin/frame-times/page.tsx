"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { CalendarRange, Pencil, Plus, Trash2 } from "lucide-react";
import { useCrudMutations, useFrameTimes } from "@/lib/queries";
import type { FrameTime } from "@/lib/types";
import { frameWindow } from "@/lib/frame-times";
import { formatTime } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { GradeSpanField } from "@/components/ui/grade-span-field";
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

/** Monday-Friday. A ramtid for a Saturday school is expressible but not
 *  offered here: the row accepts 1-7 and the week below would grow two mostly
 *  empty columns for a case no Swedish grundskola has. */
const WEEKDAYS = [1, 2, 3, 4, 5] as const;

/** The select's stand-in for `dayOfWeek: null`, which a Select cannot hold. */
const EVERY_DAY = "all";

interface FrameForm {
  minGradeLevel: number;
  maxGradeLevel: number;
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  changeoverMinutes: string;
}

const EMPTY_FORM: FrameForm = {
  minGradeLevel: 4,
  maxGradeLevel: 6,
  dayOfWeek: EVERY_DAY,
  startTime: "08:00",
  endTime: "15:00",
  changeoverMinutes: "0",
};

export default function FrameTimesPage() {
  const t = useTranslations("frameTimes");
  const tCommon = useTranslations("common");
  const tDays = useTranslations("days");
  const tGrades = useTranslations("grades");
  const { data: frames, isLoading } = useFrameTimes();

  const mutations = useCrudMutations<{
    minGradeLevel: number;
    maxGradeLevel: number;
    dayOfWeek: number | null;
    startTime: string;
    endTime: string;
    changeoverMinutes: number;
  }>("/api/v1/frame-times", [["frame-times"]]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<FrameTime | null>(null);
  const [deleting, setDeleting] = useState<FrameTime | null>(null);
  const [form, setForm] = useState<FrameForm>(EMPTY_FORM);

  /** "Åk 4–6" or "Åk 5" — a single year is the common case and reads worse as a range. */
  const spanLabel = (min: number, max: number): string =>
    min === max
      ? tGrades("grade", { grade: min })
      : `${tGrades("grade", { grade: min })}–${tGrades("grade", { grade: max })}`;

  /**
   * The distinct stages the school has written about, in year order.
   *
   * Derived from the rows rather than from a list of stages, because the school
   * decides what a stage is: F–3/4–6/7–9 in most places, but a school that
   * writes one row per year is saying something equally valid and the week
   * below has to show it back.
   */
  const spans = useMemo(() => {
    const seen = new Map<string, { min: number; max: number }>();
    for (const frame of frames ?? []) {
      seen.set(`${frame.minGradeLevel}-${frame.maxGradeLevel}`, {
        min: frame.minGradeLevel,
        max: frame.maxGradeLevel,
      });
    }
    return [...seen.values()].sort((a, b) => a.min - b.min || a.max - b.max);
  }, [frames]);

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (frame: FrameTime) => {
    setEditing(frame);
    setForm({
      minGradeLevel: frame.minGradeLevel,
      maxGradeLevel: frame.maxGradeLevel,
      dayOfWeek: frame.dayOfWeek === null ? EVERY_DAY : String(frame.dayOfWeek),
      startTime: formatTime(frame.startTime),
      endTime: formatTime(frame.endTime),
      changeoverMinutes: String(frame.changeoverMinutes ?? 0),
    });
    setDialogOpen(true);
  };

  /** Open the dialog on a 0-12, every-day frame across the configured day. */
  const offerWholeSchoolFrame = () => {
    setEditing(null);
    setForm({
      ...EMPTY_FORM,
      minGradeLevel: 0,
      maxGradeLevel: 12,
      dayOfWeek: EVERY_DAY,
      startTime: "08:00",
      endTime: "18:00",
    });
    setDialogOpen(true);
  };

  const submit = async () => {
    const body = {
      minGradeLevel: form.minGradeLevel,
      maxGradeLevel: form.maxGradeLevel,
      dayOfWeek: form.dayOfWeek === EVERY_DAY ? null : Number(form.dayOfWeek),
      startTime: form.startTime,
      endTime: form.endTime,
      // A cleared field means no corridor, and Number("") is 0. An explicit
      // empty-check was written here first and removed: it is a branch no test
      // can tell from this one, because the input is type=number and cannot
      // hold anything Number() would read as NaN.
      changeoverMinutes: Number(form.changeoverMinutes),
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

  /**
   * The row this form would collide with, if any.
   *
   * One frame per stage per weekday, enforced by a unique index — so without
   * this the second save comes back as a database conflict the admin cannot
   * read. Saying it beside the fields, before the button is pressed, points at
   * the row they probably meant to edit.
   */
  const duplicateOf = (frames ?? []).find(
    (frame) =>
      frame.id !== editing?.id &&
      frame.minGradeLevel === form.minGradeLevel &&
      frame.maxGradeLevel === form.maxGradeLevel &&
      (frame.dayOfWeek === null ? EVERY_DAY : String(frame.dayOfWeek)) === form.dayOfWeek,
  );

  const formValid = form.startTime < form.endTime && duplicateOf === undefined;

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
      ) : !frames || frames.length === 0 ? (
        <EmptyState
          icon={CalendarRange}
          title={tCommon("noResults")}
          description={t("empty")}
          /*
            A school with no ramtid cannot write a changeover at all, because
            the number lives on a frame. Rather than a fourth table for one
            integer, the offer is here: one click makes the whole-school frame
            the deployment grid already assumes, and the corridor is then one
            field away from where the admin is standing.
          */
          action={
            <Button variant="outline" onClick={offerWholeSchoolFrame}>
              {t("offerWholeSchool")}
            </Button>
          }
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
                  <TableHead className="w-24 text-right text-foreground">
                    {tCommon("actions")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {frames.map((frame) => (
                  <TableRow key={frame.id}>
                    <TableCell className="font-medium">
                      {spanLabel(frame.minGradeLevel, frame.maxGradeLevel)}
                    </TableCell>
                    <TableCell>
                      {frame.dayOfWeek === null ? (
                        <Badge variant="secondary">{t("everyDay")}</Badge>
                      ) : (
                        tDays(String(frame.dayOfWeek))
                      )}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {formatTime(frame.startTime)}–{formatTime(frame.endTime)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openEdit(frame)}
                        aria-label={tCommon("edit")}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setDeleting(frame)}
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
            The rows above are what the school typed; this is what they mean.
            Frames reaching the same stage all apply at once, so a weekday row
            silently narrows an every-day one — correct, and impossible to see
            from a list. Reading the result back is what turns the rule from
            something to remember into something to look at.
          */}
          <section aria-labelledby="ramtider-vecka" className="mt-8">
            <h2 id="ramtider-vecka" className="text-lg font-semibold">
              {t("effectiveTitle")}
            </h2>
            <p className="mb-3 text-sm text-muted-foreground">{t("effectiveHint")}</p>
            <p className="mb-3 max-w-prose text-sm text-muted-foreground">{t("overlapHint")}</p>
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
                        // The same function conflicts.ts and gaps.ts read, so
                        // what this cell says is what the app will do — not a
                        // second implementation that can disagree with it.
                        const window = frameWindow(frames, span, day);
                        return (
                          <TableCell key={day} className="tabular-nums">
                            {window === null ? (
                              <Badge variant="destructive">{t("closed")}</Badge>
                            ) : window.startMinutes === 0 && window.endMinutes === 24 * 60 ? (
                              <span className="text-muted-foreground">{t("wholeDay")}</span>
                            ) : (
                              `${clock(window.startMinutes)}–${clock(window.endMinutes)}`
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? t("edit") : t("add")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* No "every year" here: a ramtid without a stage is a window the
                solver cannot place anybody in, and the API refuses one. */}
            <GradeSpanField
              label={t("gradeSpan")}
              toLabel={`${t("gradeSpan")} – ${tCommon("to")}`}
              min={form.minGradeLevel}
              max={form.maxGradeLevel}
              onChange={({ min, max }) =>
                setForm({ ...form, minGradeLevel: min, maxGradeLevel: max })
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
                  {/* First, because it is the row a school writes first: the
                      week as a whole, then the days that differ from it. */}
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
                <Label htmlFor="ramtid-start">{t("startTime")}</Label>
                <Input
                  id="ramtid-start"
                  type="time"
                  value={form.startTime}
                  onChange={(event) => setForm({ ...form, startTime: event.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ramtid-slut">{t("endTime")}</Label>
                <Input
                  id="ramtid-slut"
                  type="time"
                  value={form.endTime}
                  onChange={(event) => setForm({ ...form, endTime: event.target.value })}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ramtid-kortege">{t("changeover")}</Label>
              <Input
                id="ramtid-kortege"
                type="number"
                min={0}
                max={60}
                value={form.changeoverMinutes}
                onChange={(event) =>
                  setForm({ ...form, changeoverMinutes: event.target.value })
                }
              />
              <p className="text-sm text-muted-foreground">{t("changeoverHint")}</p>
            </div>

            {duplicateOf ? (
              <p role="status" className="text-sm text-destructive">
                {t("duplicate")}
              </p>
            ) : null}
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
                deleting.dayOfWeek === null ? t("everyDay") : tDays(String(deleting.dayOfWeek))
              } ${formatTime(deleting.startTime)}–${formatTime(deleting.endTime)}`
            : ""
        }
        onConfirm={confirmDelete}
      />
    </div>
  );
}

/** Minutes since midnight as HH:MM, for the computed week. */
function clock(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  return `${String(hours).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
