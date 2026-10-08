"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Plus, X } from "lucide-react";
import { MAX_DISTINCT_LENGTHS, lengthPartsOf, weeklyMinutesOf } from "@/lib/lesson-lengths";
import { shapeFromDraft, type DraftPart } from "@/lib/lesson-lengths-text";
import { useLengthsInWords } from "@/components/timplan/use-lengths-in-words";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Lektionslängder in the cell dialog: the lengths after the first.
 *
 * A UNIFORM POST STAYS AS SIMPLE AS IT WAS. The dialog's own two fields are
 * the first length; this adds nothing above them but one quiet button, "Lägg
 * till en längd", and a post that never presses it is saved exactly as
 * before. Pressing it is the one action that turns "2 × 60" into "1 × 80 +
 * 1 × 40": a row of the same two fields appears under the first, focused on
 * its minutes. Up to three lengths (the CHECK's cap); removing the last extra
 * row makes the post uniform again.
 *
 * Under the rows, while there are two or more, one sentence says what the
 * post now is — "2 lektioner, 120 minuter i veckan: 1 lektion à 80 minuter
 * och 1 lektion à 40 minuter." — or, while the fields cannot be stored, why
 * not. It is polite-live, so a screen reader hears the total move as a length
 * is typed, and it is what the save button waits on.
 */
export function LessonLengthsFields({
  first,
  extra,
  onChange,
}: {
  first: DraftPart;
  extra: DraftPart[];
  onChange: (next: DraftPart[]) => void;
}) {
  const t = useTranslations("requirements");
  const inWords = useLengthsInWords();
  // The row just added takes the focus on its minutes field, so the action
  // that adds it is followed by the one thing still to type.
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const update = (index: number, patch: Partial<DraftPart>) =>
    onChange(extra.map((part, i) => (i === index ? { ...part, ...patch } : part)));

  const resolved = extra.length > 0 ? shapeFromDraft([first, ...extra]) : null;
  return (
    <div className="space-y-2">
      {extra.map((part, index) => {
        // Lengths are numbered from the dialog's own first pair, which is 1.
        const n = index + 2;
        return (
          <div key={index} className="grid grid-cols-[1fr_1fr_auto] items-center gap-4">
            <Input
              type="number"
              min={1}
              max={20}
              aria-label={t("lengthLessons", { n })}
              value={part.lessons}
              onChange={(e) => update(index, { lessons: e.target.value })}
            />
            <Input
              type="number"
              min={15}
              max={240}
              step={5}
              aria-label={t("lengthMinutes", { n })}
              autoFocus={focusIndex === index}
              value={part.minutes}
              onChange={(e) => update(index, { minutes: e.target.value })}
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={t("removeLength", { n })}
              onClick={() => {
                setFocusIndex(null);
                onChange(extra.filter((_, i) => i !== index));
              }}
            >
              <X />
            </Button>
          </div>
        );
      })}
      {extra.length + 1 < MAX_DISTINCT_LENGTHS ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          onClick={() => {
            setFocusIndex(extra.length);
            onChange([...extra, { lessons: "1", minutes: "" }]);
          }}
        >
          <Plus />
          {t("addLength")}
        </Button>
      ) : null}
      {resolved ? (
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {resolved.shape
            ? t("lengthsSummary", {
                lessons: resolved.shape.lessonsPerWeek,
                minutes: weeklyMinutesOf(resolved.shape),
                parts: inWords(lengthPartsOf(resolved.shape)),
              })
            : t(`lengthsProblem.${resolved.problem}`)}
        </p>
      ) : null}
    </div>
  );
}
