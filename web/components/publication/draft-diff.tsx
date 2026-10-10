"use client";

/*
 * The draft against what is published (GET /publications/state): the lessons
 * the draft adds, changes and removes, each as a line an admin recognises.
 *
 * The gateway compares by lesson id against the snapshot of the publication
 * valid today (else the next ahead, else the last), so a lesson moved is ONE
 * change, said with what moved — the same identity the publish carries the
 * draft over by. The Versioner dialog's diff compares by content instead,
 * because two saved versions share no ids after a restore; reusing it here
 * would show a moved lesson as one added and one removed, which is not what
 * publishing it does.
 */

import { useTranslations } from "next-intl";
import type { DraftState } from "@/lib/publication-types";
import { changedFields, lessonLine, pendingCount, type LessonNames } from "@/lib/publication-view";

const SHOWN = 8;

export function DraftDiff({ state, names }: { state: DraftState; names: LessonNames }) {
  const t = useTranslations("publishing");
  const parked = t("diffParked");
  if (pendingCount(state) === 0 && state.pendingRemovals === 0) {
    return <p className="text-sm">{t("diffNone")}</p>;
  }
  const section = (title: string, lines: string[]) =>
    lines.length === 0 ? null : (
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <ul className="list-disc space-y-0.5 pl-5 text-xs">
          {lines.slice(0, SHOWN).map((line, index) => (
            <li key={index}>{line}</li>
          ))}
          {lines.length > SHOWN ? <li>{t("gateMore", { count: lines.length - SHOWN })}</li> : null}
        </ul>
      </div>
    );
  return (
    <div className="space-y-3">
      <p className="text-sm">
        {t("diffSummary", {
          added: state.added.length,
          changed: state.changed.length,
          removed: state.removed.length,
        })}
      </p>
      {section(
        t("diffAdded"),
        state.added.map((lesson) => lessonLine(lesson, names, parked)),
      )}
      {section(
        t("diffChanged"),
        state.changed.map(({ before, after }) => {
          const what = changedFields(before, after)
            .map((field) => t(`diffField.${field}`))
            .join(", ");
          return `${lessonLine(after, names, parked)} (${what || t("diffField.other")})`;
        }),
      )}
      {section(
        t("diffRemoved"),
        state.removed.map((lesson) => lessonLine(lesson, names, parked)),
      )}
      {state.pendingRemovals > 0 ? (
        <p className="text-xs">{t("diffPendingRemovals", { count: state.pendingRemovals })}</p>
      ) : null}
    </div>
  );
}
