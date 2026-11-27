"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Scale } from "lucide-react";
import { profileDecides } from "@/lib/admin-areas";
import { formatFigure } from "@/lib/staffing-view";
import { formatDay, formatDayOf } from "@/lib/staffing-day";
import type { ScopeAssessmentView } from "@/lib/assignment-scope";
import { useScopeAssessmentActions } from "@/lib/scope-assessment-queries";
import {
  EMPTY_SCOPE_DRAFT,
  SCOPE_EXCEPTIONS,
  SCOPE_LEVEL_MAX,
  SCOPE_NOTE_MAX,
  schoolToday,
  scopeDraftToBody,
  scopeToDraft,
  validateScopeDraft,
  type ScopeAssessmentDraft,
  type ScopeAssessmentProblem,
  type ScopeExceptionKind,
} from "@/lib/scope-assessment-form";
import { useProfile } from "@/components/profile-context";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionCard } from "@/components/ui/section-card";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiErrorText } from "@/lib/api-error-text";

/** The Select's value for "no exception": Radix takes no "". */
const NO_EXCEPTION = "__none__";

export interface ScopeAssessmentCardProps {
  teacher: { id: string; firstName: string; lastName: string };
  academicYearId: string;
  /** The teacher's assessment as the report carries it (scope.teachers[].assessment), or undefined where none is written. */
  assessment: ScopeAssessmentView | undefined;
  /** The span's upper edge at full time for the teacher's stage(s), for the hint under the level; null where it is not known. */
  fullTimeHighestHours: number | null;
}

/**
 * Rektorns bedömning (SFS 2026:1487 3 §, 8 §, 11 §): where in the ordinance's span a teacher lies, and a registered exception.
 *
 * RASTRA DOES NOT ASSESS "GOOD" OR "LESS GOOD" CONDITIONS. 8 § asks for the size of the groups, the pupils the teacher meets, pupils
 * who need special support and other circumstances, and a score of those would look like the rektor's assessment and be a guess. The
 * card is where the rektor writes the result, and says so; it holds no model of it.
 *
 * ONLY THOSE WHO DECIDE SEE IT (rektor, a full administrator: the table's write arms, and the gateway's @Decides). Everybody else
 * reads the summary in the scope card above, which says the level and the exception for anyone the gateway lets read them. A written
 * exception does not silence the verdict: it only means that an assignment over the highest level is warned of and not refused.
 */
export function ScopeAssessmentCard({ teacher, academicYearId, assessment, fullTimeHighestHours }: ScopeAssessmentCardProps) {
  const t = useTranslations("staffing.scopeAssessment");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const { profile: me, school } = useProfile();
  // The school's own day for an instant, Stockholm's where the profile names none (as the other pages say it).
  const timeZone = school?.timezone ?? "Europe/Stockholm";
  const decides = profileDecides(me?.adminProfile === undefined ? "FULL" : me.adminProfile);
  const actions = useScopeAssessmentActions();
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [draft, setDraft] = useState<ScopeAssessmentDraft>(EMPTY_SCOPE_DRAFT);
  if (!decides) return null;

  const name = `${teacher.firstName} ${teacher.lastName}`;
  const patch = (change: Partial<ScopeAssessmentDraft>) => setDraft((previous) => ({ ...previous, ...change }));
  const open = () => {
    setDraft(scopeToDraft(assessment));
    setEditing(true);
  };
  // The day of an own initiative is one that has been: the school's own today is the last the form takes, as the gateway's is.
  const today = schoolToday(timeZone);
  const problem: ScopeAssessmentProblem | null = validateScopeDraft(draft, today);
  const typedLevel = /^\d+$/.test(draft.level.trim()) ? Number(draft.level.trim()) : null;
  const levelOverEdge = typedLevel !== null && fullTimeHighestHours !== null && typedLevel > fullTimeHighestHours;
  const problemText = (p: ScopeAssessmentProblem) => {
    const { reason, ...values } = p;
    return t(`problems.${reason}`, values as Record<string, number>);
  };

  const save = async () => {
    if (problem) return;
    try {
      await actions.save.mutateAsync({ userId: teacher.id, academicYearId, ...scopeDraftToBody(draft) });
      toast.success(t("saved"));
      setEditing(false);
    } catch (error) {
      toast.error(apiErrorText(error, tCommon));
    }
  };
  const remove = async () => {
    try {
      await actions.remove.mutateAsync({ userId: teacher.id, academicYearId });
      toast.success(t("removed"));
      setConfirmRemove(false);
      setEditing(false);
    } catch (error) {
      setConfirmRemove(false);
      toast.error(apiErrorText(error, tCommon));
    }
  };

  const id = (field: string) => `scope-assessment-${field}-${teacher.id}`;

  return (
    <SectionCard
      id={`scope-assessment-${teacher.id}`}
      headingLevel={3}
      icon={Scale}
      title={t("title")}
      description={t("hint")}
      action={
        !editing ? (
          <Button variant="outline" size="sm" onClick={open}>
            {assessment ? t("edit") : tCommon("add")}
          </Button>
        ) : null
      }
    >
      {!editing ? (
        assessment ? (
          <ul className="space-y-0.5 text-sm">
            {assessment.levelHours !== null ? <li>{t("summaryLevel", { hours: formatFigure(assessment.levelHours, locale) })}</li> : <li>{t("summaryNoLevel")}</li>}
            {assessment.exceptionKind ? (
              <li>
                {t("summaryException", { kind: t(`exception${assessment.exceptionKind}`) })}
                {assessment.ownInitiativeOn ? ` ${t("summaryInitiativeOn", { day: formatDay(assessment.ownInitiativeOn, locale) })}` : ""}
              </li>
            ) : null}
            {assessment.note ? <li className="text-muted-foreground">{t("summaryNote", { note: assessment.note })}</li> : null}
            {assessment.decidedAt ? <li className="text-xs text-muted-foreground">{t("summaryDecided", { day: formatDayOf(assessment.decidedAt, timeZone, locale) })}</li> : null}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{t("none")}</p>
        )
      ) : (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <p className="text-xs text-muted-foreground">{t("explanation")}</p>
          <div className="space-y-1.5">
            <Label htmlFor={id("level")}>{t("level")}</Label>
            <Input
              id={id("level")}
              type="number"
              inputMode="numeric"
              min={1}
              max={SCOPE_LEVEL_MAX}
              step={1}
              aria-describedby={id("level-hint")}
              value={draft.level}
              onChange={(event) => patch({ level: event.target.value })}
            />
            <p id={id("level-hint")} className="text-xs text-muted-foreground">
              {fullTimeHighestHours === null ? t("levelHintNoEdge") : t("levelHint", { edge: formatFigure(fullTimeHighestHours, locale) })}
            </p>
            {levelOverEdge ? (
              // Not a refusal: the gateway holds the level to the highest edge of any stage and the teacher's stages change with the schedule, so a
              // level above today's edge is kept. The report reads it as the edge (the review of #411, L-3), and the form says so before it is saved.
              <p className="text-xs text-muted-foreground">{t("levelOverStageEdge", { edge: formatFigure(fullTimeHighestHours!, locale) })}</p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={id("exception")}>{t("exceptionLabel")}</Label>
            <Select
              value={draft.exceptionKind === "" ? NO_EXCEPTION : draft.exceptionKind}
              onValueChange={(value) => {
                const kind: "" | ScopeExceptionKind = value === NO_EXCEPTION ? "" : (value as ScopeExceptionKind);
                // The day belongs to the exception on the teacher's own initiative and the field is drawn for no other: a day left in the
                // draft would be refused (problems.dayNeedsInitiative) with nothing on screen to clear, and Save disabled for good.
                patch(kind === "OWN_INITIATIVE" ? { exceptionKind: kind } : { exceptionKind: kind, ownInitiativeOn: "" });
              }}
            >
              <SelectTrigger id={id("exception")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_EXCEPTION}>{t("exceptionNone")}</SelectItem>
                {SCOPE_EXCEPTIONS.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {t(`exceptionOption${kind}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {draft.exceptionKind === "OWN_INITIATIVE" ? (
            <div className="space-y-1.5">
              <Label htmlFor={id("day")}>{t("day")}</Label>
              <Input id={id("day")} type="date" max={today} value={draft.ownInitiativeOn} onChange={(event) => patch({ ownInitiativeOn: event.target.value })} />
              <p className="text-xs text-muted-foreground">{t("dayHint")}</p>
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor={id("note")}>{t("note")}</Label>
            <Textarea id={id("note")} rows={3} maxLength={SCOPE_NOTE_MAX} value={draft.note} onChange={(event) => patch({ note: event.target.value })} />
            <p className="text-xs text-muted-foreground">{t("noteHint", { max: SCOPE_NOTE_MAX })}</p>
            {/* The teacher reads their own assessment, the note with it (Min tjänst's card): the one who writes it is told before they do. */}
            <p className="text-xs text-muted-foreground">{t("noteTeacherSees")}</p>
          </div>
          {problem ? (
            <p role="alert" className="text-sm text-destructive">
              {problemText(problem)}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={problem !== null || actions.save.isPending}>
              {t("save")}
            </Button>
            <Button type="button" variant="outline" onClick={() => setEditing(false)}>
              {tCommon("cancel")}
            </Button>
            {assessment ? (
              <Button type="button" variant="outline" onClick={() => setConfirmRemove(true)}>
                {t("remove")}
              </Button>
            ) : null}
          </div>
        </form>
      )}
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={t("removeTitle", { name })}
        description={t("removeBody")}
        confirmLabel={t("remove")}
        loading={actions.remove.isPending}
        onConfirm={() => void remove()}
      />
    </SectionCard>
  );
}
