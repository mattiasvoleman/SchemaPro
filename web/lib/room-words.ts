import { clockOf, type RoomChoice } from "@/lib/possible-times";

/** A translator of the `boardPossible` catalogue, and of `days`: what both the room chooser of Justera lektion and the tray's lay form say a room in. */
type Say = (key: string, values?: Record<string, string | number>) => string;

/**
 * What the gateway says of one room for a lesson laid at a time (src/calendar/room-choices.ts), in words: the lesson's own room, free (and its rank),
 * busy (and with what), shut (and by which rule), too small, of another type, outside the group's years, shared. One sentence for both places that
 * list the rooms, so that they cannot say it two ways.
 */
export function roomWords(room: RoomChoice, t: Say, tDays: Say): string {
  const parts: string[] = [];
  if (room.current) parts.push(t("rooms.current"));
  if (room.state === "FREE") parts.push(room.rank !== null ? t("rooms.free", { rank: room.rank }) : t("rooms.freeNotRanked"));
  if (room.state === "BUSY" && room.occupant) {
    parts.push(
      t("rooms.busy", {
        subject: room.occupant.subjectName,
        className: room.occupant.className,
        day: tDays(String(room.occupant.dayOfWeek)),
        from: clockOf(room.occupant.startMinutes),
        to: clockOf(room.occupant.endMinutes),
        more: room.occupants - 1,
      }),
    );
  }
  if (room.state === "BUSY" && !room.occupant) parts.push(t("rooms.busyUnnamed"));
  if (room.state === "CLOSED") parts.push(t("rooms.closed", { rule: t(`closed.${room.closedBy ?? "AVAILABILITY"}`) }));
  if (room.tooSmall) parts.push(t("rooms.tooSmall"));
  if (!room.typeOk) parts.push(t("rooms.wrongType"));
  if (room.typeOk && !room.tooSmall && !room.allowed) parts.push(t("rooms.outsideYears"));
  if (room.shared) parts.push(t("rooms.shared"));
  return parts.join(", ");
}
