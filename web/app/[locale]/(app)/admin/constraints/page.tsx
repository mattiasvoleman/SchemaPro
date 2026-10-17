"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import {
  useAcademicYears,
  useConstraints,
  useCrudMutations,
  useGroups,
  usePeople,
  useRooms,
} from "@/lib/queries";
import type {
  AvailabilityConstraint,
  ConstraintResource,
  ConstraintType,
} from "@/lib/types";
import { cn, formatTime } from "@/lib/utils";
import { groupLabel } from "@/lib/year-scope";
import { NextStep } from "@/components/layout/next-step";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { LunchSettingsCard } from "@/components/schedule/lunch-settings-card";
import { RoomPreferencesCard } from "@/components/schedule/room-preferences-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DateField } from "@/components/ui/date-field";
import { Badge } from "@/components/ui/badge";
import { FormField } from "@/components/ui/form-field";
import { GradeSpanField } from "@/components/ui/grade-span-field";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { LoadError } from "@/components/ui/load-error";
import { RowActions } from "@/components/ui/row-actions";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const RESOURCES: ConstraintResource[] = [
  "TEACHER",
  "ROOM",
  "STUDENT_GROUP",
  "GRADE_LEVEL",
];
const TYPES: ConstraintType[] = ["UNAVAILABLE", "PREFERRED_FREE", "PREFERRED_BUSY"];
const DAYS = [1, 2, 3, 4, 5, 6, 7] as const;

/** The inner-table cells: compact rows, the first column flush with the card's padding. */
const INNER_TH = "h-auto py-1.5 pr-3 text-xs";
const INNER_TD = "py-1.5 pr-3";

interface ConstraintForm {
  resourceType: ConstraintResource;
  resourceId: string;
  /** Year bounds for a GRADE_LEVEL rule; ignored for every other kind. */
  minGradeLevel: number;
  maxGradeLevel: number;
  mode: "recurring" | "date";
  dayOfWeek: string;
  date: string;
  startTime: string;
  endTime: string;
  type: ConstraintType;
  reason: string;
}

const EMPTY_FORM: ConstraintForm = {
  resourceType: "TEACHER",
  resourceId: "",
  minGradeLevel: 4,
  maxGradeLevel: 6,
  mode: "recurring",
  dayOfWeek: "1",
  date: "",
  startTime: "08:00",
  endTime: "16:00",
  type: "UNAVAILABLE",
  reason: "",
};

export default function ConstraintsPage() {
  const t = useTranslations("constraints");
  const tCommon = useTranslations("common");
  const tTypes = useTranslations("constraintTypes");
  const tDays = useTranslations("days");
  const tNav = useTranslations("nav");
  const { data: constraints, isLoading, isError } = useConstraints();
  const { data: people } = usePeople();
  const { data: rooms } = useRooms();
  const { data: groups } = useGroups();
  // Groups of every year, each named with its year unless it is the active
  // one's: class rules are written for next year's classes in spring, before
  // that year is active, so a filter would hide them — but between a
  // rollover and its activation every class name exists twice.
  const { data: years } = useAcademicYears();
  const activeYearId = years?.find((year) => year.isActive)?.id ?? null;

  const mutations = useCrudMutations<{
    resourceType: ConstraintResource;
    userId?: string | null;
    roomId?: string | null;
    studentGroupId?: string | null;
    dayOfWeek?: number | null;
    date?: string | null;
    startTime: string;
    endTime: string;
    type: ConstraintType;
    reason?: string | null;
  }>("/api/v1/availability-constraints", [["constraints"]]);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AvailabilityConstraint | null>(null);
  const [deleting, setDeleting] = useState<AvailabilityConstraint | null>(null);
  const [form, setForm] = useState<ConstraintForm>(EMPTY_FORM);

  const teachers = (people ?? []).filter((person) => person.role === "TEACHER");

  const resourceOptions = (resourceType: ConstraintResource) => {
    switch (resourceType) {
      case "TEACHER":
        return teachers.map((teacher) => ({
          id: teacher.id,
          label: `${teacher.firstName} ${teacher.lastName}`,
        }));
      case "ROOM":
        return (rooms ?? []).map((room) => ({ id: room.id, label: room.name }));
      case "STUDENT_GROUP":
        return (groups ?? []).map((group) => ({
          id: group.id,
          label: groupLabel(group, years, activeYearId),
        }));
      case "GRADE_LEVEL":
        // A year range names nothing in any table, so there is no list to pick
        // from — the form shows two year selects instead of this one.
        return [];
    }
  };

  const resourceName = (constraint: AvailabilityConstraint): string => {
    if (constraint.userId) {
      const teacher = teachers.find((person) => person.id === constraint.userId);
      return teacher ? `${teacher.firstName} ${teacher.lastName}` : "—";
    }
    if (constraint.roomId) {
      return rooms?.find((room) => room.id === constraint.roomId)?.name ?? "—";
    }
    if (constraint.studentGroupId) {
      const group = groups?.find((candidate) => candidate.id === constraint.studentGroupId);
      return group ? groupLabel(group, years, activeYearId) : "—";
    }
    if (constraint.resourceType === "GRADE_LEVEL") {
      return gradeRangeLabel(constraint.minGradeLevel, constraint.maxGradeLevel);
    }
    return "—";
  };

  const resourceLabel = (resourceType: ConstraintResource): string => {
    switch (resourceType) {
      case "TEACHER":
        return t("resourceTeacher");
      case "ROOM":
        return t("resourceRoom");
      case "STUDENT_GROUP":
        return t("resourceGroup");
      case "GRADE_LEVEL":
        return t("resourceGrade");
    }
  };

  /** "Åk 4-6", "Åk 5", "Åk 4 och uppåt" — whichever bounds the rule carries. */
  const gradeRangeLabel = (min: number | null, max: number | null): string => {
    if (min !== null && max !== null) {
      return min === max ? t("gradeOne", { grade: min }) : t("gradeRange", { min, max });
    }
    if (min !== null) return t("gradeFrom", { min });
    if (max !== null) return t("gradeUpTo", { max });
    return "—";
  };

  /** "Måndag" or the date — when a rule applies. */
  const whenLabel = (constraint: AvailabilityConstraint): string =>
    constraint.date ??
    (constraint.dayOfWeek !== null ? tDays(String(constraint.dayOfWeek)) : "—");

  /**
   * The name a row's buttons carry: who, and when. One teacher often has
   * several rules, so "Redigera Karin Ek" twice down a column would name
   * nothing a screen reader could tell apart.
   */
  const rowName = (constraint: AvailabilityConstraint): string =>
    `${resourceName(constraint)}, ${whenLabel(constraint)} ${formatTime(constraint.startTime)}–${formatTime(constraint.endTime)}`;

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (constraint: AvailabilityConstraint) => {
    setEditing(constraint);
    setForm({
      resourceType: constraint.resourceType,
      resourceId:
        constraint.userId ?? constraint.roomId ?? constraint.studentGroupId ?? "",
      minGradeLevel: constraint.minGradeLevel ?? 4,
      maxGradeLevel: constraint.maxGradeLevel ?? 6,
      mode: constraint.date ? "date" : "recurring",
      dayOfWeek: String(constraint.dayOfWeek ?? 1),
      date: constraint.date ?? "",
      startTime: formatTime(constraint.startTime),
      endTime: formatTime(constraint.endTime),
      type: constraint.type,
      reason: constraint.reason ?? "",
    });
    setDialogOpen(true);
  };

  const submit = async () => {
    const body = {
      resourceType: form.resourceType,
      userId: form.resourceType === "TEACHER" ? form.resourceId : null,
      roomId: form.resourceType === "ROOM" ? form.resourceId : null,
      studentGroupId: form.resourceType === "STUDENT_GROUP" ? form.resourceId : null,
      // Sent only for the kind that uses them: the API refuses a year bound on
      // a rule aimed at a teacher, and rightly so.
      minGradeLevel: form.resourceType === "GRADE_LEVEL" ? form.minGradeLevel : null,
      maxGradeLevel: form.resourceType === "GRADE_LEVEL" ? form.maxGradeLevel : null,
      dayOfWeek: form.mode === "recurring" ? Number(form.dayOfWeek) : null,
      date: form.mode === "date" ? form.date : null,
      startTime: form.startTime,
      endTime: form.endTime,
      type: form.type,
      reason: form.reason.trim() || null,
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

  const formValid =
    // A year range names no resource, so requiring an id here would leave the
    // save button permanently disabled for exactly the rule this page gained
    // the year selects to write.
    (form.resourceType === "GRADE_LEVEL" || form.resourceId !== "") &&
    form.startTime < form.endTime &&
    (form.mode === "recurring" || form.date !== "");

  const saving = mutations.create.isPending || mutations.update.isPending;

  return (
    <Page>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Button data-writes="PLANERING" onClick={openCreate}>
            <Plus aria-hidden="true" />
            {t("addConstraint")}
          </Button>
        }
      />

      {/*
        Four blocks with four different jobs, each a section with its own h2 —
        the rules that say who is away, the school-wide rules (#skolregler, the
        anchor Generera schema and Lunchsittningar link to), the locks and the
        wishes. Locks above wishes: the absolute rule is read first, and a
        school scanning the page should meet the thing that can refuse a week
        before the thing that only nudges it.
      */}
      <SectionCard id="begransningar" title={t("listTitle")}>
        {isError && constraints !== undefined ? (
          // A failed refetch keeps the list as last read, with this above it.
          <LoadError variant="inline" title={t("loadFailed")} hint={tCommon("refetchFailedHint")} />
        ) : null}
        {isLoading ? (
          <div aria-busy="true">
            <Skeleton className="h-24 w-full" />
          </div>
        ) : isError && constraints === undefined ? (
          /*
            Not the empty sentence: "no constraints" is a claim that everyone is
            always available, and a failed request is not evidence of it.
          */
          <LoadError variant="inline" title={t("loadFailed")} hint={t("loadFailedHint")} />
        ) : !constraints || constraints.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          /*
            A table inside its section: no frame of its own (the card is the
            frame), cells flush with the card's padding. On a phone the kind
            and the reason step aside — who, which day, what time and the row's
            buttons are what a row is read by.
          */
          <div className="overflow-x-auto">
            <Table>
              <caption className="sr-only">{t("tableCaption")}</caption>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead scope="col" className={cn(INNER_TH, "pl-0")}>
                    {t("resource")}
                  </TableHead>
                  <TableHead scope="col" className={INNER_TH}>
                    {tCommon("name")}
                  </TableHead>
                  <TableHead scope="col" className={INNER_TH}>
                    {t("day")}
                  </TableHead>
                  <TableHead scope="col" className={INNER_TH}>
                    {tCommon("time")}
                  </TableHead>
                  <TableHead scope="col" className={cn(INNER_TH, "hidden sm:table-cell")}>
                    {tCommon("type")}
                  </TableHead>
                  <TableHead scope="col" className={cn(INNER_TH, "hidden sm:table-cell")}>
                    {t("reason")}
                  </TableHead>
                  <TableHead scope="col" className={cn(INNER_TH, "w-24 pr-0 text-right")}>
                    {tCommon("actions")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {constraints.map((constraint) => (
                  <TableRow key={constraint.id}>
                    <TableCell className={cn(INNER_TD, "pl-0")}>
                      <Badge variant="secondary">{resourceLabel(constraint.resourceType)}</Badge>
                    </TableCell>
                    <TableCell className={cn(INNER_TD, "font-medium")}>{resourceName(constraint)}</TableCell>
                    <TableCell className={cn(INNER_TD, "whitespace-nowrap tabular-nums")}>
                      {whenLabel(constraint)}
                    </TableCell>
                    <TableCell className={cn(INNER_TD, "whitespace-nowrap tabular-nums")}>
                      {formatTime(constraint.startTime)}–{formatTime(constraint.endTime)}
                    </TableCell>
                    <TableCell className={cn(INNER_TD, "hidden sm:table-cell")}>
                      {/*
                        A kind of rule, not a failure: secondary for the hard
                        one, outline for the two wishes (lib/status-variants).
                        Red on every row of a list of rules said "error" where
                        nothing had gone wrong.
                      */}
                      <Badge
                        variant={constraint.type === "UNAVAILABLE" ? "secondary" : "outline"}
                      >
                        {tTypes(constraint.type)}
                      </Badge>
                    </TableCell>
                    <TableCell
                      className={cn(INNER_TD, "hidden max-w-40 truncate text-muted-foreground sm:table-cell")}
                    >
                      {constraint.reason ?? "—"}
                    </TableCell>
                    <TableCell className={cn(INNER_TD, "pr-0 text-right")}>
                      {/* Both write (availability-constraints.controller.ts @Area): RowActions takes no attribute. */}
                      <div data-writes="PLANERING" className="contents">
                        <RowActions
                          name={rowName(constraint)}
                          actions={[
                            { label: tCommon("edit"), icon: Pencil, onSelect: () => openEdit(constraint) },
                            { label: tCommon("delete"), icon: Trash2, onSelect: () => setDeleting(constraint) },
                          ]}
                        />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      <LunchSettingsCard />
      <RoomPreferencesCard kind="LOCK" />
      <RoomPreferencesCard kind="WISH" />

      {/* The manual's chain: timplan, timplansposter, tjänstefördelning,
          tillgänglighet — and then the schedule is generated. */}
      <div className="flex justify-end">
        <NextStep href="/admin/generate" name={tNav("generate")} />
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? t("editConstraint") : t("addConstraint")}</DialogTitle>
            <DialogDescription>{t("dialogDescription")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
              <FormField id="constraint-resource" label={t("resource")}>
                {(control) => (
                  <Select
                    value={form.resourceType}
                    onValueChange={(value) =>
                      setForm({
                        ...form,
                        resourceType: value as ConstraintResource,
                        resourceId: "",
                      })
                    }
                  >
                    <SelectTrigger {...control}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {RESOURCES.map((resource) => (
                        <SelectItem key={resource} value={resource}>
                          {resourceLabel(resource)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </FormField>
              {form.resourceType === "GRADE_LEVEL" ? (
                /* No "every year": the service refuses a GRADE_LEVEL rule with
                   no bound at all, and one that means the whole school is a
                   rule aimed at something else. */
                <GradeSpanField
                  label={t("gradeSpan")}
                  fromLabel={t("gradeFromLabel")}
                  toLabel={t("gradeToLabel")}
                  min={form.minGradeLevel}
                  max={form.maxGradeLevel}
                  onChange={({ min, max }) =>
                    setForm({ ...form, minGradeLevel: min, maxGradeLevel: max })
                  }
                  hint={t("gradeHint")}
                />
              ) : (
                <FormField id="constraint-resource-id" label={tCommon("name")}>
                  {(control) => (
                    <Select
                      value={form.resourceId || undefined}
                      onValueChange={(value) => setForm({ ...form, resourceId: value })}
                    >
                      <SelectTrigger {...control}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {resourceOptions(form.resourceType).map((option) => (
                          <SelectItem key={option.id} value={option.id}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </FormField>
              )}
            </div>

            <Tabs
              value={form.mode}
              onValueChange={(value) =>
                setForm({ ...form, mode: value as "recurring" | "date" })
              }
            >
              <TabsList className="w-full">
                <TabsTrigger value="recurring" className="flex-1">
                  {t("recurring")}
                </TabsTrigger>
                <TabsTrigger value="date" className="flex-1">
                  {t("specificDate")}
                </TabsTrigger>
              </TabsList>
            </Tabs>

            {form.mode === "recurring" ? (
              <FormField id="constraint-day" label={t("day")}>
                {(control) => (
                  <Select
                    value={form.dayOfWeek}
                    onValueChange={(value) => setForm({ ...form, dayOfWeek: value })}
                  >
                    <SelectTrigger {...control}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DAYS.map((day) => (
                        <SelectItem key={day} value={String(day)}>
                          {tDays(String(day))}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </FormField>
            ) : (
              <FormField id="constraint-date" label={tCommon("date")}>
                <DateField
                  label={tCommon("date")}
                  value={form.date}
                  onChange={(value) => setForm({ ...form, date: value })}
                />
              </FormField>
            )}

            <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
              <FormField id="constraint-start" label={t("startTime")}>
                <Input
                  type="time"
                  value={form.startTime}
                  onChange={(e) => setForm({ ...form, startTime: e.target.value })}
                />
              </FormField>
              <FormField id="constraint-end" label={t("endTime")}>
                <Input
                  type="time"
                  value={form.endTime}
                  onChange={(e) => setForm({ ...form, endTime: e.target.value })}
                />
              </FormField>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 [&>*]:min-w-0">
              <FormField id="constraint-type" label={tCommon("type")}>
                {(control) => (
                  <Select
                    value={form.type}
                    onValueChange={(value) => setForm({ ...form, type: value as ConstraintType })}
                  >
                    <SelectTrigger {...control}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {tTypes(type)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </FormField>
              <FormField id="constraint-reason" label={t("reason")} optional>
                <Input
                  value={form.reason}
                  placeholder={t("reasonPlaceholder")}
                  onChange={(e) => setForm({ ...form, reason: e.target.value })}
                />
              </FormField>
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
        title={tCommon("deleteConfirmTitle", { name: deleting ? rowName(deleting) : "" })}
        description={tCommon("deleteConfirmBody")}
        confirmLabel={tCommon("delete")}
        loading={mutations.remove.isPending}
        onConfirm={confirmDelete}
      />
    </Page>
  );
}
