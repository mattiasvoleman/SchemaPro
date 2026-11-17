"use client";

import { useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { FormField } from "@/components/ui/form-field";
import type { Drop } from "@/lib/placement-drop";
import { minutesOfField } from "@/lib/placement-field";
import { PLACEMENT_DAY_END, PLACEMENT_DAY_START, PLACEMENT_GRID_MINUTES, clockOfMinutes } from "@/lib/requirement-placement-text";

/*
 * Dag, Start and ONE ROOM FOR EACH POST of a parallel block, and the sentence under them: the keyboard's way of laying or moving a
 * lesson of a block (the row "Lägg vald lektion" and the card's dialog). The row of a single post is place-fields.tsx; a block's
 * lesson is one fact about the block with a room per post, so it is its own, beside that one, and the dialog on Timplansposter
 * (components/timplan/block-placement-dialog.tsx) is another way to the same rows and is not reused. Fetched when a brick is
 * chosen or a card opened, not with the page.
 *
 * The first choice of every room is "Motorn väljer sal": the post is then sent with no room and the engine chooses it at every
 * Generera. The sentence is the verdict in words, said aloud when it changes (aria-live), and names the post that clashes.
 */

/** The values of the fields: where the lesson stands and the room each post chose (null: the engine chooses). */
export interface BlockPlaceValue {
  dayOfWeek: number;
  startMinutes: number;
  /** By the post's id. A post that is not named has the engine's choice. */
  rooms: Record<string, string | null>;
}

export interface BlockPlaceFieldsProps {
  submitLabel: string;
  minutes: number;
  /** The block's posts, in the order they are asked, each by the name the page gives it ("Tyska 7TY"). */
  members: ReadonlyArray<{ id: string; name: string }>;
  rooms: ReadonlyArray<{ id: string; name: string }>;
  initial: BlockPlaceValue;
  /** What the mirror says of a spot with these rooms: the sentence for what is in the way, or "Ledigt". */
  sentenceOf: (value: BlockPlaceValue) => { drop: Drop; text: string };
  /** The next time the lesson stands free after this one, or null when none is. */
  nextFree: (value: BlockPlaceValue) => { dayOfWeek: number; startMinutes: number } | null;
  /** A refusal the gateway gave at the last try: said in place of the mirror's sentence until a field changes. */
  refusal: string | null;
  saving: boolean;
  onSubmit: (value: BlockPlaceValue) => void;
  /** Focus goes to the day field when this changes (a brick chosen, a card opened). */
  focusKey: string;
  /** The values as they stand in the fields (null when the start is no time), for a press on the week that lays the lesson with these rooms. */
  onValueChange?: (value: BlockPlaceValue | null) => void;
}

const DAYS = [1, 2, 3, 4, 5] as const;

export function BlockPlaceFields({ submitLabel, minutes, members, rooms, initial, sentenceOf, nextFree, refusal, saving, onSubmit, focusKey, onValueChange }: BlockPlaceFieldsProps) {
  const t = useTranslations("placementWeek");
  const tBlock = useTranslations("placementWeek.block");
  const tPlacements = useTranslations("requirements.placements");
  const tDays = useTranslations("days");
  const id = useId();
  const [day, setDay] = useState(String(initial.dayOfWeek));
  const [start, setStart] = useState(clockOfMinutes(initial.startMinutes));
  const [roomOf, setRoomOf] = useState<Record<string, string>>(() => Object.fromEntries(members.map((member) => [member.id, initial.rooms[member.id] ?? ""])));
  // The refusal belongs to the values it was given for; a field that changes ends it.
  const [staleRefusal, setStaleRefusal] = useState(false);
  useEffect(() => setStaleRefusal(false), [refusal]);

  const startMinutes = minutesOfField(start);
  const chosen = Object.fromEntries(members.map((member) => [member.id, roomOf[member.id] ? roomOf[member.id]! : null]));
  const value: BlockPlaceValue | null = startMinutes === null ? null : { dayOfWeek: Number(day), startMinutes, rooms: chosen };
  const verdict = value ? sentenceOf(value) : null;
  const end = startMinutes === null ? null : clockOfMinutes(startMinutes + minutes);
  const said = refusal !== null && !staleRefusal ? refusal : verdict ? verdict.text : t("noStart");
  const edit = (change: () => void) => {
    setStaleRefusal(true);
    change();
  };

  const valueDay = value?.dayOfWeek;
  const valueStart = value?.startMinutes;
  const roomsText = members.map((member) => roomOf[member.id] ?? "").join("|");
  useEffect(() => {
    onValueChange?.(valueDay === undefined || valueStart === undefined ? null : { dayOfWeek: valueDay, startMinutes: valueStart, rooms: Object.fromEntries(members.map((member, at) => [member.id, roomsText.split("|")[at] ? roomsText.split("|")[at]! : null])) });
    // `members` is rebuilt by the page; what the fields hold is what changes the value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueDay, valueStart, roomsText, onValueChange]);

  const dayId = `${id}-day`;
  useEffect(() => {
    // A brick just chosen, a card just opened: the keyboard goes to the first field.
    document.getElementById(dayId)?.focus({ preventScroll: false });
  }, [focusKey, dayId]);

  const next = () => {
    if (!value) return;
    const spot = nextFree(value);
    if (!spot) return;
    edit(() => {
      setDay(String(spot.dayOfWeek));
      setStart(clockOfMinutes(spot.startMinutes));
    });
  };

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (value && verdict?.drop.kind !== "DAY") onSubmit(value);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
        <div className="space-y-1.5">
          <Label htmlFor={dayId}>{tPlacements("day")}</Label>
          <NativeSelect id={dayId} value={day} onChange={(event) => edit(() => setDay(event.target.value))}>
            {DAYS.map((entry) => (
              <option key={entry} value={entry}>
                {tDays(String(entry))}
              </option>
            ))}
          </NativeSelect>
        </div>
        <FormField id={`${id}-start`} label={tPlacements("start")} hint={end ? tPlacements("ends", { end }) : undefined}>
          <Input
            type="time"
            step={PLACEMENT_GRID_MINUTES * 60}
            min={clockOfMinutes(PLACEMENT_DAY_START)}
            max={clockOfMinutes(PLACEMENT_DAY_END - PLACEMENT_GRID_MINUTES)}
            value={start}
            onChange={(event) => edit(() => setStart(event.target.value))}
          />
        </FormField>
      </div>
      <fieldset className="min-w-0 space-y-2 rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">{tBlock("roomsLegend")}</legend>
        <p className="text-xs text-muted-foreground">{tBlock("roomsHint")}</p>
        {/* A post's name can be long (a subject and a group): it breaks inside the word at 320 px rather than leave the dialog. */}
        <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
          {members.map((member) => (
            <div key={member.id} className="space-y-1.5">
              <Label htmlFor={`${id}-room-${member.id}`} className="break-words">
                {tBlock("roomOf", { post: member.name })}
              </Label>
              <NativeSelect id={`${id}-room-${member.id}`} value={roomOf[member.id] ?? ""} onChange={(event) => edit(() => setRoomOf((current) => ({ ...current, [member.id]: event.target.value })))}>
                {/* The empty choice is a choice: the engine chooses the post's room at every Generera. */}
                <option value="">{tPlacements("roomAny")}</option>
                {rooms.map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          ))}
        </div>
      </fieldset>
      <p role="status" aria-live="polite" className="text-sm [overflow-wrap:anywhere]" data-testid="place-verdict">
        {said}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={saving || value === null}>
          {submitLabel}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={saving || value === null} onClick={next}>
          {t("nextFree")}
        </Button>
      </div>
    </form>
  );
}
