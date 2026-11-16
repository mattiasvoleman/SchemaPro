"use client";

import { useEffect, useId, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { FormField } from "@/components/ui/form-field";
import { minutesOfField, type Drop } from "@/lib/placement-drop";
import { PLACEMENT_DAY_END, PLACEMENT_DAY_START, PLACEMENT_GRID_MINUTES, clockOfMinutes } from "@/lib/requirement-placement-text";

/*
 * Dag, Start and Sal, and the sentence under them: the keyboard's way of laying
 * or moving a förläggning (the row "Lägg vald lektion" and the card's dialog).
 * Fetched when a brick is chosen or a card opened, not with the page.
 *
 * The sentence is the verdict in words, said aloud when it changes (aria-live):
 * "Ledigt", or the gateway's own sentence for what is in the way. Until the
 * gateway has been asked, the mirror of its judge answers (placement-mirror.ts);
 * after a refusal the gateway's sentence stands until a field changes.
 */

export interface PlaceValue {
  dayOfWeek: number;
  startMinutes: number;
  roomId: string | null;
}

export interface PlaceFieldsProps {
  /** One of "add" (the row beside the brick) and "edit" (a laid card). */
  submitLabel: string;
  minutes: number;
  rooms: ReadonlyArray<{ id: string; name: string }>;
  initial: PlaceValue;
  /** What the mirror says of a spot: the sentence for what is in the way, or null when it holds. */
  sentenceOf: (value: PlaceValue) => { drop: Drop; text: string };
  /** The next time the lesson stands free after this one, or null when none is. */
  nextFree: (value: PlaceValue) => { dayOfWeek: number; startMinutes: number } | null;
  /** A refusal the gateway gave at the last try: said in place of the mirror's sentence until a field changes. */
  refusal: string | null;
  saving: boolean;
  onSubmit: (value: PlaceValue) => void;
  /** Focus goes to the day field when this changes (a brick chosen, a card opened). */
  focusKey: string;
  /** The values as they stand in the fields (null when the start is no time), for a press on the week that lays the lesson with this room. */
  onValueChange?: (value: PlaceValue | null) => void;
}

const DAYS = [1, 2, 3, 4, 5] as const;

export function PlaceFields({ submitLabel, minutes, rooms, initial, sentenceOf, nextFree, refusal, saving, onSubmit, focusKey, onValueChange }: PlaceFieldsProps) {
  const t = useTranslations("placementWeek");
  const tPlacements = useTranslations("requirements.placements");
  const tDays = useTranslations("days");
  const id = useId();
  const [day, setDay] = useState(String(initial.dayOfWeek));
  const [start, setStart] = useState(clockOfMinutes(initial.startMinutes));
  const [roomId, setRoomId] = useState(initial.roomId ?? "");
  // The refusal belongs to the values it was given for; a field that changes ends it.
  const [staleRefusal, setStaleRefusal] = useState(false);
  useEffect(() => setStaleRefusal(false), [refusal]);

  const startMinutes = minutesOfField(start);
  const value: PlaceValue | null = startMinutes === null ? null : { dayOfWeek: Number(day), startMinutes, roomId: roomId === "" ? null : roomId };
  const verdict = value ? sentenceOf(value) : null;
  const end = startMinutes === null ? null : clockOfMinutes(startMinutes + minutes);
  const said = refusal !== null && !staleRefusal ? refusal : verdict ? verdict.text : t("noStart");
  const edit = (change: () => void) => {
    setStaleRefusal(true);
    change();
  };

  const valueDay = value?.dayOfWeek;
  const valueStart = value?.startMinutes;
  const valueRoom = value?.roomId;
  useEffect(() => {
    onValueChange?.(valueDay === undefined || valueStart === undefined ? null : { dayOfWeek: valueDay, startMinutes: valueStart, roomId: valueRoom ?? null });
  }, [valueDay, valueStart, valueRoom, onValueChange]);

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
      <div className="grid gap-3 sm:grid-cols-3 [&>*]:min-w-0">
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
        <FormField id={`${id}-room`} label={tPlacements("room")}>
          <NativeSelect value={roomId} onChange={(event) => edit(() => setRoomId(event.target.value))}>
            {/* The empty choice is a choice: the engine chooses the room at every Generera. */}
            <option value="">{tPlacements("roomAny")}</option>
            {rooms.map((room) => (
              <option key={room.id} value={room.id}>
                {room.name}
              </option>
            ))}
          </NativeSelect>
        </FormField>
      </div>
      <p role="status" aria-live="polite" className="text-sm" data-testid="place-verdict">
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
