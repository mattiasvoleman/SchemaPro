"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { askRoomChoices, clockOf, type RoomChoice, type RoomChoices } from "@/lib/possible-times";
import type { LessonEditDraft } from "@/components/schedule/lesson-edit-dialog";
import type { MasterLesson } from "@/lib/types";
import { cn } from "@/lib/utils";

/*
 * SALVÄLJAREN IN JUSTERA LEKTION (E3).
 *
 * The rooms of the school for the lesson at the day and clock the fields say, in the order they should be looked at
 * (src/calendar/room-choices.ts): the free rooms the generator would put the lesson in first, ranked, then the free ones it would not
 * (too small, another type), then the busy ones with the lesson that stands in them, then the shut ones. A button fills the Sal field;
 * the dialog's own question says what the judge thinks, and Spara lays the lesson.
 *
 * Closed until opened and asked only then, and again when the day or the clock changes while it is open (after a moment, as the
 * judgement is): the answer is for the time the fields say.
 */

const DELAY_MS = 300;

export function LessonRoomChoices({
  lesson,
  draft,
  onDraftChange,
  none,
}: {
  lesson: MasterLesson;
  draft: LessonEditDraft;
  onDraftChange: (draft: LessonEditDraft) => void;
  none: string;
}) {
  const t = useTranslations("boardPossible");
  const tDays = useTranslations("days");
  const [opened, setOpened] = useState(false);
  const [state, setState] = useState<{ key: string; answer: RoomChoices | null } | null>(null);
  const clockOk = /^([01]\d|2[0-3]):[0-5]\d$/.test(draft.startTime);
  const key = `${lesson.id}|${draft.dayOfWeek}|${draft.startTime}`;

  useEffect(() => {
    if (!opened || !clockOk) return;
    const asking = new AbortController();
    const timer = setTimeout(() => {
      askRoomChoices(lesson.id, Number(draft.dayOfWeek), draft.startTime, asking.signal).then(
        (answer) => {
          if (asking.signal.aborted) return;
          setState({ key, answer: answer && Array.isArray(answer.rooms) ? answer : null });
        },
        () => {
          if (!asking.signal.aborted) setState({ key, answer: null });
        },
      );
    }, DELAY_MS);
    return () => {
      clearTimeout(timer);
      asking.abort();
    };
    // The answer is for the day and the start; the end follows the lesson's length and is the gateway's to know.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, key, clockOk]);

  const answered = state?.key === key ? state : null;
  const rooms = answered?.answer?.rooms ?? null;

  const words = (room: RoomChoice): string => {
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
  };

  return (
    <details className="col-span-2 rounded-md border" onToggle={(event) => setOpened((event.currentTarget as HTMLDetailsElement).open)}>
      <summary className="min-h-11 cursor-pointer px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
        {t("rooms.title")}
      </summary>
      <div className="space-y-2 px-3 pb-3 text-sm">
        <p className="text-muted-foreground">{t("rooms.hint")}</p>
        {opened && !clockOk ? <p className="text-muted-foreground">{t("rooms.noClock")}</p> : null}
        {opened && clockOk && !answered ? <p className="text-muted-foreground">{t("list.loading")}</p> : null}
        {answered && !rooms ? <p className="text-muted-foreground">{t("rooms.failed")}</p> : null}
        {rooms && rooms.length === 0 ? <p className="text-muted-foreground">{t("rooms.none")}</p> : null}
        {rooms && rooms.length > 0 ? (
          <ul className="grid gap-1">
            {rooms.map((room) => {
              const chosen = draft.roomId === room.roomId;
              return (
                <li key={room.roomId}>
                  <button
                    type="button"
                    aria-pressed={chosen}
                    onClick={() => onDraftChange({ ...draft, roomId: chosen ? none : room.roomId })}
                    className={cn(
                      "grid min-h-11 w-full gap-0.5 rounded-md border px-3 py-1.5 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                      chosen && "border-primary bg-accent",
                      room.state !== "FREE" && "text-muted-foreground",
                    )}
                  >
                    <span className="font-medium">
                      {room.name}
                      <span className="ml-2 text-xs font-normal tabular-nums">{t("rooms.seats", { capacity: room.capacity ?? -1, needed: room.needed })}</span>
                    </span>
                    <span className="text-xs">{words(room)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </details>
  );
}
