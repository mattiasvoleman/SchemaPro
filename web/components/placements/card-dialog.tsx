"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BlockPlaceFields, type BlockPlaceFieldsProps, type BlockPlaceValue } from "@/components/placements/block-place-fields";
import { PlaceFields, type PlaceFieldsProps, type PlaceValue } from "@/components/placements/place-fields";

/*
 * A card of the week, opened (a press, or Enter on it): what it is, and for the
 * school that writes Planering, what can be done with it: change its day, start
 * and room, or take it away. A lesson Generera keeps is only described, with
 * where it is changed. A lesson of a PARALLEL BLOCK is the third kind: its day, its start and a room for each post, the judge's word
 * on each post that does not hold, and "Ta bort" (no question: a block has no pairs). Fetched when a card is first opened, not with
 * the page.
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

/** A lesson of a parallel block, opened. */
export interface PlacedBlockCard {
  /** The lesson's key (placement-block-rows.ts): not a row id, which every save changes. */
  key: string;
  blockId: string;
  /** "Språkval åk 7 · 60 min". */
  title: string;
  /** "tisdag 10:00–11:00 · Sal på 2 av 3 poster · udda". */
  line: string;
  /** What the judge says of the lesson as stored: "Håller.", or a sentence for each group of posts that do not hold it. */
  verdictLines: string[];
  savedAt: string;
  minutes: number;
  initial: BlockPlaceValue;
  /** The block's posts, as they are asked for a room. */
  members: ReadonlyArray<{ id: string; name: string }>;
}

export interface KeptCard {
  title: string;
  line: string;
  note: string;
}

export interface CardDialogProps {
  placed?: PlacedCard;
  kept?: KeptCard;
  block?: PlacedBlockCard;
  mayWrite: boolean;
  fields: Pick<PlaceFieldsProps, "rooms" | "sentenceOf" | "nextFree" | "refusal" | "saving">;
  blockFields?: Pick<BlockPlaceFieldsProps, "rooms" | "sentenceOf" | "nextFree" | "refusal" | "saving">;
  onSave: (value: PlaceValue) => void;
  onSaveBlock?: (value: BlockPlaceValue) => void;
  onRemove: () => void;
  onClose: () => void;
}

export function CardDialog({ placed, kept, block, mayWrite, fields, blockFields, onSave, onSaveBlock, onRemove, onClose }: CardDialogProps) {
  const t = useTranslations("placementWeek");
  const tBlock = useTranslations("placementWeek.block");
  const [confirming, setConfirming] = useState(false);
  const title = placed?.title ?? block?.title ?? kept?.title ?? "";
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      {/* A grid's one column is as wide as its widest word unless it may be narrower: a block's name of one long word would widen the dialog past a 320 px screen. */}
      <DialogContent className="grid-cols-[minmax(0,1fr)] max-w-lg">
        <DialogHeader>
          <DialogTitle className="[overflow-wrap:anywhere]">{title}</DialogTitle>
          <DialogDescription className="[overflow-wrap:anywhere]">{placed?.line ?? block?.line ?? kept?.line}</DialogDescription>
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
        ) : block ? (
          <div className="space-y-4">
            <div className="space-y-1" data-testid="card-verdict">
              {block.verdictLines.map((line) => (
                <p key={line} className="text-sm [overflow-wrap:anywhere]">
                  {line}
                </p>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{t("savedAt", { when: block.savedAt })}</p>
            {/* To the block's line in the list under the week: everybody's, the läsare's too. */}
            <Button variant="outline" size="sm" asChild>
              <a href={`#block-${block.blockId}`} onClick={onClose}>
                {tBlock("toBlock")}
              </a>
            </Button>
            {mayWrite && blockFields && onSaveBlock ? (
              <div data-writes="PLANERING" className="space-y-4">
                <BlockPlaceFields
                  {...blockFields}
                  submitLabel={t("save")}
                  minutes={block.minutes}
                  members={block.members}
                  initial={block.initial}
                  focusKey={block.key}
                  onSubmit={onSaveBlock}
                />
                {/* No question: a block has no pairs, so a removal takes the one lesson and nothing else. */}
                <Button type="button" variant="outline" size="sm" disabled={blockFields.saving} onClick={onRemove}>
                  {t("remove")}
                </Button>
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
