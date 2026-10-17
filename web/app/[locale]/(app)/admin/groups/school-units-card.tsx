"use client";

/*
 * Skolenheter: the Skolverket units the school is made of (migration
 * 20261031090000), each with its skolenhetskod, its skolformer and the
 * årskurser it holds. The span is the map: a class belongs to the unit whose
 * årskurser hold its own (web/lib/school-units.ts), so the table shows which
 * of this year's classes each unit has, and a class no span holds is named.
 *
 * A unit linked to the SS12000 source has its name, code and skolformer
 * from the register: the dialog shows them read-only and the gateway refuses
 * a change (SCHOOL_UNIT_FROM_SOURCE). The span is the school's either way.
 *
 * On Klasser rather than a page of its own: the units are the classes'
 * frame, set up once, and a menu row would cost every route bytes.
 */

import { useMemo, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { ApiError } from "@/lib/api";
import { useCrudMutations } from "@/lib/queries";
import {
  SCHOOL_UNIT_TYPES,
  gradeOutsideUnits,
  normaliseUnitCode,
  spansOverlap,
  unitForGrade,
  type SchoolUnit,
  type SchoolUnitType,
} from "@/lib/school-units";
import type { StudentGroup } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { LoadError } from "@/components/ui/load-error";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";
import { RowActions } from "@/components/ui/row-actions";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TableCard } from "@/components/ui/table-card";
import { SCHOOL_UNITS_KEY, useSchoolUnits } from "./use-school-units";

// F–10, in the nine-year numbering a unit's span is stated in.
const GRADES = Array.from({ length: 11 }, (_, grade) => grade);

interface UnitForm {
  name: string;
  code: string;
  schoolTypes: SchoolUnitType[];
  gradeFrom: string;
  gradeTo: string;
}

const EMPTY: UnitForm = { name: "", code: "", schoolTypes: [], gradeFrom: "", gradeTo: "" };

interface UnitBody {
  name: string;
  code: string | null;
  schoolTypes: SchoolUnitType[];
  gradeFrom: number | null;
  gradeTo: number | null;
}

export function SchoolUnitsCard({ classes }: { classes: StudentGroup[] }) {
  const t = useTranslations("schoolUnits");
  const tCommon = useTranslations("common");
  const tGrades = useTranslations("grades");
  const units = useSchoolUnits();
  const mutations = useCrudMutations<UnitBody>("/api/v1/school-units", [SCHOOL_UNITS_KEY]);
  const [editing, setEditing] = useState<SchoolUnit | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<UnitForm>(EMPTY);
  const [deleting, setDeleting] = useState<SchoolUnit | null>(null);
  // A refused save stays in the form, beside the fields, until the next try.
  const [formError, setFormError] = useState<string | null>(null);
  // Errors a field has not yet been given the chance to fix show on the first save.
  const [attempted, setAttempted] = useState(false);

  const list = useMemo(() => units.data ?? [], [units.data]);
  const grade = (value: number) => tGrades("grade", { grade: value });
  const span = (unit: Pick<SchoolUnit, "gradeFrom" | "gradeTo">) =>
    unit.gradeFrom === null || unit.gradeTo === null
      ? "–"
      : unit.gradeFrom === unit.gradeTo
        ? grade(unit.gradeFrom)
        : t("span", { from: grade(unit.gradeFrom), to: grade(unit.gradeTo) });

  // This year's classes by the unit their årskurs puts them in.
  const classesOf = useMemo(() => {
    const out = new Map<string, string[]>();
    for (const klass of classes) {
      const unit = unitForGrade(list, klass.gradeLevel);
      if (unit) out.set(unit.id, [...(out.get(unit.id) ?? []), klass.name]);
    }
    return out;
  }, [classes, list]);
  const outside = useMemo(
    () => classes.filter((klass) => klass.gradeLevel !== null && gradeOutsideUnits(list, klass.gradeLevel)),
    [classes, list],
  );

  const startCreate = () => {
    setEditing(null);
    setForm(EMPTY);
    setFormError(null);
    setAttempted(false);
    setOpen(true);
  };
  const startEdit = (unit: SchoolUnit) => {
    setEditing(unit);
    setFormError(null);
    setAttempted(false);
    setForm({
      name: unit.name,
      code: unit.code ?? "",
      schoolTypes: [...unit.schoolTypes],
      gradeFrom: unit.gradeFrom === null ? "" : String(unit.gradeFrom),
      gradeTo: unit.gradeTo === null ? "" : String(unit.gradeTo),
    });
    setOpen(true);
  };

  const fromSource = editing?.fromSource ?? false;
  const code = form.code.trim() === "" ? null : normaliseUnitCode(form.code);
  const codeInvalid = form.code.trim() !== "" && code === null;
  const gradeFrom = form.gradeFrom === "" ? null : Number(form.gradeFrom);
  const gradeTo = form.gradeTo === "" ? null : Number(form.gradeTo);
  const spanIncomplete = (gradeFrom === null) !== (gradeTo === null);
  const overlapping =
    gradeFrom !== null && gradeTo !== null
      ? list.find((unit) => unit.id !== editing?.id && spansOverlap(unit, { gradeFrom, gradeTo }))
      : undefined;
  const nameMissing = form.name.trim() === "";
  const codeTaken = code !== null && list.some((unit) => unit.id !== editing?.id && unit.code === code);
  const invalid = nameMissing || codeInvalid || codeTaken || spanIncomplete || overlapping !== undefined;
  const pending = mutations.create.isPending || mutations.update.isPending;

  const errorText = (error: unknown) =>
    error instanceof ApiError && error.code && t.has(`errors.${error.code}`)
      ? t(`errors.${error.code}`)
      : error instanceof Error
        ? error.message
        : tCommon("error");

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setAttempted(true);
    setFormError(null);
    if (invalid) return;
    const body: UnitBody = {
      name: form.name.trim(),
      code,
      schoolTypes: form.schoolTypes,
      gradeFrom,
      gradeTo,
    };
    try {
      if (editing) {
        // Only the span is the school's on a unit from the register.
        await mutations.update.mutateAsync(
          editing.fromSource ? { id: editing.id, gradeFrom, gradeTo } : { id: editing.id, ...body },
        );
        toast.success(t("saved", { name: body.name }));
      } else {
        await mutations.create.mutateAsync(body);
        toast.success(t("created", { name: body.name }));
      }
      setOpen(false);
    } catch (error) {
      setFormError(errorText(error));
    }
  };

  const remove = async () => {
    if (!deleting) return;
    try {
      await mutations.remove.mutateAsync(deleting.id);
      toast.success(t("deleted", { name: deleting.name }));
      setDeleting(null);
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const toggleType = (type: SchoolUnitType, on: boolean) =>
    setForm((current) => ({
      ...current,
      schoolTypes: SCHOOL_UNIT_TYPES.filter((entry) =>
        entry === type ? on : current.schoolTypes.includes(entry),
      ),
    }));

  return (
    <SectionCard
      id="school-units"
      title={t("title")}
      description={t("description")}
      action={
        <Button data-writes="PLANERING" type="button" variant="outline" size="sm" onClick={startCreate} disabled={!units.data}>
          <Plus aria-hidden="true" />
          {t("add")}
        </Button>
      }
    >
      {units.isLoading ? (
        <div aria-busy="true">
          <Skeleton className="h-24 w-full" />
        </div>
      ) : units.isError && !units.data ? (
        <LoadError variant="inline" title={t("loadFailed")} hint={t("loadFailedHint")} />
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <div className="space-y-3">
          {units.isError ? <LoadError variant="inline" title={t("loadFailed")} hint={tCommon("refetchFailedHint")} /> : null}
          {outside.length > 0 ? (
            <Notice tone="warning" title={t("outsideTitle")}>
              {t("outside", {
                classes: outside.map((klass) => klass.name).join(", "),
                unit: unitForGrade(list, null)?.name ?? "",
              })}
            </Notice>
          ) : null}
          <TableCard caption={t("caption")} tableClassName="min-w-[44rem]">
            <TableHeader>
              <TableRow>
                <TableHead>{t("columns.name")}</TableHead>
                <TableHead>{t("columns.code")}</TableHead>
                <TableHead>{t("columns.types")}</TableHead>
                <TableHead>{t("columns.span")}</TableHead>
                <TableHead>{t("columns.classes")}</TableHead>
                <TableHead className="w-24 text-right">{tCommon("actions")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((unit) => (
                <TableRow key={unit.id}>
                  <TableCell className="font-medium">
                    <span>{unit.name}</span>
                    {unit.fromSource ? (
                      <Badge variant="outline" className="ml-2">
                        {t("fromSource")}
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell className="tabular-nums">{unit.code ?? "–"}</TableCell>
                  <TableCell>
                    {unit.schoolTypes.length > 0 ? unit.schoolTypes.map((type) => t(`types.${type}`)).join(", ") : "–"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{span(unit)}</TableCell>
                  <TableCell>{(classesOf.get(unit.id) ?? []).join(", ") || "–"}</TableCell>
                  <TableCell className="text-right">
                    {/* Both write (school-units.controller.ts @Area): RowActions takes no attribute. */}
                    <div data-writes="PLANERING" className="contents">
                      <RowActions
                        name={unit.name}
                        actions={[
                          { label: tCommon("edit"), icon: Pencil, onSelect: () => startEdit(unit) },
                          { label: tCommon("delete"), icon: Trash2, onSelect: () => setDeleting(unit) },
                        ]}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </TableCard>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <form onSubmit={save} noValidate>
            <DialogHeader>
              <DialogTitle>{editing ? t("editTitle", { name: editing.name }) : t("addTitle")}</DialogTitle>
              <DialogDescription>{fromSource ? t("fromSourceHint") : t("dialogHint")}</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              {formError ? (
                <Notice tone="destructive" title={t("saveFailed")}>
                  {formError}
                </Notice>
              ) : null}
              {/* The register's own values: read, not written, here. */}
              <FormField
                id="school-unit-name"
                label={t("fields.name")}
                error={!fromSource && nameMissing && (attempted || form.name !== EMPTY.name) ? t("errors.nameMissing") : undefined}
              >
                <Input
                  value={form.name}
                  readOnly={fromSource}
                  className={fromSource ? "bg-muted" : undefined}
                  required
                  maxLength={300}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                />
              </FormField>
              <FormField
                id="school-unit-code"
                label={t("fields.code")}
                optional
                hint={t("fields.codeHint")}
                error={
                  codeInvalid
                    ? t("errors.SCHOOL_UNIT_CODE_INVALID")
                    : codeTaken && !fromSource
                      ? t("errors.SCHOOL_UNIT_CODE_TAKEN")
                      : undefined
                }
              >
                <Input
                  value={form.code}
                  readOnly={fromSource}
                  className={fromSource ? "bg-muted" : undefined}
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={20}
                  onChange={(event) => setForm({ ...form, code: event.target.value })}
                />
              </FormField>
              {fromSource ? (
                <div className="space-y-1.5">
                  <p className="text-sm font-medium">{t("fields.types")}</p>
                  <p className="text-sm">
                    {form.schoolTypes.length > 0 ? form.schoolTypes.map((type) => t(`types.${type}`)).join(", ") : "–"}
                  </p>
                </div>
              ) : (
                <fieldset className="space-y-2">
                  <legend className="text-sm font-medium">{t("fields.types")}</legend>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {SCHOOL_UNIT_TYPES.map((type) => (
                      <label key={type} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          checked={form.schoolTypes.includes(type)}
                          onChange={(event) => toggleType(type, event.target.checked)}
                        />
                        {t(`types.${type}`)}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField id="school-unit-from" label={t("fields.gradeFrom")} optional>
                  <NativeSelect
                    value={form.gradeFrom}
                    onChange={(event) => {
                      const next = event.target.value;
                      setForm((current) => ({
                        ...current,
                        gradeFrom: next,
                        // Both ends or neither, and in order: the end follows.
                        gradeTo:
                          next === ""
                            ? ""
                            : current.gradeTo === "" || Number(current.gradeTo) < Number(next)
                              ? next
                              : current.gradeTo,
                      }));
                    }}
                  >
                    <option value="">{t("fields.noSpan")}</option>
                    {GRADES.map((value) => (
                      <option key={value} value={String(value)}>
                        {grade(value)}
                      </option>
                    ))}
                  </NativeSelect>
                </FormField>
                <FormField
                  id="school-unit-to"
                  label={t("fields.gradeTo")}
                  optional
                  error={
                    overlapping
                      ? t("overlap", { name: overlapping.name })
                      : spanIncomplete
                        ? t("errors.SCHOOL_UNIT_SPAN_INVALID")
                        : undefined
                  }
                >
                  <NativeSelect
                    value={form.gradeTo}
                    disabled={form.gradeFrom === ""}
                    onChange={(event) => setForm({ ...form, gradeTo: event.target.value })}
                  >
                    <option value="">{t("fields.noSpan")}</option>
                    {GRADES.filter((value) => gradeFrom === null || value >= gradeFrom).map((value) => (
                      <option key={value} value={String(value)}>
                        {grade(value)}
                      </option>
                    ))}
                  </NativeSelect>
                </FormField>
              </div>
              <p className="text-sm text-muted-foreground">{t("spanHint")}</p>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {tCommon("cancel")}
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
                {pending ? tCommon("saving") : tCommon("save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) setDeleting(null);
        }}
        title={t("deleteTitle", { name: deleting?.name ?? "" })}
        description={deleting?.fromSource ? t("deleteFromSource") : t("deleteBody")}
        confirmLabel={tCommon("delete")}
        loading={mutations.remove.isPending}
        onConfirm={() => void remove()}
      />
    </SectionCard>
  );
}
