import type { LessonChange, TimetableLesson } from "@/components/schedule/timetable-grid";
import type { Placement, PupilBufferMap } from "@/lib/conflicts";
import { guardLeaving } from "@/lib/leave-guard";
import type { BoardPost, CardNames } from "@/lib/placement-board";
import { dropOf, type Drop, type Mover, type OtherNames } from "@/lib/placement-drop";
import type { MirrorContext } from "@/lib/placement-mirror";
import { heldHalfCard, heldHalfPlacement, pairInputs, type HeldHalf } from "@/lib/placement-pair";
import { heldHalfCardId, otherHalf, partKeyOfBrick, type Half, type WeeksChoice } from "@/lib/placement-pair-key";
import { placementKeyOf, type Brick, type RowEdit, type Spot } from "@/lib/placement-rows";
import type { YearWeek } from "@/lib/placement-weeks";
import { clockOfMinutes, minutesOfClock } from "@/lib/requirement-placement-text";

/*
 * Förlägg i veckan, what the page DOES with a pair (D2): the first half held, the second laid, a half moved, let go, and the week that
 * follows it. Everything in lib/placement-pair.ts is arithmetic; this is the behaviour, and it is a module of its own because the route has no
 * bytes for it in its first load: the page fetches it when it is up (lib/use-lazy-module.ts), holds the one piece of state (`held`)
 * itself, and hands this the rest it needs each time it draws. What becomes of a half is written in lib/placement-pair.ts and held by
 * the page tests (app/[locale]/(app)/admin/placements/page.pair.test.tsx).
 *
 * No React here: the page's own setters and its write (`change`, which the history and the week's key hang on) come in, and functions go out.
 */

type Say = (message: { tone: "ok" | "problem"; text: string }) => void;
type Translate = (key: string, values?: Record<string, string | number>) => string;

/** What the page hands over each time it draws. */
export interface PairContext {
  held: HeldHalf | null;
  setHeld: (held: HeldHalf | null) => void;
  setBrickKey: (key: string | null) => void;
  setWeeksChoice: (choice: WeeksChoice) => void;
  /** The weeks a brick is laid for when it is half of a pair (the page's: it asks before this module is here); null: its post's own. */
  weeksOf: (brick: Brick) => Half | null;
  postById: ReadonlyMap<string, BoardPost>;
  /** The mirror WITH the held half in it. */
  mirror: MirrorContext | null;
  moverOfBrick: (brick: Brick, roomId: string | null) => Mover | null;
  otherNames: OtherNames;
  say: Say;
  setRefusal: (text: string | null) => void;
  sentenceOf: (drop: Drop) => string;
  meetsRed: (params: Record<string, string | number> | undefined) => string;
  /** The page's own write of a post's list (the history, the key chain, the message after it): true when it was written. */
  change: (postId: string, edit: RowEdit, label: string, said: string, focusOn: (keys: string[]) => string | null) => Promise<boolean>;
  cardOfKey: (base: string) => (rowKeys: string[]) => string | null;
  /** `placementWeek`, `placementWeek.pair`, `placementWeek.weeks` and `days`. */
  t: Translate;
  tPair: Translate;
  tWeeks: Translate;
  tDays: Translate;
  postName: (post: BoardPost | undefined) => string;
  /** The week shown (a Monday, or null for every week) and what moves it. */
  week: string | null;
  yearWeeks: readonly YearWeek[];
  nearestWeekOf: ((weeks: readonly YearWeek[], monday: string, parity: Half) => YearWeek | null) | undefined;
  setWeek: (monday: string | null) => void;
  /** The write of a pair is on its way: the part's count moves with it and must not read as "nothing left to lay". */
  writing: { current: boolean };
}

export function pairControl(c: PairContext) {
  const { held, weeksOf } = c;
  const heldPost = held ? c.postById.get(held.postId) : undefined;
  const weeksText = (half: string): string => c.tPair(half === "ODD_WEEKS" ? "weeksOdd" : "weeksEven");
  const whenText = (day: number, start: number, minutes: number): string => `${c.tDays(String(day))} ${clockOfMinutes(start)}–${clockOfMinutes(start + minutes)}`;

  /** The picker follows the half being laid: a half of odd weeks is laid looking at an odd week, so that what is shown is what the half can meet. */
  function follow(parity: Half): string {
    const current = c.week === null ? undefined : c.yearWeeks.find((entry) => entry.monday === c.week);
    const next = current && c.nearestWeekOf && current.parity !== parity ? c.nearestWeekOf(c.yearWeeks, current.monday, parity) : null;
    if (!next) return "";
    c.setWeek(next.monday);
    return ` ${c.tWeeks("followed", { week: next.week, parity: c.tWeeks(next.parity === "ODD_WEEKS" ? "odd" : "even") })}`;
  }

  function release(text: string): void {
    c.setHeld(null);
    c.setBrickKey(null);
    c.say({ tone: "ok", text });
  }

  /** The first half of a pair: held in the page and written nowhere (it would be refused as a lone half), asked of the mirror first. */
  function hold(brick: Brick, spot: Spot, roomId: string | null, recurrence: Half): boolean {
    const post = c.postById.get(brick.postId);
    if (!post) return false;
    if (roomId === null) {
      c.say({ tone: "problem", text: c.tPair("needsRoom") });
      return false;
    }
    const mover = c.moverOfBrick(brick, roomId);
    const drop: Drop = c.mirror && mover ? dropOf(c.mirror, mover, { dayOfWeek: spot.dayOfWeek, startMinutes: spot.startMinutes, endMinutes: spot.startMinutes + brick.minutes }, c.otherNames) : { kind: "OK" };
    if (drop.kind !== "OK") {
      c.say({ tone: "problem", text: `${c.t("cannotStandThere", { reason: c.sentenceOf(drop) })}${drop.kind === "CLASH" ? c.meetsRed(drop.params) : ""}` });
      return false;
    }
    c.setHeld({
      partKey: partKeyOfBrick(brick),
      postId: post.id,
      teacherId: post.parts.some((part) => part.teacherId !== post.teacherId) ? brick.teacherId : null,
      minutes: brick.minutes,
      recurrence,
      dayOfWeek: spot.dayOfWeek,
      startMinutes: spot.startMinutes,
      roomId,
    });
    c.setBrickKey(brick.key);
    c.setRefusal(null);
    const otherWeeks = otherHalf(recurrence);
    const followed = follow(otherWeeks);
    c.say({ tone: "ok", text: `${c.tPair("firstHeld", { weeks: weeksText(recurrence), otherWeeks: weeksText(otherWeeks), when: whenText(spot.dayOfWeek, spot.startMinutes, brick.minutes) })}${followed}` });
    return true;
  }

  /** The second half: both go in ONE write, the post's whole list with two rows added. */
  async function layPair(brick: Brick, spot: Spot, roomId: string | null): Promise<boolean> {
    const post = c.postById.get(brick.postId);
    if (!post || !held) return false;
    if (roomId === null) {
      c.say({ tone: "problem", text: c.tPair("needsRoom") });
      return false;
    }
    const inputs = pairInputs(brick, post, held, { spot, roomId });
    const line = (input: (typeof inputs)[number]) => c.tPair("pairLine", { weeks: weeksText(input.recurrence), when: whenText(input.dayOfWeek, minutesOfClock(input.startTime), input.minutes) });
    const last = inputs[1];
    const base = placementKeyOf({ requirementId: post.id, teacherId: last.teacherId ?? null, minutes: brick.minutes, dayOfWeek: last.dayOfWeek, startTime: last.startTime, recurrence: last.recurrence });
    c.writing.current = true;
    let done = false;
    try {
      done = await c.change(post.id, { kind: "addPair", inputs }, "place", c.tPair("placedPair", { lesson: c.postName(post), first: line(inputs[0]), second: line(last) }), c.cardOfKey(base));
    } finally {
      c.writing.current = false;
    }
    if (done) {
      c.setHeld(null);
      c.setBrickKey(null);
      c.setWeeksChoice("ALL_WEEKS");
    }
    return done;
  }

  return {
    release,
    moverOfHeld: (): Mover | null =>
      held && heldPost ? { id: heldHalfCardId(held.partKey), post: heldPost, teacherId: held.teacherId ?? heldPost.teacherId, roomId: held.roomId, recurrence: held.recurrence } : null,
    /** A brick laid, pulled or pointed to as half of a pair: the first is held, the second writes both. */
    lay: (brick: Brick, spot: Spot, roomId: string | null): Promise<boolean> => {
      const weeks = weeksOf(brick);
      if (weeks === null) return Promise.resolve(false);
      return held ? layPair(brick, spot, roomId) : Promise.resolve(hold(brick, spot, roomId, weeks));
    },
    /** The held half is a card the reader may move (its length is the lesson's: the grid's validateChange refuses another): it is still only in the page. */
    moveHeld(to: LessonChange): void {
      if (!held) return;
      c.setHeld({ ...held, dayOfWeek: to.dayOfWeek, startMinutes: to.startMinutes });
      c.say({ tone: "ok", text: c.tPair("movedHalf", { when: whenText(to.dayOfWeek, to.startMinutes, held.minutes) }) });
    },
    /** The weeks choice changed: the week shown follows to a week of the weeks the half runs. */
    choose(choice: WeeksChoice): void {
      c.setWeeksChoice(choice);
      const followed = choice === "ALL_WEEKS" ? "" : follow(choice);
      if (followed) c.say({ tone: "ok", text: followed.trim() });
    },
    /** What the row's block about the held half says (the words are the fields' own). */
    heldText: held ? { lesson: c.postName(heldPost), weeks: weeksText(held.recurrence), otherWeeks: weeksText(otherHalf(held.recurrence)), when: whenText(held.dayOfWeek, held.startMinutes, held.minutes) } : null,
  };
}

/** The held half as a card and as a lesson of the week, for the page's early memos (the mirror, the cards). */
export function heldViewOf(held: HeldHalf, post: BoardPost, names: CardNames, tPair: Translate, buffers: PupilBufferMap | undefined): { card: TimetableLesson; placement: Placement } {
  return {
    card: heldHalfCard(held, {
      subject: names.subject(post.subjectId)?.name ?? "",
      subtitle: [names.group(post.studentGroupId), names.teacher(held.teacherId ?? post.teacherId)].filter(Boolean).join(" · "),
      room: names.room(held.roomId),
      color: names.color(post.subjectId, names.subject(post.subjectId)?.color),
      note: tPair("heldNote", { weeks: tPair(held.recurrence === "ODD_WEEKS" ? "weeksOdd" : "weeksEven") }),
    }),
    placement: heldHalfPlacement(held, post, buffers),
  };
}

/** Asks before the reader leaves while a half is held; returns what stops the asking. */
export { guardLeaving };
