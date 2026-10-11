"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { SchoolForm } from "@/lib/timplan-coverage";
import type { CreatePlanBody } from "@/lib/timplan-queries";
import { parseWeeksTenths, SUGGESTED_WEEKS } from "@/lib/timplan-view";
import type { NationalTimplanVersion } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

const SCHOOL_FORMS: SchoolForm[] = [
  "GRUNDSKOLA",
  "ANPASSAD_GRUNDSKOLA_AMNEN",
  "ANPASSAD_GRUNDSKOLA_AMNESOMRADEN",
  "SPECIALSKOLA",
  "SAMESKOLA",
];

/**
 * The newest lydelse of a school form that has a published fördelning, else
 * the newest at all: a new plan is almost always written against the bilaga in
 * force, and SFS 2025:729 (2028, totals only) is a deliberate choice the
 * admin makes in the select, not a default that greys every cell.
 */
export function defaultVersionFor(
  versions: NationalTimplanVersion[],
  schoolForm: SchoolForm,
): NationalTimplanVersion | undefined {
  const ofForm = versions
    .filter((version) => version.schoolForm === schoolForm)
    .sort((a, b) => (a.appliesFromCohortTerm < b.appliesFromCohortTerm ? 1 : -1));
  return ofForm.find((version) => version.entries.length > 0) ?? ofForm[0];
}

export interface CreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  versions: NationalTimplanVersion[];
  pending: boolean;
  onConfirm: (body: CreatePlanBody) => Promise<void>;
}

/**
 * Ny timplan: name, school form, the national lydelse it is checked against,
 * and the planning weeks. The school form cannot be changed afterwards (the
 * PATCH does not take it — another form is a copy), so the body says so here,
 * where it is chosen. The version list follows the form, as the gateway's
 * composite key does: a grundskola plan cannot name the specialskola bilaga.
 */
export function CreateDialog({ open, onOpenChange, versions, pending, onConfirm }: CreateDialogProps) {
  const t = useTranslations("timplan");
  const tCommon = useTranslations("common");
  const [name, setName] = useState("");
  const [schoolForm, setSchoolForm] = useState<SchoolForm>("GRUNDSKOLA");
  const [versionId, setVersionId] = useState<string | null>(null);
  const [weeks, setWeeks] = useState(String(SUGGESTED_WEEKS).replace(".", ","));
  const [touched, setTouched] = useState(false);

  const ofForm = versions.filter((version) => version.schoolForm === schoolForm);
  const chosen =
    ofForm.find((version) => version.id === versionId) ?? defaultVersionFor(versions, schoolForm);
  const weeksTenths = parseWeeksTenths(weeks);
  const nameProblem =
    name.trim() === "" ? t("nameRequired") : name.trim().length > 100 ? t("nameTooLong") : null;

  const reset = () => {
    setName("");
    setSchoolForm("GRUNDSKOLA");
    setVersionId(null);
    setWeeks(String(SUGGESTED_WEEKS).replace(".", ","));
    setTouched(false);
  };

  const submit = async () => {
    setTouched(true);
    if (nameProblem || !chosen || weeksTenths === null) return;
    await onConfirm({
      name: name.trim(),
      schoolForm,
      nationalTimplanVersionId: chosen.id,
      planningWeeks: weeksTenths / 10,
    });
    reset();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("createTitle")}</DialogTitle>
          <DialogDescription>{t("createBody")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <FormField id="timplan-create-name" label={t("nameLabel")} error={touched ? nameProblem : null}>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </FormField>
          <FormField id="timplan-create-school-form" label={t("schoolFormLabel")}>
            {(control) => (
              <Select
                value={schoolForm}
                onValueChange={(value) => {
                  setSchoolForm(value as SchoolForm);
                  setVersionId(null);
                }}
              >
                <SelectTrigger {...control}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCHOOL_FORMS.map((form) => (
                    <SelectItem key={form} value={form}>
                      {t(`schoolForms.${form}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </FormField>
          <div className="space-y-1.5">
            {/* By hand: with no version for the form there is no control to label, only the sentence. */}
            <Label htmlFor={chosen ? "timplan-create-version" : undefined}>{t("versionLabel")}</Label>
            {chosen ? (
              <Select value={chosen.id} onValueChange={setVersionId}>
                <SelectTrigger id="timplan-create-version">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ofForm.map((version) => (
                    <SelectItem key={version.id} value={version.id}>
                      {t("versionOption", {
                        sfs: version.sfs,
                        total: version.totalHours,
                        term: version.appliesFromCohortTerm,
                      })}
                      {version.entries.length === 0 ? ` · ${t("versionUnpublished")}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="text-sm text-destructive">{t("noVersionForForm")}</p>
            )}
          </div>
          {/* The line under the field is the hint, or the error in its place. */}
          <FormField
            id="timplan-create-weeks"
            label={t("weeksLabel")}
            hint={weeksTenths === null ? undefined : t("weeksHint")}
            error={weeksTenths === null ? t("weeksInvalid") : undefined}
          >
            <Input
              inputMode="decimal"
              className="w-28"
              value={weeks}
              onChange={(event) => setWeeks(event.target.value)}
            />
          </FormField>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={pending || !chosen || weeksTenths === null}>
            {t("createConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
