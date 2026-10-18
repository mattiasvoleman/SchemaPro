"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { TriangleAlert } from "lucide-react";
import { useTeacherWorkRuleActions } from "@/lib/work-rule-queries";
import type { Person, TeacherWorkRule } from "@/lib/types";
import {
  DAY_CAP_MINUTES_MAX,
  DAY_CAP_MINUTES_MIN,
  DAY_CAP_MINUTES_STEP,
  EMPTY_DRAFT,
  FREE_DAY_MAX,
  FREE_DAY_MIN,
  LUNCH_MINUTES_MAX,
  LUNCH_MINUTES_MIN,
  LUNCH_MINUTES_STEP,
  REST_MINUTES_MAX,
  REST_MINUTES_MIN,
  SUGGESTED_DRAFT,
  draftToBody,
  isEmptyDraft,
  ruleToDraft,
  validateDraft,
  type WorkRuleDraft,
  type WorkRuleProblem,
} from "@/lib/teacher-work-rules";
import { splitHours } from "@/components/schedule/teacher-work-time-summary";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
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

/** The weekdays the wish can name, Monday first, as the column's CHECK has them. */
const FREE_DAYS = Array.from(
  { length: FREE_DAY_MAX - FREE_DAY_MIN + 1 },
  (_, index) => FREE_DAY_MIN + index,
);

export interface TeacherWorkTimeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whose working time this is. Only the name is read; nothing is sent but the id. */
  teacher: Pick<Person, "id" | "firstName" | "lastName">;
  /** The stored row, or undefined for a teacher who has none — the normal case. */
  rule: TeacherWorkRule | undefined;
}

/**
 * A teacher's own working time: the lunch they are owed, the night, how much
 * they teach on one day at most, and the weekday they would rather have free.
 *
 * THE EMPTY FORM IS A REAL ANSWER, and it is the one nearly every row starts
 * from. Empty fields mean the solver promises this teacher nothing, which is
 * what every school in production is running today — so the dialog says that
 * in a sentence rather than drawing zeroes that would read as a rule of "no
 * lunch at all". Saving an emptied row DELETES it, for the reason
 * useTeacherWorkRuleActions gives.
 *
 * The suggestions are offered and never stored. A default on the column would
 * make every school that has not opened this dialog refuse its next generation
 * run over a rule nobody wrote; a button that fills the draft leaves the
 * decision, and the save, with the reader. The suggestion fills the lunch and
 * the rest only: see SUGGESTED_DRAFT for why it never carries a cap.
 *
 * ONE ROW, TWO KINDS OF FIELD. The lunch, the rest and the day's cap are hard
 * — the generator refuses a week that cannot keep them — and the free day is
 * a wish it weighs and may give up. The dialog says which is which where each
 * is written, because a school that read the wish as a rule would expect the
 * day to be kept, and one that read the cap as a wish would be surprised by
 * the refusal.
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
  const tDays = useTranslations("days");
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

  /**
   * 270 read back as "= 4 tim 30 min", beside the field.
   *
   * A cap is thought of in hours and lessons and typed in minutes, so the
   * number is said back the way the school thinks of it. The same rule as the
   * rest's readout: only for a value the form would save. Three sentences,
   * because a cap can be under an hour (30..55 minutes) as well as whole hours,
   * and "0 tim 45 min" is not how anybody says three quarters of an hour.
   */
  const capReadout = (): string | null => {
    const cap = draft.maxTeachingMinutesPerDay;
    if (cap.trim() === "") return null;
    if (validateDraft({ ...EMPTY_DRAFT, maxTeachingMinutesPerDay: cap })) return null;
    const split = splitHours(Number(cap.trim()));
    if (split.hours === 0) return t("dayCapEqualsMinutes", { minutes: split.minutes });
    return split.minutes === 0
      ? t("dayCapEqualsHours", { hours: split.hours })
      : t("dayCapEqualsHoursMinutes", { hours: split.hours, minutes: split.minutes });
  };
  const capSaid = capReadout();

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
            is typing the number that would do it. The sentence names the hard
            fields and says the free day is not one of them; the free day's
            own section says what a wish does instead.
          */}
          <DialogDescription className="flex items-start gap-2">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
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
            Undervisning per dag. No placeholder, unlike the lunch and the
            rest above: a greyed number in an empty field reads as a value the
            school could just accept, and there is no cap anybody should
            accept without choosing it.
          */}
          <div role="group" aria-labelledby="work-day-cap-title" className="space-y-2 border-t pt-4">
            <h3 id="work-day-cap-title" className="text-sm font-semibold">
              {t("dayCapTitle")}
            </h3>
            <Label htmlFor="work-day-cap">{t("dayCapMinutes")}</Label>
            <div className="flex items-center gap-3">
              <Input
                id="work-day-cap"
                type="number"
                inputMode="numeric"
                min={DAY_CAP_MINUTES_MIN}
                max={DAY_CAP_MINUTES_MAX}
                step={DAY_CAP_MINUTES_STEP}
                value={draft.maxTeachingMinutesPerDay}
                onChange={(event) =>
                  setDraft((previous) => ({
                    ...previous,
                    maxTeachingMinutesPerDay: event.target.value,
                  }))
                }
              />
              {capSaid === null ? null : (
                <span className="shrink-0 text-sm text-muted-foreground">{capSaid}</span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{t("dayCapHint")}</p>
          </div>

          {/*
            Önskad ledig dag. A native select, every weekday the column
            allows: the dialog is fetched on its own, so the control costs no
            route anything, and a phone gets its own picker.
          */}
          <div role="group" aria-labelledby="work-free-day-title" className="space-y-2 border-t pt-4">
            <h3 id="work-free-day-title" className="text-sm font-semibold">
              {t("freeDayTitle")}
            </h3>
            <Label htmlFor="work-free-day">{t("freeDay")}</Label>
            <NativeSelect
              id="work-free-day"
              value={draft.preferredFreeDayOfWeek}
              onChange={(event) =>
                setDraft((previous) => ({
                  ...previous,
                  preferredFreeDayOfWeek: event.target.value,
                }))
              }
            >
              <option value="">{t("freeDayNone")}</option>
              {FREE_DAYS.map((day) => (
                <option key={day} value={String(day)}>
                  {tDays(String(day))}
                </option>
              ))}
            </NativeSelect>
            <p className="text-xs text-muted-foreground">{t("freeDayHint")}</p>
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
          <Button onClick={() => void submit()} disabled={problem !== null || saving} data-writes="PLANERING">
            {saving ? tCommon("saving") : tCommon("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
