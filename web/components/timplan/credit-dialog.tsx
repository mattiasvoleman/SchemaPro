"use client";

// Tillgodoräknad tid — the dialog that writes one of the school's decisions
// that a day's activity counts as undervisningstid ("Friluftsdag, 300 min
// Idrott och hälsa, åk 7–9").
//
// Skolinspektionen's finding is that schools have not DECIDED whether their
// friluftsdagar count. A row written here is that decision; a day without one
// does not count, which is why the subject list ends in "Inget ämne — räknas
// som undervisningstid" rather than in "räknas inte": not counting needs no
// row.
//
// The checks mirror the DTO (lib/timplan-credit-form.ts), and whatever the
// server still refuses — a group of another läsår, a subject deleted in
// between — is shown in its own sentence. A date outside every lov says, before
// the save, that lessons held that day count as well (R6): a temaeftermiddag
// after a morning of lessons is fine, a friluftsdag left on the calendar is
// counted twice, and only the school knows which this is.
//
// Fetched with lazy() the first time it opens; the page carries none of it.
//
// Text is `foreground` throughout, as on the rest of the breaks page (its
// header records the measurements).

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  useTimplanCreditActions,
  type TimplanCredit,
} from "@/lib/timplan-credit-queries";
import {
  creditBody,
  creditForm,
  creditFormProblems,
  EMPTY_CREDIT_FORM,
  insideAnyBreak,
  type CreditForm,
  type CreditScope,
} from "@/lib/timplan-credit-form";
import type { AcademicYear, SchoolBreak, StudentGroup, Subject } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { GradeSpanField } from "@/components/ui/grade-span-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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

/** Radix Select has no empty value; the "no subject" choice is this. */
const NO_SUBJECT = "none";

export interface CreditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  year: AcademicYear;
  breaks: readonly SchoolBreak[];
  subjects: readonly Subject[];
  /** The year's groups. */
  groups: readonly StudentGroup[];
  /** The credit being edited, or null for a new one. */
  editing: TimplanCredit | null;
  /** "Räkna tid för dagen" on a lov: its name and first day. */
  prefill: { name: string; date: string } | null;
}

export function CreditDialog({ open, onOpenChange, year, breaks, subjects, groups, editing, prefill }: CreditDialogProps) {
  const t = useTranslations("breaks.credits");
  const tBreaks = useTranslations("breaks");
  const tCommon = useTranslations("common");
  const actions = useTimplanCreditActions();
  const [form, setForm] = useState<CreditForm>(EMPTY_CREDIT_FORM);
  const [refusal, setRefusal] = useState<string | null>(null);

  // A fresh form every time the dialog opens, from what it was opened on.
  useEffect(() => {
    if (!open) return;
    setRefusal(null);
    setForm(
      editing
        ? creditForm(editing)
        : prefill
          ? { ...EMPTY_CREDIT_FORM, name: prefill.name, date: prefill.date }
          : EMPTY_CREDIT_FORM,
    );
  }, [open, editing, prefill]);

  // Counted subjects first-class; one that does not count is still offered
  // when the credit being edited names it, marked, so editing it changes nothing silently.
  const subjectOptions = useMemo(
    () => subjects.filter((subject) => subject.countsTowardTimplan !== false || subject.id === editing?.subjectId),
    [subjects, editing],
  );
  const problems = creditFormProblems(form, year);
  const saving = actions.create.isPending || actions.update.isPending;
  const set = (patch: Partial<CreditForm>) => setForm((current) => ({ ...current, ...patch }));

  const submit = async () => {
    const body = creditBody(form, year.id);
    setRefusal(null);
    try {
      if (editing) await actions.update.mutateAsync({ ...body, id: editing.id });
      else await actions.create.mutateAsync(body);
      toast.success(editing ? tCommon("updated") : tCommon("created"));
      onOpenChange(false);
    } catch (error) {
      // The server's own sentence: it names the field, and it knows the year.
      setRefusal(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editing ? t("edit") : t("add")}</DialogTitle>
          <DialogDescription className="text-foreground">{t("dialogIntro")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="credit-name">{tCommon("name")}</Label>
              <Input
                id="credit-name"
                value={form.name}
                placeholder={t("namePlaceholder")}
                onChange={(event) => set({ name: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="credit-date">{tCommon("date")}</Label>
              <DateField
                label={tCommon("date")}
                id="credit-date"
                min={year.startDate}
                max={year.endDate}
                value={form.date}
                onChange={(value) => set({ date: value })}
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="credit-minutes">{t("minutes")}</Label>
              <Input
                id="credit-minutes"
                inputMode="numeric"
                value={form.minutes}
                aria-describedby="credit-minutes-hint"
                onChange={(event) => set({ minutes: event.target.value })}
              />
              <p id="credit-minutes-hint" className="text-xs leading-relaxed text-foreground">
                {t("minutesHint")}
              </p>
            </div>
            <div className="space-y-2">
              <Label>{t("subject")}</Label>
              <Select
                value={form.subjectId === "" ? NO_SUBJECT : form.subjectId}
                onValueChange={(value) => set({ subjectId: value === NO_SUBJECT ? "" : value })}
              >
                <SelectTrigger aria-label={t("subject")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {subjectOptions.map((subject) => (
                    <SelectItem key={subject.id} value={subject.id}>
                      {subject.countsTowardTimplan === false
                        ? `${subject.name} (${t("notCounted")})`
                        : subject.name}
                    </SelectItem>
                  ))}
                  <SelectItem value={NO_SUBJECT}>{t("subjectNone")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t("scope")}</Label>
            <Select value={form.scope} onValueChange={(value) => set({ scope: value as CreditScope })}>
              <SelectTrigger aria-label={t("scope")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="school">{t("scopeSchool")}</SelectItem>
                <SelectItem value="grades">{t("scopeGrades")}</SelectItem>
                <SelectItem value="group">{t("scopeGroup")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {form.scope === "grades" ? (
            <GradeSpanField
              label={tBreaks("gradeSpan")}
              fromLabel={tBreaks("gradeFromLabel")}
              toLabel={tBreaks("gradeToLabel")}
              min={form.minGradeLevel}
              max={form.maxGradeLevel}
              onChange={({ min, max }) => set({ minGradeLevel: min, maxGradeLevel: max })}
              hint={t("gradesHint")}
              hintClassName="text-xs leading-relaxed text-foreground"
            />
          ) : form.scope === "group" ? (
            <div className="space-y-2">
              <Label>{t("group")}</Label>
              <Select value={form.studentGroupId || undefined} onValueChange={(value) => set({ studentGroupId: value })}>
                <SelectTrigger aria-label={t("group")}>
                  <SelectValue placeholder={t("groupPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {groups.map((group) => (
                    <SelectItem key={group.id} value={group.id}>
                      {group.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="credit-note">{t("note")}</Label>
            <Textarea
              id="credit-note"
              rows={2}
              value={form.note}
              placeholder={t("notePlaceholder")}
              onChange={(event) => set({ note: event.target.value })}
            />
          </div>

          {form.date !== "" && !insideAnyBreak(form.date, breaks) ? (
            <p className="rounded-md bg-muted px-3 py-2 text-xs leading-relaxed text-foreground">
              {t("overlapHint")}
            </p>
          ) : null}
          {problems.length > 0 && (form.name !== "" || form.minutes !== "" || form.date !== "") ? (
            <ul className="space-y-0.5 text-xs leading-relaxed text-foreground">
              {problems.map((problem) => (
                <li key={problem}>{t(`errors.${problem}`)}</li>
              ))}
            </ul>
          ) : null}
          <p role="alert" className="text-sm text-foreground">
            {refusal}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={submit} disabled={problems.length > 0 || saving}>
            {tCommon("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
