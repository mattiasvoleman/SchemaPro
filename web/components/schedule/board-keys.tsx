"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import {
  focusAfter,
  lengthened,
  LENGTH_STEP_MINUTES,
  markerAfter,
  sameSquare,
  type Arrow,
  type Bounds,
  type KeyLesson,
  type Marker,
} from "./board-keys-logic";

/**
 * The keyboard of the board: a layer the grid fetches when a writer opens the page, so that the route has no bytes for it
 * in its first load (and a reader, who writes nothing, fetches nothing).
 *
 * It draws nothing but one line of text and a list of keys. It listens for keys on the cards of the grid it is given, and
 * does what they mean:
 *
 *   arrows, Home, End    focus moves to another lesson (nothing is moved)
 *   Space or M           takes the lesson up, or puts it down where the marker stands
 *   arrows, taken up     the marker moves a quarter of an hour, or with Shift five minutes, or a day
 *   Enter, taken up      puts it down; a square that is not free opens the page's list of the nearest that are
 *   Esc, taken up        lets go and changes nothing
 *   Alt+Up, Alt+Down     the length, five minutes at a time
 *   L, P, Delete         lock or unlock, park, remove: the page's own writes, each one step of undo
 *   ?                    the list of keys
 *
 * What the page already did with Enter (open the lesson) and Shift+Enter (select it) is left to the grid.
 * Every key that does something is said in the line below the week, a live region (data-board-status), since a screen reader says nothing of
 * a marker or a lock that is only drawn.
 */

export type LessonCommand = "lock" | "park" | "remove";

export interface BoardLesson extends KeyLesson {
  title: string;
  subtitle?: string;
  locked?: boolean;
  duty?: boolean;
}

interface Cell {
  set: (next: { dayOfWeek: number; startMinutes: number; endMinutes: number; valid: boolean } | null) => void;
}

export interface BoardKeysProps extends Bounds {
  lessons: readonly BoardLesson[];
  /** On a phone, the one day that is drawn, and how to draw another; null where all of them are. */
  shownDay: number | null;
  showDay: (day: number) => void;
  /** The grid's body, which the cards are in: the layer listens on it. */
  bodyRef: React.RefObject<HTMLElement | null>;
  /** Where the marker is drawn: the same ghost a drag draws. */
  ghost: Cell;
  validateChange?: (id: string, change: Marker) => boolean;
  onLessonChange?: (id: string, change: Marker) => void;
  onInvalidDrop?: (id: string, change: Marker) => void;
  onLessonCommand?: (id: string, command: LessonCommand) => void;
  /** The card in the tab order, and a way to move it: one card is, and the arrows move it. */
  setRoving: (id: string) => void;
  /** The lesson in hand, for the card to be drawn as one that is. */
  setPicked: (id: string | null) => void;
  /** After a move the card is drawn again, in another column maybe: focus is to follow it. */
  followFocus: (id: string) => void;
}

const clock = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

const ARROWS: ReadonlySet<string> = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]);
/** The keys that do something other than move (lower-cased): what a held key must not do again and again. */
const OWNED_BY_THE_BOARD: ReadonlySet<string> = new Set([" ", "m", "l", "p", "delete", "backspace", "enter", "escape"]);

const DAY_KEYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;

/**
 * The header of the board on a phone: a button for each day, the one that is drawn pressed, and how many lessons each has (in its
 * name too: a screen reader is told "Måndag: 2 lektioner", not "Mån 2"). In this module because it is drawn only on a phone.
 */
export function DayTabs({
  lessons,
  dayCount,
  shown,
  onChoose,
}: {
  lessons: readonly KeyLesson[];
  dayCount: number;
  shown: number | null;
  onChoose: (day: number) => void;
}) {
  const t = useTranslations("boardKeys");
  const tCommon = useTranslations("common");
  const tDays = useTranslations("days");
  return (
    <div role="group" aria-label={t("dayPicker")} className="flex border-b">
      {Array.from({ length: dayCount }, (_, i) => {
        const day = i + 1;
        const count = lessons.filter((lesson) => lesson.dayOfWeek === day).length;
        return (
          <button
            key={day}
            type="button"
            aria-pressed={shown === day}
            aria-label={t("dayTab", { day: tDays(String(day)), count })}
            onClick={() => onChoose(day)}
            className={cn(
              "min-h-11 flex-1 px-1 text-center text-xs font-semibold uppercase tracking-wide focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
              shown === day ? "bg-accent text-accent-foreground" : "text-muted-foreground",
            )}
          >
            {tCommon(DAY_KEYS[i] as string)}
            <span aria-hidden className="block text-[10px] font-medium tabular-nums">
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function BoardKeys(props: BoardKeysProps) {
  const t = useTranslations("boardKeys");
  const tDays = useTranslations("days");
  const [said, setSaid] = useState("");
  const [help, setHelp] = useState(false);
  /** What is in hand: the lesson, and the square it would go down on. Read in an event, so a ref. */
  const held = useRef<{ id: string; at: Marker } | null>(null);
  /** The latest of everything an event reads, so that the listeners below are put up once. */
  const live = useRef({ props, t, tDays });
  useEffect(() => {
    live.current = { props, t, tDays };
  });

  // A lesson in hand that is no longer in the week (somebody removed it, a read brought another week) is let go quietly.
  const heldId = held.current?.id;
  useEffect(() => {
    if (heldId && !props.lessons.some((lesson) => lesson.id === heldId)) {
      held.current = null;
      props.ghost.set(null);
      props.setPicked(null);
    }
  });

  useEffect(() => {
    const body = props.bodyRef.current;
    if (!body) return undefined;

    const cardOf = (event: Event): { id: string; lesson: BoardLesson } | null => {
      const id = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-lesson-id]")?.dataset.lessonId;
      const lesson = id ? live.current.props.lessons.find((candidate) => candidate.id === id) : undefined;
      return id && lesson && !lesson.duty ? { id, lesson } : null;
    };

    const say = (key: string, values: Record<string, string | number> = {}) => {
      const { t: translate } = live.current;
      setSaid(translate(key, values));
    };
    // "Matematik 7A": the subject and the class, which is what a person calls a lesson. The card's own text goes on to the teacher and
    // "Förlagd" ("7A · B. Ek · Förlagd"), and a line that is read aloud after every key does not need them.
    const nameOf = (lesson: BoardLesson) => [lesson.title, lesson.subtitle?.split(" · ")[0]].filter(Boolean).join(" ");
    const squareOf = (square: Marker) => ({
      day: live.current.tDays(String(square.dayOfWeek)),
      from: clock(square.startMinutes),
      to: clock(square.endMinutes),
    });

    const letGo = (quietly = false) => {
      const { props: p } = live.current;
      const lesson = held.current && p.lessons.find((candidate) => candidate.id === held.current!.id);
      held.current = null;
      p.ghost.set(null);
      p.setPicked(null);
      if (!quietly && lesson) say("letGo", { lesson: nameOf(lesson) });
    };

    /** Asks the page whether the lesson may stand on the square, and draws the marker green or red. */
    const verdict = (id: string, square: Marker): boolean => {
      const ok = live.current.props.validateChange ? live.current.props.validateChange(id, square) : true;
      live.current.props.ghost.set({ ...square, valid: ok });
      return ok;
    };

    const put = (lesson: BoardLesson, square: Marker) => {
      const { props: p } = live.current;
      const ok = p.validateChange ? p.validateChange(lesson.id, square) : true;
      letGo(true);
      if (!ok) {
        say("refused", { lesson: nameOf(lesson), ...squareOf(square) });
        p.onInvalidDrop?.(lesson.id, square);
        return;
      }
      p.followFocus(lesson.id);
      say("placed", { lesson: nameOf(lesson), ...squareOf(square) });
      p.onLessonChange?.(lesson.id, square);
    };

    /**
     * A lesson that is parked or removed leaves the week, and the focus it has leaves the page with it (to <body>, where the next
     * key goes to nothing and Tab starts from the top of the page). So the focus is handed on first: to the next lesson of its day,
     * else the one before, else the nearest of another day. Where the write is refused the lesson stays and keeps its focus.
     */
    const focusPassesOn = (id: string) => {
      const { props: p } = live.current;
      const others = p.lessons.filter((candidate) => !candidate.duty);
      const heir =
        focusAfter(others, id, "ArrowDown") ?? focusAfter(others, id, "ArrowUp") ?? focusAfter(others, id, "ArrowRight") ?? focusAfter(others, id, "ArrowLeft");
      if (!heir) return;
      const target = others.find((candidate) => candidate.id === heir);
      if (p.shownDay !== null && target && target.dayOfWeek !== p.shownDay) p.showDay(target.dayOfWeek);
      p.setRoving(heir);
      p.followFocus(heir);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey) return;
      const card = cardOf(event);
      if (!card) return;
      const { props: p } = live.current;
      const { lesson, id } = card;
      const key = event.key;
      const bounds: Bounds = { dayCount: p.dayCount, dayStartMinutes: p.dayStartMinutes, dayEndMinutes: p.dayEndMinutes };
      const taken = held.current?.id === id ? held.current : null;
      const consume = () => {
        event.preventDefault();
        event.stopPropagation();
      };

      // A key held down repeats, and only an arrow (or Home and End) is meant to: a held Space would put down what it took up
      // and take it up again, a held L would lock and unlock, and Alt+Down would write a length thirty times a second.
      if (event.repeat && (event.altKey || !(ARROWS.has(key) || key === "Home" || key === "End"))) {
        if (OWNED_BY_THE_BOARD.has(key.toLowerCase()) || (event.altKey && ARROWS.has(key))) consume();
        return;
      }

      if (key === "?") {
        consume();
        setHelp((open) => !open);
        return;
      }

      // Something in hand: the arrows move its marker, and Enter, Space and Esc end it.
      if (taken) {
        if (ARROWS.has(key) && !event.altKey) {
          consume();
          const next = markerAfter(taken.at, key as Arrow, bounds, event.shiftKey);
          if (sameSquare(next, taken.at)) return;
          // On a phone only the day the lesson is in is drawn, and the card that has focus is in it: another day would take the
          // card, and focus with it, out of the page. The marker stays in the day; the lesson's dialog changes the day.
          if (p.shownDay !== null && next.dayOfWeek !== taken.at.dayOfWeek) return;
          taken.at = next;
          const ok = verdict(id, next);
          say(ok ? "markerFree" : "markerTaken", squareOf(next));
          return;
        }
        if (key === "Enter" || (key === " " && !event.shiftKey)) {
          consume();
          if (sameSquare(taken.at, lesson)) letGo();
          else put(lesson, taken.at);
          return;
        }
        if (key === "Escape") {
          consume();
          letGo();
          return;
        }
        // Anything else waits for the lesson to be put down or let go: a lock or a removal of a lesson in hand would be a
        // surprise, and Tab is the browser's.
        return;
      }

      // Nothing in hand: the arrows move focus.
      if ((ARROWS.has(key) || key === "Home" || key === "End") && !event.altKey && !event.shiftKey) {
        consume();
        const to = focusAfter(p.lessons.filter((candidate) => !candidate.duty), id, key as Arrow | "Home" | "End");
        if (to) {
          const target = p.lessons.find((candidate) => candidate.id === to);
          if (p.shownDay !== null && target && target.dayOfWeek !== p.shownDay) {
            // On a phone the day it is in is not drawn: draw it, and focus follows once the card is there.
            p.showDay(target.dayOfWeek);
            p.followFocus(to);
          } else {
            body.querySelector<HTMLElement>(`[data-lesson-id="${CSS.escape(to)}"]`)?.focus();
          }
          p.setRoving(to);
        }
        return;
      }

      if ((key === " " && !event.shiftKey) || (key === "m" || key === "M")) {
        consume();
        held.current = { id, at: { dayOfWeek: lesson.dayOfWeek, startMinutes: lesson.startMinutes, endMinutes: lesson.endMinutes } };
        p.ghost.set({ ...held.current.at, valid: true });
        p.setPicked(id);
        say("pickedUp", { lesson: nameOf(lesson), ...squareOf(held.current.at) });
        return;
      }

      if (event.altKey && (key === "ArrowUp" || key === "ArrowDown")) {
        consume();
        const next = lengthened(lesson, key === "ArrowUp" ? -LENGTH_STEP_MINUTES : LENGTH_STEP_MINUTES, bounds);
        if (!next) {
          say("lengthLimit", { lesson: nameOf(lesson) });
          return;
        }
        const minutes = next.endMinutes - next.startMinutes;
        if (p.validateChange && !p.validateChange(id, next)) {
          say("lengthRefused", { lesson: nameOf(lesson), minutes });
          p.onInvalidDrop?.(id, next);
          return;
        }
        p.followFocus(id);
        say("length", { lesson: nameOf(lesson), minutes, to: clock(next.endMinutes) });
        p.onLessonChange?.(id, next);
        return;
      }

      if (!event.altKey && !event.shiftKey && p.onLessonCommand) {
        if (key === "l" || key === "L") {
          consume();
          say(lesson.locked ? "unlocked" : "locked", { lesson: nameOf(lesson) });
          p.onLessonCommand(id, "lock");
        } else if (key === "p" || key === "P") {
          consume();
          say("parked", { lesson: nameOf(lesson) });
          focusPassesOn(id);
          p.onLessonCommand(id, "park");
        } else if (key === "Delete" || key === "Backspace") {
          consume();
          say("removed", { lesson: nameOf(lesson) });
          focusPassesOn(id);
          p.onLessonCommand(id, "remove");
        }
      }
    };

    // Focus, however it got there (a key, a click, Tab), is where the arrows start from.
    const onFocusIn = (event: FocusEvent) => {
      const card = cardOf(event);
      if (card) live.current.props.setRoving(card.id);
    };
    // A pointer that takes hold of anything ends what the keyboard had in hand: both would draw the same ghost.
    const onPointerDown = () => {
      if (held.current) letGo(true);
    };

    body.addEventListener("keydown", onKeyDown);
    body.addEventListener("focusin", onFocusIn);
    body.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      body.removeEventListener("keydown", onKeyDown);
      body.removeEventListener("focusin", onFocusIn);
      body.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [props.bodyRef]);

  return (
    <div className="mt-2 space-y-2 text-sm">
      {/*
        Present before it says anything, which is what makes a screen reader read what is put in it. A live region and not
        role="status": a page has the one of its own notices (the lunch notice is a status, and a test and a reader both look for
        it), and a board says its keys in a line for each grid it draws.
      */}
      <p data-board-status aria-live="polite" aria-atomic="true" className="min-h-5 text-foreground">
        {said}
      </p>
      {help ? (
        <dl aria-label={t("keysTitle")} className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border bg-card p-3 text-xs">
          {(["arrows", "take", "marker", "put", "letGoKey", "length", "lock", "park", "remove", "open", "select", "undo"] as const).map((row) => (
            <div key={row} className="contents">
              <dt className="font-mono font-semibold">{t(`keys.${row}.keys`)}</dt>
              <dd className="text-muted-foreground">{t(`keys.${row}.does`)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}
