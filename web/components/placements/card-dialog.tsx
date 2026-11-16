"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { PlaceFields, type PlaceFieldsProps, type PlaceValue } from "@/components/placements/place-fields";

/*
 * A card of the week, opened (a press, or Enter on it): what it is, and for the
 * school that writes Planering, what can be done with it: change its day, start
 * and room, or take it away. A lesson Generera keeps is only described, with
 * where it is changed. Fetched when a card is first opened, not with the page.
 *
 * Focus goes to the first field and, when the dialog closes, back to the card
 * (Radix returns it to the element that was focused).
 */

export interface PlacedCard {
  /** The lesson's key (placement-rows.ts): not a row id, which every save changes. */
  key: string;
  /** Its post, whose line in the list below the week the dialog can lead to. */
  postId: string;
  title: string;
  /** "tisdag 10:00–11:00 · Motorn väljer sal · udda". */
  line: string;
  /** The judge's word on the row as stored: "Håller." or its sentence. */
  verdictText: string;
  savedAt: string;
  minutes: number;
  initial: PlaceValue;
  /** A half of a pair: removing it removes both, and the school is asked first. */
  pair: string | null;
}

export interface KeptCard {
  title: string;
  line: string;
  note: string;
}

export interface CardDialogProps {
  placed?: PlacedCard;
  kept?: KeptCard;
  mayWrite: boolean;
  fields: Pick<PlaceFieldsProps, "rooms" | "sentenceOf" | "nextFree" | "refusal" | "saving">;
  onSave: (value: PlaceValue) => void;
  onRemove: () => void;
  onClose: () => void;
}

export function CardDialog({ placed, kept, mayWrite, fields, onSave, onRemove, onClose }: CardDialogProps) {
  const t = useTranslations("placementWeek");
  const [confirming, setConfirming] = useState(false);
  const title = placed?.title ?? kept?.title ?? "";
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="[overflow-wrap:anywhere]">{title}</DialogTitle>
          <DialogDescription className="[overflow-wrap:anywhere]">{placed?.line ?? kept?.line}</DialogDescription>
        </DialogHeader>

        {placed ? (
          <div className="space-y-4">
            <p className="text-sm [overflow-wrap:anywhere]" data-testid="card-verdict">
              {placed.verdictText}
            </p>
            <p className="text-xs text-muted-foreground">{t("savedAt", { when: placed.savedAt })}</p>
            {/* To the post's line in the list under the week: everybody's, the läsare's too. */}
            <Button variant="outline" size="sm" asChild>
              <a href={`#post-${placed.postId}`} onClick={onClose}>
                {t("toPost")}
              </a>
            </Button>
            {/* Only the school that writes Planering is offered what changes the row; the gateway refuses the rest. */}
            {mayWrite ? (
              <div data-writes="PLANERING" className="space-y-4">
                <PlaceFields
                  {...fields}
                  submitLabel={t("save")}
                  minutes={placed.minutes}
                  initial={placed.initial}
                  focusKey={placed.key}
                  onSubmit={onSave}
                />
                {confirming ? (
                  <div className="space-y-2 rounded-md border p-3" role="group" aria-label={t("removePairTitle")}>
                    <p className="text-sm">{placed.pair}</p>
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" variant="destructive" size="sm" onClick={onRemove} disabled={fields.saving}>
                        {t("removePair")}
                      </Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(false)}>
                        {t("cancel")}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button type="button" variant="outline" size="sm" disabled={fields.saving} onClick={() => (placed.pair ? setConfirming(true) : onRemove())}>
                    {t("remove")}
                  </Button>
                )}
                <p className="text-xs text-muted-foreground">{t("fromNextGenerate")}</p>
              </div>
            ) : null}
          </div>
        ) : kept ? (
          <div className="space-y-3">
            <p className="text-sm [overflow-wrap:anywhere]">{kept.note}</p>
            {/* A page that is the schemaläggare's: shown to the profile that writes Schemaläggning, hidden from the rest. */}
            <Button variant="outline" size="sm" asChild data-writes="SCHEMALAGGNING">
              <Link href="/admin/timetable">{t("toTimetable")}</Link>
            </Button>
          </div>
        ) : null}

      </DialogContent>
    </Dialog>
  );
}
