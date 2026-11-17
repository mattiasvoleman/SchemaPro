"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import type { Half } from "@/lib/placement-pair";

/*
 * Veckor, in the row that lays a chosen brick (D2): every week as always, or a PAIR, one lesson in two places (odd weeks in
 * one, even weeks in the other), laid half by half. The first half is held in the page and not written, and this says so,
 * in words, next to the button that lets it go. Fetched with the row's other fields, when a brick is chosen.
 */

/** The reader's choice for the chosen brick: every week, or a pair that starts with the odd weeks or with the even ones. */
export type WeeksChoice = "ALL_WEEKS" | Half;

export interface PairFieldsProps {
  choice: WeeksChoice;
  onChoice: (choice: WeeksChoice) => void;
  /** The sentence about the held half, when one is held (the choice then cannot change). */
  heldBody: string | null;
  onRelease: () => void;
  disabled: boolean;
}

export function PairFields({ choice, onChoice, heldBody, onRelease, disabled }: PairFieldsProps) {
  const t = useTranslations("placementWeek.pair");
  const id = useId();
  return (
    <div className="space-y-2" data-testid="pair-fields">
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-weeks`}>{t("weeksLabel")}</Label>
        <NativeSelect
          id={`${id}-weeks`}
          value={choice}
          disabled={disabled || heldBody !== null}
          onChange={(event) => onChoice(event.target.value as WeeksChoice)}
          className="w-auto min-w-44 max-w-full"
        >
          <option value="ALL_WEEKS">{t("everyWeek")}</option>
          <option value="ODD_WEEKS">{t("oddFirst")}</option>
          <option value="EVEN_WEEKS">{t("evenFirst")}</option>
        </NativeSelect>
        {choice !== "ALL_WEEKS" && heldBody === null ? <p className="text-xs text-muted-foreground">{t("hint")}</p> : null}
      </div>
      {heldBody !== null ? (
        <div className="space-y-2 rounded-md border border-dashed border-foreground/50 p-2" role="group" aria-label={t("heldTitle")} data-testid="pair-held">
          <p className="text-sm font-medium">{t("heldTitle")}</p>
          <p className="text-sm [overflow-wrap:anywhere]">{heldBody}</p>
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={onRelease}>
            {t("release")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
