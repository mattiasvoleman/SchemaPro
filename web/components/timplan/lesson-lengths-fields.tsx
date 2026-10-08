"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Plus, X } from "lucide-react";
import { MAX_DISTINCT_LENGTHS, lengthPartsOf, weeklyMinutesOf } from "@/lib/lesson-lengths";
import { shapeFromDraft, type DraftPart } from "@/lib/lesson-lengths-text";
import { useLengthsInWords } from "@/components/timplan/use-lengths-in-words";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
 * is typed, and it is what the save button waits on — the page points the
 * button's aria-describedby at `statusId` while extra lengths exist. The live
 * element is always mounted (empty, and out of the flow, for a uniform post),
 * because a region that appears together with its first sentence is not
 * announced by VoiceOver or NVDA.
 *
 * The extra rows line up under the first pair: the page gives that pair the
 * same three columns (EXTRA_ROW_GRID) while extra rows exist, the third being
 * the remove button's width, and every extra field has a visible label of its
 * own. Removing a row unmounts the button pressed, so focus moves to "Lägg
 * till en längd" instead of falling out of the dialog.
 */

/** The grid an extra row uses, and the first pair while extra rows exist. */
export const EXTRA_ROW_GRID = "grid grid-cols-[1fr_1fr_2.25rem] items-end gap-4";

export function LessonLengthsFields({
  first,
  extra,
  onChange,
  statusId,
}: {
  first: DraftPart;
  extra: DraftPart[];
  onChange: (next: DraftPart[]) => void;
  /** The live sentence's id, for the save button's aria-describedby. */
  statusId: string;
}) {
  const t = useTranslations("requirements");
  const inWords = useLengthsInWords();
  // The row just added takes the focus on its minutes field, so the action
  // that adds it is followed by the one thing still to type.
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const idPrefix = useId();
  const addRef = useRef<HTMLButtonElement>(null);
  const [focusAdd, setFocusAdd] = useState(false);
  useEffect(() => {
    if (!focusAdd) return;
    addRef.current?.focus();
    setFocusAdd(false);
  }, [focusAdd, extra.length]);
  const update = (index: number, patch: Partial<DraftPart>) =>
    onChange(extra.map((part, i) => (i === index ? { ...part, ...patch } : part)));

  const resolved = extra.length > 0 ? shapeFromDraft([first, ...extra]) : null;
  return (
    // A flex column, not space-y: the always-mounted live sentence is out of
    // the flow while empty, and a gap — unlike space-y's sibling margin —
    // never counts an out-of-flow child, so a uniform post's dialog keeps its
    // spacing to the pixel.
    <div className="flex flex-col gap-2">
      {extra.map((part, index) => {
        // Lengths are numbered from the dialog's own first pair, which is 1.
        const n = index + 2;
        const lessonsId = `${idPrefix}-lessons-${n}`;
        const minutesId = `${idPrefix}-minutes-${n}`;
        return (
          <div key={index} className={EXTRA_ROW_GRID}>
            <div className="space-y-2">
              <Label htmlFor={lessonsId}>{t("lengthLessons", { n })}</Label>
              <Input
                id={lessonsId}
                type="number"
                min={1}
                max={20}
                value={part.lessons}
                onChange={(e) => update(index, { lessons: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={minutesId}>{t("lengthMinutes", { n })}</Label>
              <Input
                id={minutesId}
                type="number"
                min={15}
                max={240}
                step={5}
                autoFocus={focusIndex === index}
                value={part.minutes}
                onChange={(e) => update(index, { minutes: e.target.value })}
              />
            </div>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={t("removeLength", { n })}
              onClick={() => {
                setFocusIndex(null);
                setFocusAdd(true);
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
          ref={addRef}
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 self-start px-2 text-xs"
          onClick={() => {
            setFocusIndex(extra.length);
            onChange([...extra, { lessons: "1", minutes: "" }]);
          }}
        >
          <Plus />
          {t("addLength")}
        </Button>
      ) : null}
      <p id={statusId} aria-live="polite" className={resolved ? "text-xs text-muted-foreground" : "sr-only"}>
        {resolved
          ? resolved.shape
            ? t("lengthsSummary", {
                lessons: resolved.shape.lessonsPerWeek,
                minutes: weeklyMinutesOf(resolved.shape),
                parts: inWords(lengthPartsOf(resolved.shape)),
              })
            : t(`lengthsProblem.${resolved.problem}`)
          : null}
      </p>
    </div>
  );
}
