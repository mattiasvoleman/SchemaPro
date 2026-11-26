"use client";

/*
 * Krocklistan: every lesson of the grundschema that stands against a rule, and what it stands against (E1).
 *
 * The grid marks a lesson that clashes with a ring and a triangle and says nothing more, and the header counts them. This says each one in
 * a sentence: the rule, and the other lesson by class, subject, day and time (lib/conflict-rows.ts, the sentence of common.codes.
 * MASTER_LESSON_REFUSED that a refused save is said in), with a button that opens the lesson to change it. It reads what the page has
 * already read, and asks the gateway nothing.
 *
 * Fetched with the lesson dialogs' chunk (lesson-dialogs.ts), so that it shares their copy of the dialog, and drawn only after "Visa
 * vilka" has been pressed.
 */

import { useLocale, useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { conflictRows, exemptRows, reasonSentences, type ConflictNames, type ConflictRules } from "@/lib/conflict-rows";
import type { ExemptRule } from "@/lib/exemptions";
import type { ConflictHit } from "@/lib/conflicts";
import type { MasterLesson } from "@/lib/types";

export interface ConflictListProps extends ConflictNames {
  open: boolean;
  /** The page's weekly rows and year spans: with them a closed hour is said by whose it is, as a refused save says it. */
  rules?: ConflictRules;
  onOpenChange: (open: boolean) => void;
  conflictMap: ReadonlyMap<string, readonly ConflictHit[]>;
  /**
   * Undantag med flit: lesson id → the rules it stands against on purpose (lib/exemptions.ts splitExemptions). Said under a heading of its
   * own and not in red: an exemption is an answer an administrator gave, and "Får stå" is a lesson nobody has answered for.
   */
  exemptions?: ReadonlyMap<string, readonly ExemptRule[]>;
  /**
   * Lesson id → the rules of its exemptions the lesson breaks now (lib/exemptions.ts). A rule not here is said as an exemption nothing
   * needs at the moment. Absent: every rule is said to stand.
   */
  exemptionStanding?: ReadonlyMap<string, readonly ExemptRule[]>;
  lessonById: ReadonlyMap<string, MasterLesson>;
  /**
   * Opens Justera lektion for the lesson. Absent for a reader (Läsbehörighet): the page gives a profile that changes nothing no
   * editor, from the grid or from here, so the list is then only read.
   */
  onGo?: (lessonId: string) => void;
}

export function ConflictList({ open, rules, onOpenChange, conflictMap, exemptions, exemptionStanding, lessonById, group, subject, onGo }: ConflictListProps) {
  const t = useTranslations("timetable");
  const tCommon = useTranslations("common");
  const tDays = useTranslations("days");
  // The weekdays of the catalogue start with a capital, and in Swedish a day in the middle of a sentence does not.
  const locale = useLocale();
  const dayName = (day: number) => (locale === "sv" ? tDays(String(day)).toLocaleLowerCase("sv") : tDays(String(day)));
  const rows = open ? conflictRows(conflictMap, lessonById, { group, subject }, rules) : [];
  const exempt = open && exemptions ? exemptRows(exemptions, lessonById) : [];
  const lessonSentence = (lesson: MasterLesson) =>
    t("conflictListLesson", {
      subjectName: subject(lesson.subjectId),
      className: group(lesson.studentGroupId),
      day: dayName(lesson.dayOfWeek),
      start: lesson.startTime.slice(0, 5),
      end: lesson.endTime.slice(0, 5),
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("conflictListTitle")}</DialogTitle>
          <DialogDescription>{t("conflictListBody")}</DialogDescription>
        </DialogHeader>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("conflictListEmpty")}</p>
        ) : (
          <ul className="space-y-3">
            {rows.map(({ lesson, reasons }) => (
              <li key={lesson.id} className="min-w-0 rounded-md border px-3 py-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="min-w-0 break-words text-sm font-medium">{lessonSentence(lesson)}</p>
                  {onGo ? (
                    <Button variant="outline" size="sm" onClick={() => onGo(lesson.id)} data-writes="SCHEMALAGGNING DRIFT">
                      {t("conflictListGo")}
                    </Button>
                  ) : null}
                </div>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-destructive">
                  {reasonSentences(reasons, t("conflictRoomLock"), tCommon).map((sentence, index) => (
                    <li key={`${index}-${sentence}`} className="break-words">
                      {sentence}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
        {exempt.length > 0 ? (
          <section aria-labelledby="conflict-list-exemptions" className="space-y-2">
            <h3 id="conflict-list-exemptions" className="text-sm font-semibold">
              {t("conflictListExemptionsTitle")}
            </h3>
            <p className="text-xs text-muted-foreground">{t("conflictListExemptionsBody")}</p>
            <ul className="space-y-3">
              {exempt.map(({ lesson, rules: given }) => (
                <li key={lesson.id} className="min-w-0 rounded-md border border-dashed px-3 py-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="min-w-0 break-words text-sm font-medium">{lessonSentence(lesson)}</p>
                    {onGo ? (
                      <Button variant="outline" size="sm" onClick={() => onGo(lesson.id)} data-writes="SCHEMALAGGNING DRIFT">
                        {t("conflictListGo")}
                      </Button>
                    ) : null}
                  </div>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                    {given.map((rule) => (
                      <li key={rule} className="break-words">
                        {exemptionStanding === undefined || exemptionStanding.get(lesson.id)?.includes(rule)
                          ? t(`conflictExempt${rule}` as never)
                          : t("conflictExemptIdle", { rule })}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
