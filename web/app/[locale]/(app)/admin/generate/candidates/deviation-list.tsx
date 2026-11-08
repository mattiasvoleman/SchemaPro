"use client";

import { useTranslations } from "next-intl";
import { engineMessage, type MessageLookup } from "@/lib/engine-message";
import type { CandidateConflict } from "@/lib/candidates/types";

/*
 * Bästa möjliga schema: the rules a candidate's timetable breaks, as a list of
 * sentences — the review under "Granska ett förslag" and the Tillämpa dialog
 * draw the same list, so what is read is what is accepted.
 *
 * The sentences are the engine's DEVIATION_* ones, rendered from their code
 * and values by the same helper as every other engine sentence
 * (lib/engine-message.ts), the engine's English when a code or a value is
 * missing. The gateway has already named the rule, the subject and the teacher
 * for the reader who may see them, and masked the rest: nothing is masked or
 * resolved here.
 *
 * ONE SENTENCE THE WEB SAYS ITSELF. A post's days are HR data, and the gateway
 * masks a sentence that bears them for a reader without HR-läs as
 * TEACHER_WORK_DAYS_HIDDEN ("one of the reasons the timetable could not be
 * made"). That is a refusal's sentence, and a deviation is a timetable that WAS
 * made. So the masked sentence, in either shape it can arrive (the hidden code,
 * or the deviation's own code with its days gone), is said here as a deviation.
 */

/** The masked sentence of a post's days, as the gateway sends it. */
const DAYS_HIDDEN = "TEACHER_WORK_DAYS_HIDDEN";
const DAYS_DEVIATION = "DEVIATION_TEACHER_WORK_DAYS";

/** Whether the days of a post were taken out of this sentence. */
function daysMasked(deviation: CandidateConflict): boolean {
  if (deviation.code === DAYS_HIDDEN) return true;
  return deviation.code === DAYS_DEVIATION && deviation.params?.["days"] === undefined;
}

export interface DeviationListProps {
  deviations: readonly CandidateConflict[];
  /** The heading (or label) that says what the list is. */
  "aria-labelledby"?: string;
  id?: string;
}

export function DeviationList({ deviations, id, "aria-labelledby": labelledBy }: DeviationListProps) {
  const t = useTranslations("scheduleCandidates");
  const tEngine = useTranslations("engineMessages");
  const sentence = (deviation: CandidateConflict): string =>
    daysMasked(deviation)
      ? t("deviations.daysHidden")
      : engineMessage(tEngine as unknown as MessageLookup, deviation);

  return (
    <ul id={id} aria-labelledby={labelledBy} className="list-disc space-y-2 pl-5 text-sm text-foreground">
      {deviations.map((deviation, index) => (
        <li key={index} className="space-y-0.5">
          <p>{sentence(deviation)}</p>
          {/* Who or what it is about, for the reader who may see it. */}
          {!daysMasked(deviation) && deviation.resourceNames && deviation.resourceNames.length > 0 ? (
            <p className="font-medium">{deviation.resourceNames.join(", ")}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
