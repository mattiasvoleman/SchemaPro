"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Award, Plus, Trash2, TriangleAlert } from "lucide-react";
import { useReplaceTeacherQualifications } from "@/lib/staffing-queries";
import {
  QUALIFICATION_KINDS,
  newQualificationRow,
  qualificationRowsToBody,
  qualificationsToDraft,
  validateQualificationRows,
  validityState,
  type QualificationDraftRow,
  type QualificationProblem,
} from "@/lib/staffing-forms";
import type { Subject, TeacherQualification, TeacherQualificationKind } from "@/lib/types";
import { toDateString } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { GradeSpanField } from "@/components/ui/grade-span-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface QualificationsCardProps {
  teacher: { id: string; firstName: string; lastName: string };
  /** The teacher's rows; undefined while loading, [] for none. */
  qualifications: TeacherQualification[] | undefined;
  subjects: Subject[];
  /** yyyy-mm-dd; today unless a test says otherwise. */
  today?: string;
}

/** A kind as a badge: strongest reads greenest, a rektor's permission is neutral. */
export function QualificationKindBadge({ kind }: { kind: TeacherQualificationKind }) {
  const t = useTranslations("staffing");
  const variant = kind === "LEGITIMATION" ? "success" : kind === "BEHORIG" ? "secondary" : "outline";
  return <Badge variant={variant}>{t(`kind${kind}`)}</Badge>;
}

/** "åk 7–9", or "åk 4" when the span is one grade. */
export function spanLabel(
  min: number,
  max: number,
  t: (key: string, values?: Record<string, number>) => string,
): string {
  return min === max ? t("spanSingle", { grade: min }) : t("spanLabel", { min, max });
}

/**
 * A teacher's behörigheter: subject chips with a grade span and a kind, and a
 * form that replaces the whole list.
 *
 * THE LIST IS SAVED WHOLE because the endpoint takes it whole (PUT, like a
 * group's members): what the form shows on Spara is exactly what the table
 * holds afterwards, a repeated save is a no-op, and taking every behörighet
 * away is saving an empty list. No row-level delete calls exist to drift
 * from the list on screen.
 *
 * A validTo in the past is said in red and one within ninety days in amber,
 * because a tidsbegränsad legitimation that lapses in March is a thing the
 * school has to act on before the tjänstefördelning is negotiated, not after.
 */
export function QualificationsCard({
  teacher,
  qualifications,
  subjects,
  today = toDateString(new Date()),
}: QualificationsCardProps) {
  const t = useTranslations("staffing");
  const tCommon = useTranslations("common");
  const replace = useReplaceTeacherQualifications();
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<QualificationDraftRow[]>([]);

  const subjectName = (id: string) => subjects.find((subject) => subject.id === id)?.name ?? "—";
  const open = () => {
    setRows(qualificationsToDraft(qualifications ?? []));
    setEditing(true);
  };
  const patchRow = (key: string, change: Partial<QualificationDraftRow>) =>
    setRows((previous) =>
      previous.map((row) => (row.key === key ? { ...row, ...change } : row)),
    );
  const removeRow = (key: string) =>
    setRows((previous) => previous.filter((row) => row.key !== key));

  const problem: QualificationProblem | null = validateQualificationRows(rows);
  const problemText = (p: QualificationProblem) => {
    const { reason, ...values } = p;
    return t(`problem_${reason}`, values as Record<string, number>);
  };

  const save = async () => {
    if (problem) return;
    try {
      await replace.mutateAsync({ userId: teacher.id, items: qualificationRowsToBody(rows) });
      toast.success(t("qualificationsSaved"));
      setEditing(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  const stored = qualifications ?? [];

  return (
    <section
      className="rounded-lg border bg-card p-4"
      aria-labelledby={`qualifications-${teacher.id}`}
    >
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Award className="size-4 text-muted-foreground" />
          <h3 id={`qualifications-${teacher.id}`} className="font-semibold">
            {t("qualificationsTitle")}
          </h3>
        </div>
        {!editing ? (
          <Button variant="outline" size="sm" onClick={open}>
            {stored.length > 0 ? t("editQualifications") : tCommon("add")}
          </Button>
        ) : null}
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{t("qualificationsHint")}</p>

      {!editing ? (
        stored.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noQualifications")}</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {stored.map((row) => {
              const validity = validityState(row.validTo, today);
              return (
                <li
                  key={row.id}
                  className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm"
                >
                  <span className="font-medium">{subjectName(row.subjectId)}</span>
                  <span className="text-muted-foreground">
                    {spanLabel(row.minGradeLevel, row.maxGradeLevel, t)}
                  </span>
                  <QualificationKindBadge kind={row.kind} />
                  {validity !== "VALID" && row.validTo ? (
                    <span
                      className={
                        validity === "EXPIRED"
                          ? "flex items-center gap-1 text-xs font-medium text-destructive"
                          : "flex items-center gap-1 text-xs font-medium text-warning-foreground dark:text-warning"
                      }
                    >
                      <TriangleAlert className="size-3" aria-hidden="true" />
                      {validity === "EXPIRED"
                        ? t("expired", { date: row.validTo })
                        : t("expiring", { date: row.validTo })}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )
      ) : (
        <div className="space-y-3">
          {rows.map((row, index) => (
            <div key={row.key} className="space-y-2 rounded-md border p-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>{t("qualificationSubject")}</Label>
                  <Select
                    value={row.subjectId || undefined}
                    onValueChange={(value) => patchRow(row.key, { subjectId: value })}
                  >
                    <SelectTrigger aria-label={`${t("qualificationSubject")} ${index + 1}`}>
                      <SelectValue placeholder={t("selectSubject")} />
                    </SelectTrigger>
                    <SelectContent>
                      {subjects.map((subject) => (
                        <SelectItem key={subject.id} value={subject.id}>
                          {subject.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>{t("qualificationKind")}</Label>
                  <Select
                    value={row.kind}
                    onValueChange={(value) =>
                      patchRow(row.key, { kind: value as TeacherQualificationKind })
                    }
                  >
                    <SelectTrigger aria-label={`${t("qualificationKind")} ${index + 1}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {QUALIFICATION_KINDS.map((kind) => (
                        <SelectItem key={kind} value={kind}>
                          {t(`kind${kind}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {/*
                The shared span control, which cannot be put in the wrong
                order: it follows the other bound as the admin picks. The
                validator's spanReversed is therefore reachable only from a
                row that arrived reversed through another door — kept, so
                such a row cannot be saved back unchanged.
              */}
              <GradeSpanField
                label={t("qualificationSpan")}
                fromLabel={`${t("qualificationSpanFrom")} ${index + 1}`}
                toLabel={`${t("qualificationSpanTo")} ${index + 1}`}
                min={row.minGradeLevel}
                max={row.maxGradeLevel}
                onChange={({ min, max }) =>
                  patchRow(row.key, { minGradeLevel: min, maxGradeLevel: max })
                }
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor={`qual-from-${row.key}`}>{t("validFrom")}</Label>
                  <DateField
                    id={`qual-from-${row.key}`}
                    label={`${t("validFrom")} ${index + 1}`}
                    value={row.validFrom}
                    onChange={(value) => patchRow(row.key, { validFrom: value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`qual-to-${row.key}`}>{t("validTo")}</Label>
                  <DateField
                    id={`qual-to-${row.key}`}
                    label={`${t("validTo")} ${index + 1}`}
                    value={row.validTo}
                    onChange={(value) => patchRow(row.key, { validTo: value })}
                  />
                </div>
              </div>
              <div className="flex items-end gap-2">
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor={`qual-note-${row.key}`}>
                    {t("note")}{" "}
                    <span className="text-muted-foreground">({tCommon("optional")})</span>
                  </Label>
                  <Input
                    id={`qual-note-${row.key}`}
                    maxLength={500}
                    value={row.note}
                    onChange={(event) => patchRow(row.key, { note: event.target.value })}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeRow(row.key)}
                  aria-label={t("removeQualification", { row: index + 1 })}
                >
                  <Trash2 className="text-destructive" />
                </Button>
              </div>
            </div>
          ))}

          <Button
            variant="outline"
            size="sm"
            onClick={() => setRows((previous) => [...previous, newQualificationRow()])}
          >
            <Plus />
            {t("addQualification")}
          </Button>

          {problem ? (
            <p role="alert" className="text-sm text-destructive">
              {problemText(problem)}
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditing(false)}>
              {tCommon("cancel")}
            </Button>
            <Button
              size="sm"
              onClick={() => void save()}
              disabled={problem !== null || replace.isPending}
            >
              {replace.isPending ? tCommon("saving") : tCommon("save")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
