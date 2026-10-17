"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Link } from "@/i18n/navigation";
import { Loader2, Pencil, Plus, Trash2, UtensilsCrossed } from "lucide-react";
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
import { clock } from "@/lib/clock";
import { formatTime, timeToMinutes } from "@/lib/utils";
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

interface ServingForm {
  minGradeLevel: number;
  maxGradeLevel: number;
  dayOfWeek: string;
  startTime: string;
  endTime: string;
  seats: string;
}

const EMPTY_FORM: ServingForm = {
  minGradeLevel: 4,
  maxGradeLevel: 6,
  dayOfWeek: EVERY_DAY,
  startTime: "11:00",
  endTime: "11:40",
  seats: "",
};

export default function LunchServingsPage() {
  const t = useTranslations("lunchServings");
  const tCommon = useTranslations("common");
  const tDays = useTranslations("days");
  const { data: servings, isLoading, isError } = useLunchServings();
  const { data: lunchSettings, isError: lunchFailed } = useLunchSettings();
  const { activeYear, isLoading: yearLoading, isError: yearsFailed } = useActiveYear();
  const {
    data: sittings,
    isLoading: sittingsLoading,
    isError: sittingsFailed,
  } = useLunchSittings(activeYear?.id ?? null);
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

  const spanLabel = useSpanLabel();

  /** The stages the school has written about, in year order (see stagesOf). */
  const spans = useMemo(() => stagesOf(servings), [servings]);

  /**
   * "Åk 4–6, Alla dagar 11:00–11:40": the row as its buttons and its confirm
   * name it. A comma rather than " · ", which some screen readers read out as
   * "middle dot".
   */
  const rowName = (serving: LunchServing): string =>
    `${spanLabel(serving.minGradeLevel, serving.maxGradeLevel)}, ${
      serving.dayOfWeek === null ? t("everyDay") : tDays(String(serving.dayOfWeek))
    } ${formatTime(serving.startTime)}–${formatTime(serving.endTime)}`;

  /** Group names for the kitchen's list; an id there would be useless. */
  const groupNameOf = useMemo(
    () => new Map((groups ?? []).map((group) => [group.id, group.name])),
    [groups],
  );

  /** The break's length, which decides whether a sitting is long enough. */
  const lunchMinutes = lunchSettings?.lunchEnabled
    ? (lunchSettings.lunchMinutes ?? null)
    : null;
  /**
   * The lunch settings have ANSWERED — null (never set) or a row. The query
   * maps an empty reply to null, so undefined means only "in flight" or
   * "failed", and neither is grounds for telling the admin lunch is undefined.
   */
  const lunchKnown = lunchSettings !== undefined;

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (serving: LunchServing) => {
    setEditing(serving);
    setForm({
      minGradeLevel: serving.minGradeLevel,
      maxGradeLevel: serving.maxGradeLevel,
      dayOfWeek: serving.dayOfWeek === null ? EVERY_DAY : String(serving.dayOfWeek),
      startTime: formatTime(serving.startTime),
      endTime: formatTime(serving.endTime),
      seats: serving.seats === null ? "" : String(serving.seats),
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

      {/*
        A sitting is a window for a meal whose length lives in the school
        rules. With no lunch defined the rows here constrain nothing at all,
        and a page that let an admin write six of them without saying so would
        be a page that wasted an afternoon.

        Said only once the rules have ANSWERED. It used to show while they were
        still loading and when they had failed, telling a school with a perfectly
        good lunch that it had none.
      */}
      {lunchKnown && lunchMinutes === null ? (
        <Notice
          tone="warning"
          action={
            <Button variant="outline" size="sm" asChild>
              <Link href="/admin/constraints#skolregler">{t("lunchLink")}</Link>
            </Button>
          }
        >
          {t("noLunch")}
        </Notice>
      ) : !lunchKnown && lunchFailed ? (
        <LoadError variant="inline" title={t("lunchLoadFailed")} hint={t("lunchLoadFailedHint")} />
      ) : null}

      {isError && servings !== undefined ? (
        // A failed refetch keeps the sittings as last read, with this above them.
        <LoadError variant="inline" title={t("loadFailed")} hint={tCommon("refetchFailedHint")} />
      ) : null}

      {isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : isError && servings === undefined ? (
        /*
          Not the empty state: "no sittings" means every stage may eat at once,
          and a failed request is not evidence of that.
        */
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} headingLevel={2} />
      ) : !servings || servings.length === 0 ? (
        <EmptyState
          icon={UtensilsCrossed}
          title={t("emptyTitle")}
          description={t("empty")}
          headingLevel={2}
        />
      ) : (
        <>
          <TableCard caption={t("tableCaption")}>
            <TableHeader>
              <TableRow>
                <TableHead scope="col" className="text-foreground">{t("gradeSpan")}</TableHead>
                <TableHead scope="col" className="text-foreground">{t("day")}</TableHead>
                <TableHead scope="col" className="text-foreground">{tCommon("time")}</TableHead>
                <TableHead scope="col" className="text-right text-foreground">{t("seats")}</TableHead>
                <TableHead scope="col" className="w-24 text-right text-foreground">
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
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {formatTime(serving.startTime)}–{formatTime(serving.endTime)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {serving.seats ?? (
                      <span className="text-muted-foreground">{t("seatsPlaceholder")}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {/* Both write (lunch-servings.controller.ts @Area): RowActions takes no attribute. */}
                    <div data-writes="PLANERING" className="contents">
                      <RowActions
                        name={rowName(serving)}
                        actions={[
                          { label: tCommon("edit"), icon: Pencil, onSelect: () => openEdit(serving) },
                          { label: tCommon("delete"), icon: Trash2, onSelect: () => setDeleting(serving) },
                        ]}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </TableCard>

          {/*
            The rows above are what the school typed; this is the flow they make.
            Sittings reaching one stage add up and a weekday row shadows the
            every-day one — correct, and impossible to read off a list. Computed
            with servingsFor, the same function the app's own checks use, rather
            than a second implementation that could disagree with the solver.
          */}
          <StageWeekMatrix
            id="sittningar-vecka"
            title={t("windowsTitle")}
            description={
              <>
                <p>{t("windowsHint")}</p>
                <p>{t("overlapHint")}</p>
              </>
            }
            stageLabel={t("gradeSpan")}
            spans={spans}
            renderCell={(span, day) => {
              const open = servingsFor(servings, span, day);
              if (open.length === 0) {
                return <span className="text-muted-foreground">{t("flowOpen")}</span>;
              }
              return (
                <div className="flex flex-col gap-1">
                  {open.map((serving) => {
                    const minutes =
                      timeToMinutes(serving.endTime) - timeToMinutes(serving.startTime);
                    const tooShort = lunchMinutes !== null && minutes < lunchMinutes;
                    return (
                      <span key={serving.id} className="flex flex-wrap items-center gap-2">
                        <span>
                          {formatTime(serving.startTime)}–{formatTime(serving.endTime)}
                        </span>
                        {tooShort ? (
                          <Badge variant="destructive">
                            {t("tooShort", { minutes: lunchMinutes })}
                          </Badge>
                        ) : null}
                      </span>
                    );
                  })}
                </div>
              );
            }}
          />
        </>
      )}

      {/*
        What the solver actually did, as opposed to what the school asked for.
        The table above is the rule; this is the day — one page the kitchen
        can print. It exists only after a generation run, so until then the
        section says so in a sentence: a printable list with nothing on it
        would invite somebody to take it to the kitchen.
      */}
      <section aria-labelledby="kitchen-flow" className="space-y-3">
        <div className="space-y-1">
          <h2 id="kitchen-flow" className="text-base font-semibold">
            {t("flowTitle")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("flowSubtitle")}</p>
        </div>
        {sittingsFailed && sittings !== undefined ? (
          <LoadError variant="inline" title={t("flowLoadFailed")} hint={tCommon("refetchFailedHint")} />
        ) : null}
        {/*
          The flow is the active year's. Without one the request is never made,
          so a school whose years failed, or that has none active, would read
          "no sittings yet — generate a schedule": a page that could not know.
        */}
        {yearLoading || sittingsLoading ? (
          <div aria-busy="true">
            <Skeleton className="h-24 w-full" />
          </div>
        ) : !activeYear && yearsFailed ? (
          <LoadError variant="inline" title={t("flowLoadFailed")} hint={t("flowYearsLoadFailedHint")} />
        ) : !activeYear ? (
          <p className="text-sm text-muted-foreground">{t("flowNoYear")}</p>
        ) : sittingsFailed && sittings === undefined ? (
          <LoadError variant="inline" title={t("flowLoadFailed")} hint={t("flowLoadFailedHint")} />
        ) : !sittings || sittings.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("flowEmpty")}</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {WEEKDAYS.map((day) => {
              const waves = lunchFlow(sittings, day);
              if (waves.length === 0) return null;
              return (
                <div key={day} className="space-y-2 rounded-lg border bg-card p-4">
                  <div className="space-y-1">
                    <h3 className="text-sm font-semibold">{tDays(String(day))}</h3>
                    <p className="text-sm text-muted-foreground">
                      {t("flowTotal", { count: peakSeated(sittings, day) })}
                    </p>
                  </div>
                  <ol className="space-y-1 text-sm">
                    {waves.map((wave) => (
                      <li key={wave.startMinutes} className="flex justify-between gap-3">
                        <span className="whitespace-nowrap tabular-nums">
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
        )}
      </section>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? t("edit") : t("add")}</DialogTitle>
            <DialogDescription>{t("dialogDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {/* No "every year": a sitting is a stage's turn at the tables, and
                one covering the whole school at once is the thing the flow
                below exists to warn about. The API refuses it outright. */}
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

            <FormField id="sittning-dag" label={t("day")}>
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
              <FormField id="sittning-start" label={t("startTime")}>
                <Input
                  type="time"
                  value={form.startTime}
                  onChange={(event) => setForm({ ...form, startTime: event.target.value })}
                />
              </FormField>
              <FormField id="sittning-slut" label={t("endTime")}>
                <Input
                  type="time"
                  value={form.endTime}
                  onChange={(event) => setForm({ ...form, endTime: event.target.value })}
                />
              </FormField>
            </div>

            <FormField id="sittning-platser" label={t("seats")} hint={t("seatsHint")}>
              <Input
                type="number"
                min={1}
                placeholder={t("seatsPlaceholder")}
                value={form.seats}
                onChange={(event) => setForm({ ...form, seats: event.target.value })}
              />
            </FormField>
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
