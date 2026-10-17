"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { CalendarRange, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { useCrudMutations, useFrameTimes } from "@/lib/queries";
import type { FrameTime } from "@/lib/types";
import { clock } from "@/lib/clock";
import { frameWindow } from "@/lib/frame-times";
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
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { FormField } from "@/components/ui/form-field";
import { GradeSpanField } from "@/components/ui/grade-span-field";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { RowActions } from "@/components/ui/row-actions";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCard } from "@/components/ui/table-card";
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
  const { data: frames, isLoading, isError } = useFrameTimes();

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

  const spanLabel = useSpanLabel();

  /** The stages the school has written about, in year order (see stagesOf). */
  const spans = useMemo(() => stagesOf(frames), [frames]);

  /**
   * "Åk 4–6, Alla dagar 08:00–15:00": the row as its buttons and its confirm
   * name it. A comma rather than " · ", which some screen readers read out as
   * "middle dot".
   */
  const rowName = (frame: FrameTime): string =>
    `${spanLabel(frame.minGradeLevel, frame.maxGradeLevel)}, ${
      frame.dayOfWeek === null ? t("everyDay") : tDays(String(frame.dayOfWeek))
    } ${formatTime(frame.startTime)}–${formatTime(frame.endTime)}`;

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

  const saving = mutations.create.isPending || mutations.update.isPending;

  return (
    <Page>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        intro={t("hint")}
        actions={
          <Button data-writes="PLANERING" onClick={openCreate}>
            <Plus aria-hidden="true" />
            {t("add")}
          </Button>
        }
      />

      {isError && frames !== undefined ? (
        // A failed refetch keeps the frames as last read, with this above them.
        <LoadError variant="inline" title={t("loadFailed")} hint={tCommon("refetchFailedHint")} />
      ) : null}

      {isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : isError && frames === undefined ? (
        /*
          Not the empty state: "no frame times" means the whole day is open to
          every stage, and a failed request is not evidence of that.
        */
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      ) : !frames || frames.length === 0 ? (
        <EmptyState
          icon={CalendarRange}
          title={t("emptyTitle")}
          description={t("empty")}
          headingLevel={2}
          /*
            The header's own primary first, as on Ämnen and Salar: the empty
            state offers the same act the header does, so the two filled
            buttons on the page say one thing rather than two. Beside it, the
            shortcut: a school with no ramtid cannot write a changeover at all,
            because the number lives on a frame. Rather than a fourth table for
            one integer, one click makes the whole-school frame the deployment
            grid already assumes, and the corridor is then one field away.
          */
          action={
            <div data-writes="PLANERING" className="flex flex-wrap justify-center gap-2">
              <Button onClick={openCreate}>
                <Plus aria-hidden="true" />
                {t("add")}
              </Button>
              <Button variant="outline" onClick={offerWholeSchoolFrame}>
                {t("offerWholeSchool")}
              </Button>
            </div>
          }
        />
      ) : (
        <>
          <TableCard caption={t("tableCaption")}>
            <TableHeader>
              <TableRow>
                <TableHead scope="col" className="text-foreground">{t("gradeSpan")}</TableHead>
                <TableHead scope="col" className="text-foreground">{t("day")}</TableHead>
                <TableHead scope="col" className="text-foreground">{tCommon("time")}</TableHead>
                <TableHead scope="col" className="w-24 text-right text-foreground">
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
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {formatTime(frame.startTime)}–{formatTime(frame.endTime)}
                  </TableCell>
                  <TableCell className="text-right">
                    {/* Both write (frame-times.controller.ts @Area): RowActions takes no attribute. */}
                    <div data-writes="PLANERING" className="contents">
                      <RowActions
                        name={rowName(frame)}
                        actions={[
                          { label: tCommon("edit"), icon: Pencil, onSelect: () => openEdit(frame) },
                          { label: tCommon("delete"), icon: Trash2, onSelect: () => setDeleting(frame) },
                        ]}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </TableCard>

          {/*
            The rows above are what the school typed; this is what they mean.
            Frames reaching the same stage all apply at once, so a weekday row
            silently narrows an every-day one — correct, and impossible to see
            from a list. Reading the result back is what turns the rule from
            something to remember into something to look at.
          */}
          <StageWeekMatrix
            id="ramtider-vecka"
            title={t("effectiveTitle")}
            description={
              <>
                <p>{t("effectiveHint")}</p>
                <p>{t("overlapHint")}</p>
              </>
            }
            stageLabel={t("gradeSpan")}
            spans={spans}
            renderCell={(span, day) => {
              // The same function conflicts.ts and gaps.ts read, so what this
              // cell says is what the app will do — not a second
              // implementation that can disagree with it.
              const window = frameWindow(frames, span, day);
              if (window === null) return <Badge variant="destructive">{t("closed")}</Badge>;
              if (window.startMinutes === 0 && window.endMinutes === 24 * 60) {
                return <span className="text-muted-foreground">{t("wholeDay")}</span>;
              }
              return `${clock(window.startMinutes)}–${clock(window.endMinutes)}`;
            }}
          />
        </>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? t("edit") : t("add")}</DialogTitle>
            <DialogDescription>{t("dialogDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {/* No "every year" here: a ramtid without a stage is a window the
                solver cannot place anybody in, and the API refuses one. */}
            <GradeSpanField
              label={t("gradeSpan")}
              fromLabel={t("gradeFromLabel")}
              toLabel={t("gradeToLabel")}
              min={form.minGradeLevel}
              max={form.maxGradeLevel}
              onChange={({ min, max }) =>
                setForm({ ...form, minGradeLevel: min, maxGradeLevel: max })
              }
            />

            <FormField id="ramtid-dag" label={t("day")}>
              {(control) => (
                <Select
                  value={form.dayOfWeek}
                  onValueChange={(value) => setForm({ ...form, dayOfWeek: value })}
                >
                  <SelectTrigger {...control}>
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
              )}
            </FormField>

            <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
              <FormField id="ramtid-start" label={t("startTime")}>
                <Input
                  type="time"
                  value={form.startTime}
                  onChange={(event) => setForm({ ...form, startTime: event.target.value })}
                />
              </FormField>
              <FormField id="ramtid-slut" label={t("endTime")}>
                <Input
                  type="time"
                  value={form.endTime}
                  onChange={(event) => setForm({ ...form, endTime: event.target.value })}
                />
              </FormField>
            </div>

            <FormField id="ramtid-kortege" label={t("changeover")} hint={t("changeoverHint")}>
              <Input
                type="number"
                min={0}
                max={60}
                value={form.changeoverMinutes}
                onChange={(event) =>
                  setForm({ ...form, changeoverMinutes: event.target.value })
                }
              />
            </FormField>

            {/*
              role=status rather than alert: it appears and disappears as the
              admin moves the day and the years, and an assertive interruption
              on every pick would be louder than the problem.
            */}
            {duplicateOf ? (
              <Notice tone="destructive" role="status">
                {t("duplicate")}
              </Notice>
            ) : null}
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
        description={deleting ? t("deleteBody", { row: rowName(deleting) }) : undefined}
        confirmLabel={tCommon("delete")}
        loading={mutations.remove.isPending}
        onConfirm={confirmDelete}
      />
    </Page>
  );
}
