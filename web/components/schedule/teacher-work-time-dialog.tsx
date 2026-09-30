"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { TriangleAlert } from "lucide-react";
import { useTeacherWorkRuleActions } from "@/lib/queries";
import type { Person, TeacherWorkRule } from "@/lib/types";
import {
  EMPTY_DRAFT,
  LUNCH_MINUTES_MAX,
  LUNCH_MINUTES_MIN,
  LUNCH_MINUTES_STEP,
  REST_MINUTES_MAX,
  REST_MINUTES_MIN,
  SUGGESTED_DRAFT,
  draftToBody,
  hasAnyRule,
  isEmptyDraft,
  ruleToDraft,
  splitHours,
  validateDraft,
  type WorkRuleDraft,
  type WorkRuleProblem,
} from "@/lib/teacher-work-rules";
import { formatTime } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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

/**
 * Five minutes on the clock fields too, mirroring the solver's grid.
 *
 * Only the step, not a validation rule: nothing in the table forbids a window
 * edge of 10:33, and a row written through another door has to keep loading into
 * this form rather than drawing itself empty.
 */
const FIVE_MINUTE_STEP = 5 * 60;

/**
 * A stored rule read back in prose.
 *
 * Sits beside the form rather than in it, because the two answer different
 * questions with the same row: the dialog is where a rule is written, this is
 * where a school checks what it wrote without opening anything. FOUR NULLS ARE
 * SPELLED OUT — "no working-time rule", not four dashes and not four zeroes.
 * The difference is the whole design: zero minutes of lunch would be a promise
 * the solver keeps, and nothing said is a promise it never makes.
 */
export function TeacherWorkTimeSummary({ rule }: { rule: TeacherWorkRule | undefined }) {
  const t = useTranslations("teacherWorkTime");

  if (!hasAnyRule(rule) || !rule) {
    return <p className="text-sm text-muted-foreground">{t("noRule")}</p>;
  }

  const lunch =
    rule.lunchMinutes !== null &&
    rule.lunchStartTime !== null &&
    rule.lunchEndTime !== null
      ? t("summaryLunch", {
          minutes: rule.lunchMinutes,
          // The seconds PostgREST adds are cut here for the same reason the
          // form cuts them: "10:30:00" is not how anybody writes a lunch.
          start: formatTime(rule.lunchStartTime),
          end: formatTime(rule.lunchEndTime),
        })
      : null;

  const rest =
    rule.minDailyRestMinutes === null
      ? null
      : (() => {
          const split = splitHours(rule.minDailyRestMinutes);
          return split.minutes === 0
            ? t("summaryRestHours", { hours: split.hours })
            : t("summaryRestHoursMinutes", {
                hours: split.hours,
                minutes: split.minutes,
              });
        })();

  return (
    <ul className="space-y-0.5 text-sm">
      {lunch === null ? null : <li>{lunch}</li>}
      {rest === null ? null : <li>{rest}</li>}
    </ul>
  );
}

export interface TeacherWorkTimeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whose working time this is. Only the name is read; nothing is sent but the id. */
  teacher: Pick<Person, "id" | "firstName" | "lastName">;
  /** The stored row, or undefined for a teacher who has none — the normal case. */
  rule: TeacherWorkRule | undefined;
}

/**
 * A teacher's own working time: the lunch they are owed, and the night.
 *
 * THE EMPTY FORM IS A REAL ANSWER, and it is the one nearly every row starts
 * from. Four empty fields mean the solver promises this teacher nothing, which
 * is what every school in production is running today — so the dialog says that
 * in a sentence rather than drawing four zeroes that would read as a rule of
 * "no lunch at all". Saving an emptied row DELETES it, for the reason
 * useTeacherWorkRuleMutations gives.
 *
 * The suggestions are offered and never stored. A default on the column would
 * make every school that has not opened this dialog refuse its next generation
 * run over a rule nobody wrote; a button that fills the draft leaves the
 * decision, and the save, with the reader.
 *
 * THE DRAFT IS INITIALISED ONCE, AT MOUNT. The page remounts this component
 * with a key built from the teacher and the row, which is what makes a
 * background refetch of the rules query harmless: the same row id keeps the same
 * key and whatever the reader is halfway through typing survives it. An effect
 * that re-filled from props would instead throw the typing away, which is the
 * bug LunchSettingsCard's `loaded` flag exists to avoid.
 */
export function TeacherWorkTimeDialog({
  open,
  onOpenChange,
  teacher,
  rule,
}: TeacherWorkTimeDialogProps) {
  const t = useTranslations("teacherWorkTime");
  const tCommon = useTranslations("common");
  const actions = useTeacherWorkRuleActions();

  const [draft, setDraft] = useState<WorkRuleDraft>(() => ruleToDraft(rule));

  const empty = isEmptyDraft(draft);
  const problem = validateDraft(draft);
  const saving = actions.save.isPending || actions.remove.isPending;

  /**
   * A lunch field changed.
   *
   * When the trio was UNTOUCHED and the reader has just WRITTEN something, the
   * other two fields take the suggestion. The three are all-or-nothing in the
   * table, and the commonest way to fail that is to write the minutes and walk
   * away — so a school that starts the lunch rule is handed a whole one it can
   * then change or clear.
   *
   * Both halves of the condition are load-bearing. Scoped to the TRIO, because
   * completing it must never conjure a dygnsvila for a school that wanted only
   * one — that rule stands alone and is legitimately the only one set. And only
   * on a written value, because clearing the last of the three fields is how a
   * reader REMOVES the lunch rule: without the test, a change to "" would find
   * the trio empty and put the suggestion straight back.
   */
  const changeLunch = (change: Partial<WorkRuleDraft>) =>
    setDraft((previous) => {
      const wrote = Object.values(change).some((value) => value.trim() !== "");
      const untouched =
        previous.lunchMinutes.trim() === "" &&
        previous.lunchStartTime.trim() === "" &&
        previous.lunchEndTime.trim() === "";
      const base =
        wrote && untouched
          ? {
              ...previous,
              lunchMinutes: SUGGESTED_DRAFT.lunchMinutes,
              lunchStartTime: SUGGESTED_DRAFT.lunchStartTime,
              lunchEndTime: SUGGESTED_DRAFT.lunchEndTime,
            }
          : previous;
      return { ...base, ...change };
    });

  /** The refusal, in the reader's language, with the numbers it is about. */
  const explain = (refusal: WorkRuleProblem): string => {
    const { reason, ...values } = refusal;
    return t(reason, values as Record<string, number>);
  };

  const submit = async () => {
    try {
      if (empty) {
        // Nothing stored and nothing written: there is no request to make, and a
        // DELETE of a row that does not exist would be a 404 shown as an error.
        // Keyed by the TEACHER, like the endpoint — never by the row.
        if (rule) {
          await actions.remove.mutateAsync(teacher.id);
          toast.success(t("cleared"));
        }
        onOpenChange(false);
        return;
      }

      // One upsert for both cases: the table holds at most one row per teacher,
      // so there is no create/update to tell apart from here.
      await actions.save.mutateAsync({ userId: teacher.id, ...draftToBody(draft) });
      toast.success(tCommon("updated"));
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : tCommon("error"));
    }
  };

  /** 660 is eleven hours to the person who wrote it and a riddle on a page. */
  const restReadout = (): string | null => {
    const rest = draft.minDailyRestMinutes;
    if (rest.trim() === "") return null;
    // Only for a number the form would accept. Half a typed value is a wrong
    // hour count on screen, and a wrong one is worse than none.
    if (validateDraft({ ...EMPTY_DRAFT, minDailyRestMinutes: rest })) return null;
    const split = splitHours(Number(draft.minDailyRestMinutes.trim()));
    return split.minutes === 0
      ? t("restEqualsHours", { hours: split.hours })
      : t("restEqualsHoursMinutes", { hours: split.hours, minutes: split.minutes });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("title", { name: `${teacher.firstName} ${teacher.lastName}` })}
          </DialogTitle>
          {/*
            The cost, where the rule is written rather than at the top of the
            register this dialog opens from. A hard rule can refuse a whole
            week, and the moment that is worth knowing is the moment somebody
            is typing the number that would do it.
          */}
          <DialogDescription className="flex items-start gap-2">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{t("hardRuleHint")}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="work-lunch-minutes">{t("lunchMinutes")}</Label>
            <Input
              id="work-lunch-minutes"
              type="number"
              inputMode="numeric"
              min={LUNCH_MINUTES_MIN}
              max={LUNCH_MINUTES_MAX}
              step={LUNCH_MINUTES_STEP}
              placeholder={SUGGESTED_DRAFT.lunchMinutes}
              value={draft.lunchMinutes}
              onChange={(event) => changeLunch({ lunchMinutes: event.target.value })}
            />
            <p className="text-xs text-muted-foreground">{t("lunchMinutesHint")}</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="work-lunch-start">{t("windowStart")}</Label>
              <Input
                id="work-lunch-start"
                type="time"
                step={FIVE_MINUTE_STEP}
                value={draft.lunchStartTime}
                onChange={(event) => changeLunch({ lunchStartTime: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="work-lunch-end">{t("windowEnd")}</Label>
              <Input
                id="work-lunch-end"
                type="time"
                step={FIVE_MINUTE_STEP}
                value={draft.lunchEndTime}
                onChange={(event) => changeLunch({ lunchEndTime: event.target.value })}
              />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{t("windowHint")}</p>

          <div className="space-y-2">
            <Label htmlFor="work-rest-minutes">{t("restMinutes")}</Label>
            <Input
              id="work-rest-minutes"
              type="number"
              inputMode="numeric"
              min={REST_MINUTES_MIN}
              max={REST_MINUTES_MAX}
              placeholder={SUGGESTED_DRAFT.minDailyRestMinutes}
              value={draft.minDailyRestMinutes}
              onChange={(event) =>
                setDraft((previous) => ({
                  ...previous,
                  minDailyRestMinutes: event.target.value,
                }))
              }
            />
            <p className="text-xs text-muted-foreground">
              {t("restMinutesHint")}
              {restReadout() === null ? null : <> · {restReadout()}</>}
            </p>
          </div>

          {/*
            Offered while the row is still blank — the one moment a suggestion
            is not in somebody's way. It writes the draft, never the column: the
            reader still has to press Spara, and can clear any of it first.
          */}
          {empty ? (
            <div className="space-y-2 rounded-lg border p-3">
              <p className="text-sm text-muted-foreground">{t("emptyMeansNoRule")}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setDraft(SUGGESTED_DRAFT)}
              >
                {t("useSuggestion")}
              </Button>
            </div>
          ) : null}

          {problem ? (
            <p role="status" className="text-sm text-destructive">
              {explain(problem)}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tCommon("cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={problem !== null || saving}>
            {saving ? tCommon("saving") : tCommon("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
