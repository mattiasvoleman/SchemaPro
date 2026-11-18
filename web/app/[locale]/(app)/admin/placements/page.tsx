"use client";

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Redo2, Undo2 } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { useProfile, useReadOnly } from "@/components/profile-context";
import { BrickList, type BrickGroup } from "@/components/placements/brick-list";
import { LatestSwitch } from "@/components/placements/latest-switch";
import { SinceRunNote } from "@/components/placements/since-run-note";
import { WarningLines } from "@/components/placements/warning-lines";
import { FilterPicker } from "@/components/schedule/filter-picker";
import { PlanningYearPicker, ProjectedRostersBanner } from "@/components/schedule/planning-year";
import {
  TimetableGrid,
  type LessonChange,
  type TimetableGridHandle,
  type TimetableLesson,
} from "@/components/schedule/timetable-grid";
import { Button } from "@/components/ui/button";
import { LoadError } from "@/components/ui/load-error";
import { Notice } from "@/components/ui/notice";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { teachesLike } from "@/lib/teaching-staff";
import { profileWrites } from "@/lib/admin-areas";
import { ApiError } from "@/lib/api";
import { blockFitSentence, blockPlacementsRefusal } from "@/lib/block-placements";
import { usePlanningYear } from "@/lib/planning-year";
import { blockLinkFromAddress, lessonOfBlockLink } from "@/lib/placement-block-link";
import {
  blockBricksOf,
  blockCardId,
  blockCards,
  blockKeyByRowId,
  blockKeyOf,
  blockLessonsLeft,
  keysOfBlockRows,
  redLessonNamed,
  summaryWithBlocks,
  verdictLines,
  verdictsOfAnswerRow,
  visibleBlocks,
  weeksOfBlock,
  blockBrickKey,
  blockInputOfBrick,
  type BlockBrick,
  type BlockEdit,
  type BlockRoomChoice,
} from "@/lib/placement-block-rows";
import {
  DAY_END_MINUTES,
  NO_FILTERS,
  isFiltered,
  keptCardId,
  keptCards,
  mealBands,
  placementCardId,
  placementCards,
  savedAt,
  teacherOfPlacement,
  totalsOf,
  visibleBoard,
  weekDay,
  type BoardBlock,
  type BoardBlockRow,
  type BoardFilters,
  type BoardPlacement,
  type BoardPost,
  type CardNames,
} from "@/lib/placement-board";
import { useLatestSchedule, usePlacementBoard } from "@/lib/placement-board-queries";
import { canBePair, heldHalfCardId, otherHalf, partKeyOfBrick, type Half, type WeeksChoice } from "@/lib/placement-pair-key";
import { usePlacementLinkTarget } from "@/lib/use-placement-link-target";
import { usePlacementWarnings } from "@/lib/use-placement-warnings";
// The mirror of the clash rule and what asks it come with the drag tools, a moment after the page is up (lib/placement-drag-tools.ts).
import type { Drop, Mover, OtherNames } from "@/lib/placement-drop";
import {
  bricksOf,
  inputOfBrick,
  keyByRowId,
  keysOfRows,
  placementKeyOf,
  removalOf,
  rowsOfPost,
  type Brick,
  type RowEdit,
  type Spot,
} from "@/lib/placement-rows";
import { WriteFailure, usePlacementEditor, writeProblemOf } from "@/lib/placement-write";
import {
  useConstraints,
  useFrameTimes,
  useGroupMemberships,
  useGroups,
  useOptimizationHistory,
  usePeople,
  useRoomPreferences,
  useRooms,
  useSubjects,
} from "@/lib/queries";
import { placementsRefusal } from "@/lib/requirement-placements";
import { clockOfMinutes, fitSentence, minutesOfClock, verdictSentence } from "@/lib/requirement-placement-text";
import { compareSwedish } from "@/lib/sorting";
import { useLazyModule } from "@/lib/use-lazy-module";
import { useHistoryKeyboard } from "@/lib/use-schedule-history";
import { cn, subjectColor } from "@/lib/utils";
import type { PlaceValue } from "@/components/placements/place-fields";
import type { BlockPlaceValue } from "@/components/placements/block-place-fields";
import type { HeldHalf } from "@/lib/placement-pair";

// What a brick chosen, or a card opened, needs and nothing else does: fetched when the first is pressed, not with the page.
const PlaceFields = lazy(() => import("@/components/placements/place-fields").then((module) => ({ default: module.PlaceFields })));
const BlockPlaceFields = lazy(() => import("@/components/placements/block-place-fields").then((module) => ({ default: module.BlockPlaceFields })));
const WeekPicker = lazy(() => import("@/components/placements/week-picker").then((module) => ({ default: module.WeekPicker })));
const PairFields = lazy(() => import("@/components/placements/pair-fields").then((module) => ({ default: module.PairFields })));
const CardDialog = lazy(() => import("@/components/placements/card-dialog").then((module) => ({ default: module.CardDialog })));

/*
 * FÖRLÄGG I VECKAN — what the school has placed by hand, in a week, before and
 * after Generera, and where it is laid, moved and taken away.
 *
 * A lesson is laid by dragging its brick from Att lägga into the week, by
 * choosing the brick and pressing a time (a phone cannot drag), or from the
 * keyboard by choosing the brick and giving a day, a start and a room. All three
 * end in the same write: the post's whole list of förläggningar, made on top of
 * the rows this page read (`baseKey`), by the dialog's own PUT. A lesson placed
 * here is the same row the dialog on Timplansposter writes, and it counts from
 * the next Generera: nothing in the grundschema moves.
 *
 * The gateway counts and judges; this page draws and writes. The ghost under a
 * drag is the grundschema's mirror of the clash rule over the week's own facts
 * (lib/placement-mirror.ts) and is not the judge: the gateway answers at the
 * drop and its sentence is the one shown, with the brick left where it was.
 *
 * A LESSON IS NOT ITS ROW. Every save gives the rows new ids, so a card, a
 * selection, a focus and an undo step are named by the post, the teacher, the
 * length and the place (lib/placement-rows.ts), never by an id.
 *
 * The lessons Generera keeps (hand-made and locked, with a padlock) are changed
 * in the grundschema and are not moved here.
 *
 * A PARALLEL BLOCK's lesson is laid, moved and taken away the same three ways, for every post of the block at once, with a room for
 * each post or "Motorn väljer sal" (placement-block-rows.ts, block-place-fields.tsx). Its brick is `block:<id>|<minutes>#n` and its
 * card `blockplacement:<key>`; one write is a PUT of the block's whole list on the block's own key (usePlacementEditor.changeBlock),
 * and the history is the same one stack. A post of a block has no brick of its own: the block's is the one to lay.
 */

/** "A. Ek". */
const shortName = (person: { firstName: string; lastName: string }): string => `${person.firstName[0] ?? ""}. ${person.lastName}`;

/** What the address may name: ?post=, the post to open on (the link in the Förlägg dialog). */
function postFromAddress(): string | null {
  return new URLSearchParams(window.location.search).get("post");
}

/** What the address may name of a lesson of a block: &block=…&day=…&start=…, the lesson whose card is marked (placement-block-link.ts). */
const blockLinkFromWindow = () => blockLinkFromAddress(window.location.search);

/** How long the gateway counts a PENDING or RUNNING run as running (the Generera page's own figure). */
const RUNNING_MS = 15 * 60 * 1000;

/** What a keyboard shortcut on a page that writes nothing does: nothing. */
const NO_HISTORY = { undo: async () => null, redo: async () => null };

export default function PlacementsPage() {
  const t = useTranslations("placementWeek");
  const tTimetable = useTranslations("timetable");
  const tPlacements = useTranslations("requirements.placements");
  const tBlock = useTranslations("placementWeek.block");
  // The sentences of the dialog on Timplansposter that a block says the same way: why a block's lessons do not fit it.
  const tBlockFit = useTranslations("requirements.blockPlacements");
  const tDays = useTranslations("days");
  const tPair = useTranslations("placementWeek.pair");
  const tNote = useTranslations("placementWeek.note");
  const tWeeks = useTranslations("placementWeek.weeks");
  const tLatest = useTranslations("placementWeek.latest");
  const locale = useLocale();
  const { profile } = useProfile();
  const readOnly = useReadOnly();
  // Planering's: the profiles that write a förläggning. What the others see is the week, read.
  // A profile built without one is the full administrator's, as the layout reads it (app/[locale]/(app)/layout.tsx).
  const mayWrite = !readOnly && profileWrites(profile.adminProfile === undefined ? "FULL" : profile.adminProfile, "PLANERING");

  const { year, active, successor, choose, rosters, rostersFailed } = usePlanningYear();
  const board = usePlacementBoard(year?.id ?? null);
  const groupsQuery = useGroups();
  const subjectsQuery = useSubjects();
  const roomsQuery = useRooms();
  const peopleQuery = usePeople();
  const constraintsQuery = useConstraints();
  const framesQuery = useFrameTimes();
  const membershipsQuery = useGroupMemberships();
  const roomRulesQuery = useRoomPreferences();
  const jobsQuery = useOptimizationHistory(year?.id ?? null);
  const editor = usePlacementEditor(year?.id ?? null);
  const { history, reconcile, saving } = editor;

  const [filters, setFilters] = useState<BoardFilters>(NO_FILTERS);
  const [brickKey, setBrickKey] = useState<string | null>(null);
  const [openCard, setOpenCard] = useState<string | null>(null);
  const [draft, setDraft] = useState<PlaceValue | null>(null);
  /** What the fields of a chosen block brick hold: where, and a room for each post. */
  const [blockDraft, setBlockDraft] = useState<BlockPlaceValue | null>(null);
  /** The card a link marks (its lesson's card id), and whether the lesson it names is no longer there. */
  const [markedBlockCard, setMarkedBlockCard] = useState<string | null>(null);
  const [linkGone, setLinkGone] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "problem"; text: string } | null>(null);
  /** The gateway's sentence for the last row it refused, shown in the fields until they change. */
  const [refusal, setRefusal] = useState<string | null>(null);
  /** An element to move focus to once the week has been drawn with the change: a selector. */
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const [focusPost, setFocusPost] = useState<string | null>(null);
  useEffect(() => setFocusPost(postFromAddress()), []);
  const [blockLink, setBlockLink] = useState<ReturnType<typeof blockLinkFromWindow>>(null);
  useEffect(() => setBlockLink(blockLinkFromWindow()), []);
  const gridRef = useRef<TimetableGridHandle>(null);
  /** The first half of a pair, laid and not yet written: the one state of this page that exists nowhere else (lib/placement-pair.ts). */
  const [held, setHeld] = useState<HeldHalf | null>(null);
  /** What the chosen brick is laid as: every week, or the first half of a pair that starts with the odd weeks or with the even ones. */
  const [weeksChoice, setWeeksChoice] = useState<WeeksChoice>("ALL_WEEKS");
  /** The week shown: the Monday of one week of the läsår, or null for all of them (D2). Only the cards are narrowed by it. */
  const [week, setWeek] = useState<string | null>(null);
  /** "Visa senaste schemat": the lessons the last Generera laid, drawn pale behind the week; read only while it is on. */
  const [showLatest, setShowLatest] = useState(false);
  // What a week picked and a pair need is fetched when the page is up, not with it (lib/use-lazy-module.ts): the route has no bytes for it.
  // A chunk that does not come is said once, as the drag tools' is: without it the picker, the cards' week marks and the latest schedule never arrive, and the
  // switch's row would read "Läser det senaste schemat …" for ever (review of #347, LÅG-5).
  const weekTools = useLazyModule(
    () => import("@/lib/placement-week-tools"),
    () => setMessage({ tone: "problem", text: t("toolsFailed") }),
  );
  // The mirror of the clash rule and the pair that asks it are one module and one request (lib/placement-drag-tools.ts).
  // A chunk that does not come (a dropped connection, a proxy) is said once, in words: the controls below stay off, and the reader reloads.
  const dragTools = useLazyModule(
    () => import("@/lib/placement-drag-tools"),
    () => setMessage({ tone: "problem", text: t("toolsFailed") }),
  );
  const pairTools = dragTools;
  // A writer's controls wait for the tools (review of #341, MEDEL-1). Without them the page has no mirror, and a field would say "Ledigt."
  // for a time the teacher already holds, offer no room and no first free time, and lay the lesson as a pin; a press, a drop or an arrow key
  // would send it. A reader has no controls and needs none.
  const toolsHere = !mayWrite || dragTools !== null;

  const groups = useMemo(
    () => (groupsQuery.data ?? []).filter((group) => !year || group.academicYearId === year.id),
    [groupsQuery.data, year],
  );
  const groupById = useMemo(() => new Map((groupsQuery.data ?? []).map((group) => [group.id, group])), [groupsQuery.data]);
  const subjectById = useMemo(() => new Map((subjectsQuery.data ?? []).map((subject) => [subject.id, subject])), [subjectsQuery.data]);
  const roomById = useMemo(() => new Map((roomsQuery.data ?? []).map((room) => [room.id, room])), [roomsQuery.data]);
  // The filter's teachers: those who teach (a teacher, or an administrator with Users.teaches). The name on a
  // card is looked up in everybody, so a lesson never loses the name of the person it carries.
  const teachers = useMemo(() => (peopleQuery.data ?? []).filter(teachesLike), [peopleQuery.data]);
  const teacherById = useMemo(() => new Map((peopleQuery.data ?? []).map((person) => [person.id, person])), [peopleQuery.data]);

  const names: CardNames = useMemo(
    () => ({
      subject: (id) => {
        const subject = subjectById.get(id);
        return subject ? { name: subject.name, color: subject.color } : undefined;
      },
      group: (id) => groupById.get(id)?.name,
      teacher: (id) => {
        const teacher = id ? teacherById.get(id) : undefined;
        return teacher ? shortName(teacher) : undefined;
      },
      room: (id) => (id ? roomById.get(id)?.name : undefined),
      noRoom: tPlacements("roomAny"),
      // The marks come with the week tools, a moment after the page is up (the route has no bytes for them in its first load).
      weeks: (lesson) => weekTools?.weekNote(lesson, year ?? null, locale, tNote) ?? null,
      color: (subjectId, color) => subjectColor(subjectId, color),
      keptNote: t("keptNote"),
    }),
    [subjectById, groupById, teacherById, roomById, year, locale, tNote, weekTools, tPlacements, t],
  );
  const otherNames: OtherNames = useMemo(
    () => ({ group: (id) => groupById.get(id)?.name, subject: (id) => subjectById.get(id)?.name }),
    [groupById, subjectById],
  );

  const everything = board.data;
  const shown = useMemo(() => (everything ? visibleBoard(everything, filters) : null), [everything, filters]);
  const postById = useMemo(() => new Map((everything?.posts ?? []).map((post) => [post.id, post])), [everything]);
  const summary = useMemo(() => (everything ? summaryWithBlocks(everything) : null), [everything]);
  // Every row of the year by key: a card is named by the lesson, and the keys are made over all of the rows so that a filter changes none.
  const keys = useMemo(() => keyByRowId(everything?.placements ?? []), [everything]);
  // The card an address from Generera or the grundschema names (?post=&day=&start=), marked and given the keyboard.
  const { markedCard, missing } = usePlacementLinkTarget(everything?.placements, keys, openCard);
  const rowByCard = useMemo(
    () => new Map((everything?.placements ?? []).map((row) => [placementCardId(keys.get(row.id) ?? row.id), row])),
    [everything, keys],
  );
  const keptById = useMemo(() => new Map((everything?.kept ?? []).map((lesson) => [keptCardId(lesson.id), lesson])), [everything]);
  // The blocks' lessons are named by the lesson too (placement-block-rows.ts), over every lesson of every block so that a filter changes no name.
  const blockKeys = useMemo(() => blockKeyByRowId(everything?.blocks ?? []), [everything]);
  const blockById = useMemo(() => new Map((everything?.blocks ?? []).map((block) => [block.id, block])), [everything]);
  const blockOfPost = useMemo(() => new Map((everything?.blocks ?? []).flatMap((block) => block.memberIds.map((id) => [id, block] as const))), [everything]);
  const lessonByCard = useMemo(
    () =>
      new Map(
        (everything?.blocks ?? []).flatMap((block) =>
          block.rows.map((row) => [blockCardId(blockKeys.get(row.id) ?? row.id), { block, row, key: blockKeys.get(row.id) ?? row.id }] as const),
        ),
      ),
    [everything, blockKeys],
  );
  const shownBlocks = useMemo(() => (everything ? visibleBlocks(everything, filters) : []), [everything, filters]);
  // What the fixed week says of a row without refusing it, and the other schools' hold on a picked teacher or room (D1).
  const warned = usePlacementWarnings({ board: everything, filters, keys, blockKeys, saving });
  const yearWeeks = useMemo(() => (year && weekTools ? weekTools.weeksOfYear(year.startDate, year.endDate) : []), [year, weekTools]);
  // One week picked: the cards that run that week. The lists, the bricks, the figures and the mirror stay the year's (lib/placement-week-view.ts).
  const viewed = useMemo(
    () => (shown ? (week && weekTools ? weekTools.narrowToWeek({ ...shown, blocks: shownBlocks }, postById, week) : { ...shown, blocks: shownBlocks }) : null),
    [shown, shownBlocks, week, postById, weekTools],
  );

  // What the ghost and the arrow keys are held against; built when the week or a list changes, not at every pixel of a drag.
  const students = useMemo(
    () => new Map((peopleQuery.data ?? []).filter((person) => person.role === "STUDENT" && person.isActive).map((person) => [person.id, person.studentGroupId] as const)),
    [peopleQuery.data],
  );
  const baseMirror = useMemo(
    () =>
      mayWrite && everything && dragTools
        ? dragTools.buildMirror({
            board: everything,
            keys,
            groups: groupsQuery.data ?? [],
            studentGroupOf: students,
            memberships: membershipsQuery.data ?? [],
            constraints: constraintsQuery.data,
            frames: framesQuery.data,
            numbering: year?.gradeNumbering,
            academicYearId: year?.id,
          })
        : null,
    [mayWrite, everything, dragTools, keys, groupsQuery.data, students, membershipsQuery.data, constraintsQuery.data, framesQuery.data, year?.gradeNumbering, year?.id],
  );
  const heldPost = held ? postById.get(held.postId) : undefined;
  // The first half of a pair, as a card (dashed, saying that it is not saved: drawn in whatever week is picked, it is in play and not in force) and as a lesson in
  // the week's way: what is laid beside it is held against it, or the pair would be refused for it at the end.
  const heldView = useMemo(
    () => (held && heldPost && pairTools ? pairTools.heldViewOf(held, heldPost, names, tPair, baseMirror?.buffers) : null),
    [held, heldPost, pairTools, names, tPair, baseMirror],
  );
  const mirror = useMemo(() => (baseMirror && heldView ? { ...baseMirror, others: [...baseMirror.others, heldView.placement] } : baseMirror), [baseMirror, heldView]);
  // The mirror's questions, which every press, drop and open card asks: null until the tools and a mirror are here, and every use of them is behind it.
  const drag = useMemo(() => (mirror && dragTools ? dragTools.dragOf(mirror, otherNames) : null), [mirror, dragTools, otherNames]);

  const keptFilterNeeded = !isFiltered(filters);
  // Read when it is on and something is picked: with nothing picked it draws nothing, and a school's whole machine-made schedule is not worth the read.
  const latest = useLatestSchedule(year?.id ?? null, showLatest && !keptFilterNeeded);
  // Drawn for what is picked and the week shown, as the lessons Generera keeps are; the tools come with the week's (lib/placement-week-tools.ts).
  const ghosts = useMemo(
    () =>
      showLatest && latest.data && weekTools
        ? weekTools.ghostLessonsOf({ lessons: latest.data.lessons, filters, week, names, said: (lesson) => tLatest("ghost", { lesson }) })
        : [],
    [showLatest, latest.data, weekTools, filters, week, names, tLatest],
  );
  const cards = useMemo(
    () =>
      viewed
        ? [
            ...placementCards(viewed.placements, postById, names, keys),
            ...blockCards(viewed.blocks, postById, names, { rooms: (chosen, total) => tBlock("cardRooms", { chosen, total }) }, blockKeys),
            // The lessons Generera keeps are the school's whole grundschema, on a school that built one by hand: drawn
            // for what is picked, not for everything (review of #315, LÅG-3).
            ...(keptFilterNeeded ? [] : keptCards(viewed.kept, names)),
            ...(heldView ? [heldView.card] : []),
          ]
        : [],
    [viewed, postById, names, keys, blockKeys, keptFilterNeeded, tBlock, heldView],
  );
  const bands = useMemo(
    () => (viewed ? mealBands(viewed.meals, (meal) => t("meal", { group: groupById.get(meal.studentGroupId)?.name ?? "" })) : []),
    [viewed, groupById, t],
  );
  const markedCards = useMemo(() => warned.mark(cards), [warned.mark, cards]);
  const allBands = useMemo(() => [...bands, ...warned.heldBands], [bands, warned.heldBands]);

  const postName = useCallback(
    (post: BoardPost | undefined): string =>
      post ? [subjectById.get(post.subjectId)?.name, groupById.get(post.studentGroupId)?.name].filter(Boolean).join(" ") : "",
    [subjectById, groupById],
  );
  const teacherText = useCallback(
    (id: string | null): string => {
      const teacher = id ? teacherById.get(id) : undefined;
      return teacher ? shortName(teacher) : t("noTeacher");
    },
    [teacherById, t],
  );
  const whenText = (day: number, start: number, minutes: number): string => `${tDays(String(day))} ${clockOfMinutes(start)}–${clockOfMinutes(start + minutes)}`;
  const rowLine = (row: BoardPlacement): string =>
    [
      `${tDays(String(row.dayOfWeek))} ${row.startTime}–${row.endTime}`,
      row.roomName ?? tPlacements("roomAny"),
      names.weeks({ recurrence: row.recurrence, startDate: postById.get(row.requirementId)?.startDate ?? null, endDate: postById.get(row.requirementId)?.endDate ?? null }),
    ]
      .filter(Boolean)
      .join(" · ");

  // ---------------------------------------------------------------- the blocks' words
  /** The block's posts as the fields ask for their rooms: "Tyska Ty7". */
  const membersOf = (block: BoardBlock) => block.memberIds.map((id) => ({ id, name: postById.has(id) ? postName(postById.get(id)) : tBlock("postGone") }));
  const listOf = (list: string[]) => new Intl.ListFormat(locale, { type: "conjunction" }).format(list);
  /** The sentences the judge says of a lesson of a block, the posts that fail for one sentence said together: "Tyska Ty7 och Franska Fr7: …". */
  const linesOf = (block: BoardBlock | undefined, verdicts: readonly BoardBlockRow["verdicts"][number][]): string[] =>
    verdictLines(verdicts, block?.memberIds ?? [], (verdict) => verdictSentence(tPlacements, verdict.reason, verdict.params)).map((line) =>
      tBlock("postSaid", { posts: listOf(line.requirementIds.map((id) => (postById.has(id) ? postName(postById.get(id)) : tBlock("postGone")))), sentence: line.text }),
    );
  /** "tisdag 10:00–11:00 · Sal på 2 av 3 poster · udda". */
  const blockRowLine = (block: BoardBlock, row: BoardBlockRow): string => {
    const first = postById.get(block.memberIds[0] ?? "");
    return [
      `${tDays(String(row.dayOfWeek))} ${row.startTime}–${row.endTime}`,
      tBlock("cardRooms", { chosen: row.rooms.length, total: block.memberIds.length }),
      names.weeks({ recurrence: row.recurrence, startDate: first?.startDate ?? null, endDate: first?.endDate ?? null }),
    ]
      .filter(Boolean)
      .join(" · ");
  };

  const orderedPosts = useMemo(() => {
    if (!shown) return [];
    const text = (post: BoardPost) => `${groupById.get(post.studentGroupId)?.name ?? ""} ${subjectById.get(post.subjectId)?.name ?? ""}`;
    return [...shown.posts].sort((a, b) => compareSwedish(text(a), text(b)));
  }, [shown, groupById, subjectById]);
  const rowsByPost = useMemo(() => {
    const byPost = new Map<string, BoardPlacement[]>();
    for (const row of shown?.placements ?? []) {
      const list = byPost.get(row.requirementId);
      if (list) list.push(row);
      else byPost.set(row.requirementId, [row]);
    }
    return byPost;
  }, [shown]);

  // Att lägga: a brick per lesson still to lay, grouped by post. The posts are those the class and teacher filters show, and
  // NOT narrowed by the room filter: that one keeps the posts that stand in the room, and a lesson is laid in a room it does
  // not stand in yet (the room picked is what the brick suggests).
  const bricks = useMemo(() => {
    if (!mayWrite || !everything) return [];
    const ofRoom = visibleBoard(everything, { ...filters, rooms: [] }).posts;
    return bricksOf([...ofRoom].sort((a, b) => compareSwedish(`${groupById.get(a.studentGroupId)?.name ?? ""} ${subjectById.get(a.subjectId)?.name ?? ""}`, `${groupById.get(b.studentGroupId)?.name ?? ""} ${subjectById.get(b.subjectId)?.name ?? ""}`)));
  }, [mayWrite, everything, filters, groupById, subjectById]);
  const brickGroups: BrickGroup[] = useMemo(() => {
    const groupsOf = new Map<string, BrickGroup>();
    for (const brick of bricks) {
      const post = postById.get(brick.postId);
      const entry = groupsOf.get(brick.postId) ?? {
        postId: brick.postId,
        title: postName(post),
        bricks: [],
      };
      entry.bricks.push({
        key: brick.key,
        text: t("brickText", { teacher: teacherText(brick.teacherId), minutes: brick.minutes }),
        color: names.color(post?.subjectId ?? "", names.subject(post?.subjectId ?? "")?.color),
      });
      groupsOf.set(brick.postId, entry);
    }
    return [...groupsOf.values()];
  }, [bricks, postById, postName, teacherText, names, t]);
  const brickByKey = useMemo(() => new Map(bricks.map((brick) => [brick.key, brick])), [bricks]);
  // The brick a held half is a half of is the chosen one whatever the filters show: a half is not lost to a filter, so it is looked up on the whole board.
  const wholeBricks = useMemo(() => (held && everything ? bricksOf(everything.posts) : []), [held, everything]);
  const heldBrick = held ? wholeBricks.find((brick) => partKeyOfBrick(brick) === held.partKey) : undefined;
  const selectedBrick = held ? heldBrick : brickKey ? brickByKey.get(brickKey) : undefined;
  /** The weeks a brick is laid for when it is half of a pair: the held half's other weeks, or the reader's choice for the chosen brick. Null: every week (the post's own). */
  const pairWeeksOf = (brick: Brick): Half | null => {
    const post = postById.get(brick.postId);
    if (!post || !canBePair(post)) return null;
    if (held) return partKeyOfBrick(brick) === held.partKey ? otherHalf(held.recurrence) : null;
    return brickKey === brick.key && weeksChoice !== "ALL_WEEKS" ? weeksChoice : null;
  };

  // The blocks' bricks: one per lesson a block has left, after the posts'. Narrowed by class and teacher, not by room, as the posts' are.
  const blockBricks = useMemo(() => {
    if (!mayWrite || !everything) return [];
    return blockBricksOf(visibleBlocks(everything, { ...filters, rooms: [] }));
  }, [mayWrite, everything, filters]);
  const blockBrickByKey = useMemo(() => new Map(blockBricks.map((brick) => [brick.key, brick])), [blockBricks]);
  const selectedBlockBrick = brickKey ? blockBrickByKey.get(brickKey) : undefined;
  const blockBrickGroups: BrickGroup[] = useMemo(() => {
    const groupsOf = new Map<string, BrickGroup>();
    for (const brick of blockBricks) {
      const block = blockById.get(brick.blockId);
      if (!block) continue;
      const entry = groupsOf.get(block.id) ?? { postId: block.id, title: block.name, block: true, bricks: [] };
      entry.bricks.push({ key: brick.key, text: tBlock("brickText", { minutes: brick.minutes, count: block.memberIds.length }), color: names.color(block.id, null) });
      groupsOf.set(block.id, entry);
    }
    return [...groupsOf.values()];
  }, [blockBricks, blockById, names, tBlock]);
  /** The room each post of a block is offered for a lesson: the room its own lessons stand in, else its subject's rule, else none. */
  const blockRoomsFor = useCallback(
    (block: BoardBlock): Map<string, string | null> =>
      dragTools?.suggestedBlockRooms({ block, posts: postById, rules: roomRulesQuery.data ?? [], gradeLevelOf: (groupId) => groupById.get(groupId)?.gradeLevel ?? null }) ?? new Map(),
    [dragTools, postById, roomRulesQuery.data, groupById],
  );
  /** The rooms a block brick is laid with: what the fields hold when it is the chosen one, else the suggestion. */
  const roomsOfBlockBrick = useCallback(
    (brick: BlockBrick): Map<string, string | null> => {
      const block = blockById.get(brick.blockId);
      if (brickKey === brick.key && blockDraft) return new Map(Object.entries(blockDraft.rooms));
      return block ? blockRoomsFor(block) : new Map();
    },
    [blockById, brickKey, blockDraft, blockRoomsFor],
  );
  const firstBlockSpot = useMemo((): Spot => {
    const start = { dayOfWeek: 1, startMinutes: 8 * 60 };
    const block = selectedBlockBrick ? blockById.get(selectedBlockBrick.blockId) : undefined;
    if (!selectedBlockBrick || !block || !drag) return start;
    const mover = drag.moverOfBlockBrick(selectedBlockBrick.key, block, postById, blockRoomsFor(block));
    return drag.nextFreeSpotOfBlock(mover, selectedBlockBrick.minutes, { dayOfWeek: 1, startMinutes: start.startMinutes - 15 }) ?? start;
    // The brick's key is its identity: a brick re-counted after a write is the same brick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBlockBrick?.key, drag, postById, blockById]);
  // Where the fields of a chosen brick start: the first time the week is free for it (searched once per brick, not at every
  // render), else Monday 08:00.
  const firstSpot = useMemo((): Spot => {
    const start = { dayOfWeek: 1, startMinutes: 8 * 60 };
    const post = selectedBrick ? postById.get(selectedBrick.postId) : undefined;
    if (!selectedBrick || !post || !drag) return start;
    const mover: Mover = { id: selectedBrick.key, post, teacherId: selectedBrick.teacherId ?? post.teacherId, roomId: null, recurrence: pairWeeksOf(selectedBrick) ?? post.recurrence };
    // From a quarter before the day: the first time the search offers is Monday 08:00 itself when it is free.
    return drag.nextFreeSpot(mover, selectedBrick.minutes, { dayOfWeek: 1, startMinutes: start.startMinutes - 15 }) ?? start;
    // The brick's key is its identity: a brick re-counted after a write is the same brick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBrick?.key, drag, postById, held?.recurrence, weeksChoice]);
  // A brick that is gone (it was the post's last) is a selection that ends.
  useEffect(() => {
    if (brickKey !== null && everything && !selectedBrick && !selectedBlockBrick) setBrickKey(null);
  }, [brickKey, selectedBrick, selectedBlockBrick, everything]);
  // What the gateway refused belongs to the lesson it was said about.
  useEffect(() => setRefusal(null), [brickKey, openCard]);

  // The week is read again after a write (and when somebody else changes it); a key that is not the one our last write left ends the history.
  // Not while a write is on its way: a read that was started by the write before it can land after this one has committed and
  // before its answer has (the week then shows a key that is not yet ours), and that is our own write and nobody else's. The
  // effect runs again when the write is done, against the week as its answer left it.
  useEffect(() => {
    if (saving) return;
    if (reconcile(everything)) setMessage({ tone: "problem", text: t("staleHistory") });
  }, [everything, reconcile, saving, t]);
  useEffect(() => {
    history.clear();
    setBrickKey(null);
    setOpenCard(null);
    setMarkedBlockCard(null);
    setMessage(null);
    // The history is one stack for the page, and a year has its own rows; the weeks and a half held belong to the year that is left.
    setWeek(null);
    setWeeksChoice("ALL_WEEKS");
    if (held) {
      setHeld(null);
      setMessage({ tone: "ok", text: tPair("releasedYear") });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year?.id]);
  // The part a held half is a half of has no lesson left to lay (somebody else laid it, the post was changed): the half is let go and the page says so.
  useEffect(() => {
    if (!held || !everything || heldBrick || saving) return;
    setHeld(null);
    setBrickKey(null);
    setMessage({ tone: "problem", text: tPair("releasedGone", { lesson: postName(heldPost) }) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [held, everything, heldBrick, saving]);
  // A brick chosen anew is laid every week until the reader says otherwise.
  useEffect(() => {
    if (!held) setWeeksChoice("ALL_WEEKS");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brickKey]);
  // Leaving with a half held asks first: the half is the one thing here that nobody else has (lib/leave-guard.ts).
  const holding = held !== null;
  useEffect(() => (holding ? pairTools?.guardLeaving(tPair("leave")) : undefined), [holding, pairTools, tPair]);

  // The element a change should leave the keyboard on, once the week has been drawn with the change in it. Not for ever: an
  // element that never comes (a filter hides it) must not take the keyboard later, when something else has been drawn.
  useEffect(() => {
    if (!pendingFocus) return;
    const element = document.querySelector<HTMLElement>(pendingFocus);
    if (element) {
      element.focus();
      setPendingFocus(null);
      return;
    }
    const giveUp = setTimeout(() => setPendingFocus(null), 3000);
    return () => clearTimeout(giveUp);
  }, [pendingFocus, cards, brickGroups, blockBrickGroups]);

  const loading = !year || board.isLoading || groupsQuery.isLoading || subjectsQuery.isLoading || roomsQuery.isLoading || peopleQuery.isLoading;

  // The post the Förlägg dialog's link names: scrolled to and focused once the list is there.
  useEffect(() => {
    if (!focusPost || !shown || loading) return;
    const element = document.getElementById(`post-${focusPost}`);
    if (!element) return;
    element.scrollIntoView({ block: "center" });
    element.focus({ preventScroll: true });
    setFocusPost(null);
  }, [focusPost, shown, loading]);

  const failingShown = (shown?.placements ?? []).filter((row) => !row.verdict.ok);
  // A lesson of a block that does not hold is one line, however many of its posts it fails for.
  const failingBlockLessons = shownBlocks.flatMap((block) => block.rows.filter((row) => row.verdicts.some((verdict) => !verdict.ok)).map((row) => ({ block, row })));
  const failed = board.isError && board.data === undefined;
  const running = (jobsQuery.data ?? []).some(
    (job) => (job.status === "PENDING" || job.status === "RUNNING") && Date.now() - new Date(job.createdAt).getTime() < RUNNING_MS,
  );

  /** The sentence for a drop the week does not hold, in the reader's language and the gateway's own words. */
  const sentenceOf = useCallback(
    (drop: Drop): string => {
      switch (drop.kind) {
        case "OK":
          return t("free");
        case "KEPT":
          return t("keptCannotMove");
        case "LENGTH":
          return t("lengthCannotChange");
        case "DAY":
          return t("outsideDay");
        case "CLASH":
          return drop.reason === "AVAILABILITY" && !drop.params ? t("availabilityAny") : verdictSentence(tPlacements, drop.reason, drop.params);
      }
    },
    [t, tPlacements],
  );

  /** The sentence for a drop of a block's lesson: the post that clashes first, as the gateway names it ("Tyska Ty7: Läraren har redan …"). */
  const blockSentenceOf = useCallback(
    (drop: Drop): string => {
      const said = sentenceOf(drop);
      if (drop.kind !== "CLASH" || drop.requirementId === undefined) return said;
      const named = postById.has(drop.requirementId) ? postName(postById.get(drop.requirementId)) : tBlock("postGone");
      return tBlock("postSaid", { posts: named, sentence: said });
    },
    [sentenceOf, postById, postName, tBlock],
  );

  const roomsList = useMemo(() => (roomsQuery.data ?? []).map((room) => ({ id: room.id, name: room.name })), [roomsQuery.data]);
  const roomFor = useCallback(
    (brick: Brick): string | null => {
      const post = postById.get(brick.postId);
      if (!post) return null;
      return (
        dragTools?.suggestedRoom({
          postRows: rowsOfPost(everything ?? { placements: [] }, post.id),
          rules: roomRulesQuery.data ?? [],
          subjectId: post.subjectId,
          gradeLevel: groupById.get(post.studentGroupId)?.gradeLevel ?? null,
          filterRooms: filters.rooms,
        }) ?? null
      );
    },
    [dragTools, postById, everything, roomRulesQuery.data, groupById, filters.rooms],
  );
  const moverOfBrick = useCallback(
    (brick: Brick, roomId: string | null): Mover | null => {
      const post = postById.get(brick.postId);
      // A half of a pair is judged for its own weeks: the odd half does not meet the even weeks' lessons.
      return post ? { id: brick.key, post, teacherId: brick.teacherId ?? post.teacherId, roomId, recurrence: pairWeeksOf(brick) ?? post.recurrence } : null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [postById, held, brickKey, weeksChoice],
  );

  /**
   * A sentence added when the lesson that is in the way is one that stopped holding and was let stand: the judge is symmetric and sees every
   * row, so a new lesson beside it is refused until the red one is moved or taken away (the handbook says it too).
   */
  const meetsRed = useCallback(
    (params: Record<string, string | number> | undefined): string => {
      const red = everything ? redLessonNamed(everything, params, otherNames) : null;
      return red ? ` ${tBlock("meetsRed", { when: whenText(red.dayOfWeek, minutesOfClock(red.startTime), minutesOfClock(red.endTime) - minutesOfClock(red.startTime)) })}` : "";
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [everything, otherNames, tBlock, tDays],
  );

  /** One thing the gateway refused, or failed to do, said once and in place. */
  const problemFrom = useCallback(
    (error: unknown) => {
      const problem = writeProblemOf(error);
      const failure = error instanceof WriteFailure ? error : null;
      const cause = failure ? failure.reason : error;
      if (problem === "STALE") {
        // A pair's write that finds the post changed writes nothing, and the first half stays held: it is the second that is laid again.
        // Only the pair's own write says so (it alone has a second row that changed with the first); another write meeting a STALE says what it always does.
        const text = held && failure?.alsoChanged.length ? tPair("staleKept") : cause instanceof ApiError && cause.code === "BLOCK_PLACEMENTS_STALE" ? tBlock("stale") : t("stale");
        setMessage({ tone: "problem", text });
        void board.refetch();
        return;
      }
      if (problem === "BUSY") {
        setMessage({ tone: "problem", text: tPlacements("busy") });
        return;
      }
      // A parallel block's lessons: the gateway names the lesson (a place in the list that was SENT) and the post of the block that clashes.
      const ofBlock = blockPlacementsRefusal(cause);
      if (ofBlock?.kind === "ROW") {
        const sentence = verdictSentence(tPlacements, ofBlock.reason, ofBlock.params);
        const post = postById.has(ofBlock.requirementId) ? postName(postById.get(ofBlock.requirementId)) : tBlock("postGone");
        const named = failure ? failure.list[ofBlock.index] : undefined;
        // A lesson of the block that is not the one that was changed (one that stopped holding and was let stand) refuses the change, and the sentence is about it.
        if (named && ofBlock.index !== failure!.changedIndex) {
          setMessage({
            tone: "problem",
            text: `${tBlock("otherRowRefused", { when: whenText(named.dayOfWeek, minutesOfClock(named.startTime), named.minutes), reason: tBlock("postSaid", { posts: post, sentence }) })}${meetsRed(ofBlock.params)}`,
          });
          return;
        }
        setRefusal(tBlock("postSaid", { posts: post, sentence }));
        setMessage({ tone: "problem", text: `${tBlock("cannotStandThere", { post, reason: sentence })}${meetsRed(ofBlock.params)}` });
        return;
      }
      if (ofBlock?.kind === "FIT") {
        const sentence = blockFitSentence(tBlockFit, ofBlock.reason, tBlockFit("otherBlock"));
        setRefusal(sentence);
        setMessage({ tone: "problem", text: `${t("notSaved")} ${sentence}` });
        // The block is not what this page holds (its posts' lessons or members were changed elsewhere, and the key, which is the lessons', says nothing
        // of that): read the week again, or every later try is refused the same way until the page is reloaded.
        void board.refetch();
        return;
      }
      const refused = placementsRefusal(cause);
      if (refused) {
        const sentence = refused.kind === "ROW" ? verdictSentence(tPlacements, refused.reason, refused.params) : fitSentence(tPlacements, refused.reason);
        // The gateway judges every row of the post, so the row it names may be another than the one that was changed (a row that
        // no longer holds refuses every change of the post): then it is said about that row, and the change waits for it.
        const ofRow = refused.kind === "ROW" ? refused : null;
        const named = ofRow && failure ? failure.list[ofRow.index] : undefined;
        // Either half of a pair is the change that was made: the sentence is about the pair, with the half it names.
        if (ofRow && named && failure!.alsoChanged.length > 0 && (ofRow.index === failure!.changedIndex || failure!.alsoChanged.includes(ofRow.index))) {
          const reason = `${whenText(named.dayOfWeek, minutesOfClock(named.startTime), named.minutes)}: ${sentence}`;
          setRefusal(reason);
          setMessage({ tone: "problem", text: `${tPair("cannotPair", { reason })}${meetsRed(ofRow.params)}` });
          return;
        }
        if (ofRow && named && ofRow.index !== failure!.changedIndex) {
          setMessage({
            tone: "problem",
            text: t("otherRowRefused", { when: whenText(named.dayOfWeek, minutesOfClock(named.startTime), named.minutes), reason: sentence }),
          });
          return;
        }
        setRefusal(sentence);
        setMessage({ tone: "problem", text: `${t("cannotStandThere", { reason: sentence })}${ofRow ? meetsRed(ofRow.params) : ""}` });
        return;
      }
      const cannot = cause instanceof ApiError || cause instanceof Error ? cause.message : "";
      setMessage({ tone: "problem", text: `${t("notSaved")} ${cannot}`.trim() });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [board, t, tBlock, tBlockFit, tPair, tPlacements, tDays, postById, postName, meetsRed, held],
  );

  /** One change to one post: written, said, and the keyboard left on what changed. */
  const change = useCallback(
    async (postId: string, edit: RowEdit, label: string, said: string, focusOn: (keys: string[]) => string | null): Promise<boolean> => {
      if (saving) {
        setMessage({ tone: "ok", text: t("waitSaving") });
        return false;
      }
      try {
        const result = await editor.change(postId, edit, label);
        if (!result.ok) {
          setMessage({ tone: "problem", text: t("gone") });
          void board.refetch();
          return false;
        }
        setRefusal(null);
        // A row the post had already that does not hold is let stand by the gateway and named in its answer: said here by name,
        // as the week's own banner and the row say it, so that the change is not taken for a post that is all right.
        const failing = result.answer.placements.flatMap((row, index) => {
          const verdict = result.answer.verdicts[index];
          return verdict && !verdict.ok ? [{ row, verdict }] : [];
        });
        const rows = failing
          .map(({ row, verdict }) => `${whenText(row.dayOfWeek, minutesOfClock(row.startTime), row.minutes)}: ${verdictSentence(tPlacements, verdict.reason, verdict.params)}`)
          .join("; ");
        setMessage({
          tone: failing.length > 0 ? "problem" : "ok",
          text: `${said} ${t("fromNextGenerate")}${failing.length > 0 ? ` ${t("stillFailing", { count: failing.length, rows })}` : ""}`,
        });
        warned.say(result.answer.warnings);
        const target = focusOn(keysOfRows(result.answer.placements));
        if (target) setPendingFocus(target);
        return true;
      } catch (error) {
        problemFrom(error);
        return false;
      }
    },
    [saving, editor, board, problemFrom, t, warned.say],
  );

  /** The card whose key is the lesson's after the change: of equal ones, the last. */
  const cardOfKey = (base: string) => (rowKeys: string[]): string | null => {
    const same = rowKeys.filter((key) => key === base || key.startsWith(`${base}#`));
    const last = same.at(-1);
    return last ? `[data-lesson-id="${placementCardId(last)}"]` : null;
  };

  const place = useCallback(
    async (brick: Brick, spot: Spot, roomId: string | null): Promise<boolean> => {
      const post = postById.get(brick.postId);
      if (!post) return false;
      const input = inputOfBrick(brick, post, spot, roomId);
      const lesson = postName(post);
      const base = placementKeyOf({ requirementId: post.id, teacherId: input.teacherId ?? null, minutes: brick.minutes, dayOfWeek: spot.dayOfWeek, startTime: input.startTime, recurrence: input.recurrence });
      const done = await change(
        post.id,
        { kind: "add", input },
        "place",
        t("placed", { lesson, when: whenText(spot.dayOfWeek, spot.startMinutes, brick.minutes) }),
        cardOfKey(base),
      );
      if (done) setBrickKey(null);
      return done;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [postById, postName, change, t, tDays],
  );

  // ---------------------------------------------------------------- a pair (D2): what the page does with it is lib/placement-pair-control.ts, fetched when the page is up
  const pair = pairTools
    ? pairTools.pairControl({
        held,
        setHeld,
        setBrickKey,
        setWeeksChoice,
        weeksOf: pairWeeksOf,
        postById,
        mirror,
        moverOfBrick,
        otherNames,
        say: setMessage,
        setRefusal,
        sentenceOf,
        meetsRed,
        change,
        cardOfKey,
        t,
        tPair,
        tWeeks,
        tDays,
        postName,
        week,
        yearWeeks,
        nearestWeekOf: weekTools?.nearestWeekOf,
        setWeek,
      })
    : null;
  /** A brick laid, pulled or pointed to: a lesson of every week, or a half of the pair the reader chose (the first is held, the second writes both). */
  const layBrick = (brick: Brick, spot: Spot, roomId: string | null): Promise<boolean> =>
    pairWeeksOf(brick) === null ? place(brick, spot, roomId) : (pair?.lay(brick, spot, roomId) ?? Promise.resolve(false));

  const move = useCallback(
    async (card: string, to: Spot, roomId?: string | null): Promise<boolean> => {
      const row = rowByCard.get(card);
      const post = row ? postById.get(row.requirementId) : undefined;
      if (!row || !post) return false;
      const key = keys.get(row.id)!;
      const next = placementKeyOf({ ...row, teacherId: row.teacherId, dayOfWeek: to.dayOfWeek, startTime: clockOfMinutes(to.startMinutes) });
      return change(
        post.id,
        { kind: "move", key, to, ...(roomId !== undefined ? { roomId } : {}) },
        "move",
        t("moved", { lesson: postName(post), when: whenText(to.dayOfWeek, to.startMinutes, row.minutes) }),
        cardOfKey(next),
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rowByCard, postById, keys, change, postName, t, tDays],
  );

  const remove = useCallback(
    async (card: string): Promise<boolean> => {
      const row = rowByCard.get(card);
      const post = row ? postById.get(row.requirementId) : undefined;
      if (!row || !post || !everything) return false;
      const doomed = removalOf(rowsOfPost(everything, post.id), post, keys.get(row.id)!);
      const brickOfPost = `[data-brick^="${post.id}|${row.teacherId ?? post.teacherId ?? ""}|${row.minutes}#"]`;
      const done = await change(
        post.id,
        { kind: "remove", keys: doomed },
        "remove",
        t(doomed.length > 1 ? "removedPair" : "removed", { lesson: postName(post) }),
        // The lesson is a brick again: the keyboard goes to the brick, or to the list when it is not drawn.
        () => brickOfPost,
      );
      if (done) setOpenCard(null);
      return done;
    },
    [rowByCard, postById, everything, keys, change, postName, t],
  );

  // ---------------------------------------------------------------- a block's lessons

  /** The card whose key is the lesson's after the change: of equal ones, the last. */
  const cardOfBlockKey = (base: string) => (rowKeys: string[]): string | null => {
    const same = rowKeys.filter((key) => key === base || key.startsWith(`${base}#`));
    const last = same.at(-1);
    return last ? `[data-lesson-id="${blockCardId(last)}"]` : null;
  };

  /** One change to one block: written, said, and the keyboard left on what changed. */
  const changeBlockLessons = useCallback(
    async (blockId: string, edit: BlockEdit, label: string, said: string, focusOn: (keys: string[]) => string | null): Promise<boolean> => {
      if (saving) {
        setMessage({ tone: "ok", text: t("waitSaving") });
        return false;
      }
      try {
        const result = await editor.changeBlock(blockId, edit, label);
        if (!result.ok) {
          setMessage({ tone: "problem", text: t("gone") });
          void board.refetch();
          return false;
        }
        setRefusal(null);
        // A lesson the block had already that does not hold is let stand by the gateway and named in its answer, by lesson and post:
        // said here, as the red box says it, so that the change is not taken for a block that is all right. `index` is the lesson's
        // place in the ANSWER's list (day, start), which is what `placements` is.
        const block = blockById.get(blockId);
        const failing = result.answer.placements.flatMap((lesson, index) => {
          const verdicts = verdictsOfAnswerRow(result.answer, index).filter((verdict) => !verdict.ok);
          return verdicts.length > 0 ? [{ lesson, verdicts }] : [];
        });
        const lessons = failing
          .map(({ lesson, verdicts }) => `${whenText(lesson.dayOfWeek, minutesOfClock(lesson.startTime), lesson.minutes)}: ${linesOf(block, verdicts as BoardBlockRow["verdicts"]).join(" ")}`)
          .join("; ");
        setMessage({
          tone: failing.length > 0 ? "problem" : "ok",
          text: `${said} ${t("fromNextGenerate")}${failing.length > 0 ? ` ${tBlock("stillFailing", { count: failing.length, rows: lessons })}` : ""}`,
        });
        void warned.sayBlock(blockId, () => board.refetch({ cancelRefetch: false }));
        const target = focusOn(keysOfBlockRows(blockId, result.answer.placements));
        if (target) setPendingFocus(target);
        return true;
      } catch (error) {
        problemFrom(error);
        return false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [saving, editor, board, problemFrom, blockById, t, tBlock, warned.sayBlock],
  );

  const choicesOf = (rooms: ReadonlyMap<string, string | null>): BlockRoomChoice[] =>
    [...rooms].flatMap(([requirementId, roomId]) => (roomId ? [{ requirementId, roomId }] : []));

  const placeBlock = useCallback(
    async (brick: BlockBrick, spot: Spot, rooms: ReadonlyMap<string, string | null>): Promise<boolean> => {
      const block = blockById.get(brick.blockId);
      if (!block) return false;
      const input = blockInputOfBrick(brick, spot, choicesOf(rooms));
      const base = blockKeyOf(block.id, { minutes: brick.minutes, dayOfWeek: spot.dayOfWeek, startTime: input.startTime, recurrence: weeksOfBlock(block) });
      const done = await changeBlockLessons(
        block.id,
        { kind: "add", input },
        "place",
        t("placed", { lesson: block.name, when: whenText(spot.dayOfWeek, spot.startMinutes, brick.minutes) }),
        cardOfBlockKey(base),
      );
      if (done) setBrickKey(null);
      return done;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [blockById, changeBlockLessons, t, tDays],
  );

  const moveBlock = useCallback(
    async (card: string, to: Spot, rooms?: ReadonlyMap<string, string | null>): Promise<boolean> => {
      const found = lessonByCard.get(card);
      if (!found) return false;
      const next = blockKeyOf(found.block.id, { minutes: found.row.minutes, dayOfWeek: to.dayOfWeek, startTime: clockOfMinutes(to.startMinutes), recurrence: found.row.recurrence });
      return changeBlockLessons(
        found.block.id,
        { kind: "move", key: found.key, to, ...(rooms ? { rooms: choicesOf(rooms) } : {}) },
        "move",
        t("moved", { lesson: found.block.name, when: whenText(to.dayOfWeek, to.startMinutes, found.row.minutes) }),
        cardOfBlockKey(next),
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lessonByCard, changeBlockLessons, t, tDays],
  );

  const removeBlockLesson = useCallback(
    async (card: string): Promise<boolean> => {
      const found = lessonByCard.get(card);
      if (!found) return false;
      const done = await changeBlockLessons(
        found.block.id,
        { kind: "remove", key: found.key },
        "remove",
        t("removed", { lesson: found.block.name }),
        // The lesson is a brick again: the keyboard goes to the block's brick, or to the list when it is not drawn.
        () => `[data-brick^="${blockBrickKey(found.block.id, found.row.minutes, 0).slice(0, -1)}"]`,
      );
      if (done) setOpenCard(null);
      return done;
    },
    [lessonByCard, changeBlockLessons, t],
  );

  // ---------------------------------------------------------------- the grid's side

  const validateChange = useCallback(
    (id: string, to: LessonChange): boolean => {
      if (!toolsHere) return false;
      if (!drag) return true;
      const span = { dayOfWeek: to.dayOfWeek, startMinutes: to.startMinutes, endMinutes: to.endMinutes };
      if (held && id === heldHalfCardId(held.partKey)) {
        const mover = pair?.moverOfHeld();
        return !!mover && to.endMinutes - to.startMinutes === held.minutes && drag.dropOf(mover, span).kind === "OK";
      }
      const brick = brickByKey.get(id);
      if (brick) {
        const mover = moverOfBrick(brick, roomFor(brick));
        return mover !== null && drag.dropOf(mover, span).kind === "OK";
      }
      const blockBrick = blockBrickByKey.get(id);
      const blockOfBrick = blockBrick ? blockById.get(blockBrick.blockId) : undefined;
      if (blockBrick && blockOfBrick) {
        return drag.dropOfBlock(drag.moverOfBlockBrick(blockBrick.key, blockOfBrick, postById, roomsOfBlockBrick(blockBrick)), span).kind === "OK";
      }
      const lesson = lessonByCard.get(id);
      if (lesson) {
        // A lesson of a block keeps its length: the block's.
        if (to.endMinutes - to.startMinutes !== lesson.row.minutes) return false;
        return drag.dropOfBlock(drag.moverOfBlockRow(id, lesson.key, lesson.block, lesson.row, postById), span).kind === "OK";
      }
      const row = rowByCard.get(id);
      const post = row ? postById.get(row.requirementId) : undefined;
      // A kept lesson is not moved here, and a placed lesson keeps its length: the post's.
      if (!row || !post || to.endMinutes - to.startMinutes !== row.minutes) return false;
      return drag.dropOf(drag.moverOfRow(id, row, post), span).kind === "OK";
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toolsHere, drag, brickByKey, moverOfBrick, roomFor, rowByCard, postById, blockBrickByKey, blockById, roomsOfBlockBrick, lessonByCard, held, pair],
  );

  /** Why a lesson cannot stand where it was let go or pointed to. */
  const refuseDrop = useCallback(
    (id: string, to: LessonChange, moving: boolean) => {
      if (!toolsHere) return void setMessage({ tone: "problem", text: t("toolsLoading") });
      let drop: Drop = { kind: "OK" };
      const span = { dayOfWeek: to.dayOfWeek, startMinutes: to.startMinutes, endMinutes: to.endMinutes };
      if (held && id === heldHalfCardId(held.partKey)) {
        const mover = pair?.moverOfHeld();
        const said: Drop = to.endMinutes - to.startMinutes !== held.minutes ? { kind: "LENGTH" } : drag && mover ? drag.dropOf(mover, span) : OK_DROP;
        setMessage({ tone: "problem", text: `${t("cannotMoveThere", { reason: sentenceOf(said) })}${said.kind === "CLASH" ? meetsRed(said.params) : ""}` });
        return;
      }
      const brick = brickByKey.get(id);
      const row = rowByCard.get(id);
      const post = row ? postById.get(row.requirementId) : undefined;
      const blockBrick = blockBrickByKey.get(id);
      const blockOfBrick = blockBrick ? blockById.get(blockBrick.blockId) : undefined;
      const lesson = lessonByCard.get(id);
      if (!brick && !row && !blockBrick && !lesson) drop = { kind: "KEPT" };
      else if ((row && to.endMinutes - to.startMinutes !== row.minutes) || (lesson && to.endMinutes - to.startMinutes !== lesson.row.minutes)) drop = { kind: "LENGTH" };
      else if (drag) {
        if (blockBrick && blockOfBrick) drop = drag.dropOfBlock(drag.moverOfBlockBrick(blockBrick.key, blockOfBrick, postById, roomsOfBlockBrick(blockBrick)), span);
        else if (lesson) drop = drag.dropOfBlock(drag.moverOfBlockRow(id, lesson.key, lesson.block, lesson.row, postById), span);
        else {
          const mover = brick ? moverOfBrick(brick, roomFor(brick)) : row && post ? drag.moverOfRow(id, row, post) : null;
          if (mover) drop = drag.dropOf(mover, span);
        }
      }
      // A refusal for a lesson of a block names the POST that clashes: the sentence alone is about a lesson none of the others has.
      if (drop.kind === "CLASH" && drop.requirementId !== undefined) {
        const named = postById.has(drop.requirementId) ? postName(postById.get(drop.requirementId)) : tBlock("postGone");
        setMessage({ tone: "problem", text: `${tBlock(moving ? "cannotMoveThere" : "cannotStandThere", { post: named, reason: sentenceOf(drop) })}${meetsRed(drop.params)}` });
        return;
      }
      setMessage({ tone: "problem", text: `${t(moving ? "cannotMoveThere" : "cannotStandThere", { reason: sentenceOf(drop) })}${drop.kind === "CLASH" ? meetsRed(drop.params) : ""}` });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [toolsHere, brickByKey, rowByCard, postById, drag, moverOfBrick, roomFor, sentenceOf, t, tBlock, blockBrickByKey, blockById, lessonByCard, roomsOfBlockBrick, postName, meetsRed, held, pair],
  );

  const handleChange = useCallback(
    (id: string, to: LessonChange) => {
      if (held && id === heldHalfCardId(held.partKey)) {
        pair?.moveHeld(to);
        return;
      }
      const brick = brickByKey.get(id);
      if (brick) {
        // Pulled in from Att lägga: the room is the one the fields hold when this brick is the chosen one, else the suggestion.
        // A brick that is half of a pair is laid for its weeks (layBrick).
        const chosen = held ? partKeyOfBrick(brick) === held.partKey : brickKey === brick.key;
        void layBrick(brick, { dayOfWeek: to.dayOfWeek, startMinutes: to.startMinutes }, chosen && draft ? draft.roomId : roomFor(brick));
        return;
      }
      const blockBrick = blockBrickByKey.get(id);
      if (blockBrick) {
        void placeBlock(blockBrick, { dayOfWeek: to.dayOfWeek, startMinutes: to.startMinutes }, roomsOfBlockBrick(blockBrick));
        return;
      }
      // A lesson of a block that is dragged keeps the rooms its posts chose.
      if (lessonByCard.has(id)) {
        void moveBlock(id, { dayOfWeek: to.dayOfWeek, startMinutes: to.startMinutes });
        return;
      }
      if (rowByCard.has(id)) void move(id, { dayOfWeek: to.dayOfWeek, startMinutes: to.startMinutes });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [brickByKey, brickKey, draft, roomFor, layBrick, rowByCard, move, blockBrickByKey, placeBlock, roomsOfBlockBrick, lessonByCard, moveBlock, held],
  );

  const handleSlot = useCallback(
    (day: number, minute: number) => {
      if (!toolsHere) return void setMessage({ tone: "problem", text: t("toolsLoading") });
      if (mayWrite && selectedBlockBrick) {
        const rooms = roomsOfBlockBrick(selectedBlockBrick);
        const block = blockById.get(selectedBlockBrick.blockId);
        if (drag && block) {
          const drop = drag.dropOfBlock(drag.moverOfBlockBrick(selectedBlockBrick.key, block, postById, rooms), { dayOfWeek: day, startMinutes: minute, endMinutes: minute + selectedBlockBrick.minutes });
          // As for a post: the mirror is asked for the school day, and the gateway answers the press either way.
          if (drop.kind === "DAY") return void setMessage({ tone: "problem", text: t("cannotStandThere", { reason: sentenceOf(drop) }) });
        }
        void placeBlock(selectedBlockBrick, { dayOfWeek: day, startMinutes: minute }, rooms);
        return;
      }
      if (!mayWrite || !selectedBrick) return;
      const span = { dayOfWeek: day, startMinutes: minute, endMinutes: minute + selectedBrick.minutes };
      const room = draft ? draft.roomId : roomFor(selectedBrick);
      if (drag) {
        const mover = moverOfBrick(selectedBrick, room);
        const drop = mover ? drag.dropOf(mover, span) : OK_DROP;
        // The mirror may be stricter than the gateway, and is asked for what it knows; the gateway answers the press either way.
        if (drop.kind === "DAY") return void setMessage({ tone: "problem", text: t("cannotStandThere", { reason: sentenceOf(drop) }) });
      }
      void layBrick(selectedBrick, { dayOfWeek: day, startMinutes: minute }, room);
    },
    [toolsHere, mayWrite, selectedBrick, draft, roomFor, drag, moverOfBrick, layBrick, sentenceOf, t, selectedBlockBrick, roomsOfBlockBrick, blockById, postById, placeBlock],
  );

  /** A press on a brick that has not moved yet (a click chooses; only a pointer that moves pulls). */
  const pressed = useRef<(() => void) | null>(null);
  useEffect(() => () => pressed.current?.(), []);

  const pull = useCallback(
    (key: string, event: React.PointerEvent) => {
      const brick = brickByKey.get(key);
      // With a half held no other lesson is pulled in: the half is laid or let go first (lib/placement-pair.ts).
      if (held && !(brick && partKeyOfBrick(brick) === held.partKey)) {
        setMessage({ tone: "problem", text: tPair("finishFirst") });
        return;
      }
      const post = brick ? postById.get(brick.postId) : undefined;
      const blockBrick = blockBrickByKey.get(key);
      const block = blockBrick ? blockById.get(blockBrick.blockId) : undefined;
      // What the grid draws under the pointer: a post's lesson, or the block's (its name, and the posts' subjects).
      const ghost =
        brick && post
          ? {
              minutes: brick.minutes,
              title: names.subject(post.subjectId)?.name ?? "",
              subtitle: [names.group(post.studentGroupId), names.teacher(brick.teacherId)].filter(Boolean).join(" · "),
              color: names.color(post.subjectId, names.subject(post.subjectId)?.color),
            }
          : blockBrick && block
            ? {
                minutes: blockBrick.minutes,
                title: block.name,
                subtitle: block.memberIds.map((id) => names.subject(postById.get(id)?.subjectId ?? "")?.name).filter(Boolean).join(" · "),
                color: names.color(block.id, null),
              }
            : null;
      if (!ghost) return;
      pressed.current?.();
      const { pointerId, clientX, clientY } = event;
      // The drag starts when the pointer has moved a few pixels, not at the press: a click that begins a drag at once leaves
      // the grid holding one when the button comes up before it has attached its listeners (a click from a script does).
      const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        pressed.current = null;
      };
      const move = (moved: PointerEvent) => {
        if (moved.pointerId !== pointerId || Math.abs(moved.clientX - clientX) + Math.abs(moved.clientY - clientY) < 5) return;
        stop();
        gridRef.current?.beginExternalDrag(
          {
            id: key,
            dayOfWeek: 1,
            startMinutes: 8 * 60,
            endMinutes: 8 * 60 + ghost.minutes,
            title: ghost.title,
            subtitle: ghost.subtitle,
            color: ghost.color,
          },
          { pointerId, clientX: moved.clientX, clientY: moved.clientY },
        );
      };
      const end = (done: PointerEvent) => {
        if (done.pointerId === pointerId) stop();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
      pressed.current = stop;
    },
    [brickByKey, postById, names, blockBrickByKey, blockById, held, tPair],
  );

  const openedRow = openCard ? rowByCard.get(openCard) : undefined;
  const openedKept = openCard ? keptById.get(openCard) : undefined;
  const openedPost = openedRow ? postById.get(openedRow.requirementId) : undefined;
  const openedLesson = openCard ? lessonByCard.get(openCard) : undefined;
  // A card that is gone (somebody else removed it, a save gave it another place) is a dialog that closes.
  useEffect(() => {
    if (openCard !== null && everything && !openedRow && !openedKept && !openedLesson) setOpenCard(null);
  }, [openCard, everything, openedRow, openedKept, openedLesson]);

  // The lesson of a block that the address names (&block=…&day=…&start=…): its card is marked and the keyboard goes to it, once the week is drawn.
  // The dialog is not opened. A lesson that is not there any more (it was moved or taken away since the link was made) is said in words.
  useEffect(() => {
    if (!blockLink || !everything || loading) return;
    const found = lessonOfBlockLink(everything.blocks, blockLink);
    setBlockLink(null);
    if (!found) return void setLinkGone(true);
    setMarkedBlockCard(found.card);
    setPendingFocus(`[data-lesson-id="${found.card}"]`);
  }, [blockLink, everything, loading]);
  // The open card, the post's card an address from Generera or the grundschema marks (A3's hook) and the block's card an address names (above).
  const selectedCards = useMemo(() => {
    const ids = [openCard, markedCard, markedBlockCard].filter((id): id is string => id !== null);
    return ids.length > 0 ? new Set(ids) : undefined;
  }, [openCard, markedCard, markedBlockCard]);

  const lessonOfBrick = (brick: Brick | undefined): string =>
    brick ? t("brickLabel", { lesson: postName(postById.get(brick.postId)), teacher: teacherText(brick.teacherId), minutes: brick.minutes }) : "";
  const lessonOfBlockBrick = (brick: BlockBrick | undefined): string => {
    const block = brick ? blockById.get(brick.blockId) : undefined;
    return brick && block ? tBlock("brickLabel", { block: block.name, minutes: brick.minutes, count: block.memberIds.length }) : "";
  };

  const undoOrRedo = useCallback(
    async (kind: "undo" | "redo") => {
      if (saving) return void setMessage({ tone: "ok", text: t("waitSaving") });
      // A half that is held is the newest thing done and is taken back first, before any step that was written; redo never brings one back.
      if (kind === "undo" && held) return pair?.release(tPair("undoneHalf"));
      try {
        const step = await (kind === "undo" ? history.undo() : history.redo());
        if (!step) return;
        setMessage({ tone: "ok", text: `${t(kind === "undo" ? "undone" : "redone", { what: t(step.label === "place" ? "stepPlace" : step.label === "move" ? "stepMove" : "stepRemove") })} ${t("fromNextGenerate")}` });
      } catch (error) {
        // A step on a post somebody else has changed is refused (STALE) and the week is read again; the week it then shows
        // carries a key that is not our last write's, and that ends the history (reconcile).
        problemFrom(error);
      }
    },
    [saving, history, problemFrom, t, held, pair, tPair],
  );
  useHistoryKeyboard(
    mayWrite ? { undo: async () => (await undoOrRedo("undo"), null), redo: async () => (await undoOrRedo("redo"), null) } : NO_HISTORY,
  );

  const filterSections = [{ label: undefined, options: groups.map((group) => ({ id: group.id, name: group.name })) }];
  const pick = (key: keyof BoardFilters) => (value: string[]) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setBrickKey(null);
  };

  return (
    <Page>
      <PageHeader
        title={t("title")}
        subtitle={year ? t("subtitle", { year: year.name }) : undefined}
        actions={
          <>
            {/* The two year buttons are wide ("2027/28 (nästa, inte aktiverat)"): wrapping keeps a phone's page from scrolling sideways. */}
            <PlanningYearPicker year={year} active={active} successor={successor} onChoose={choose} className="max-w-full flex-wrap" />
            {/* Pages the profile that does not write their area cannot use: shown to the one that does (LÅG-5 of the review of #315). */}
            <Button variant="outline" size="sm" asChild data-writes="PLANERING">
              <Link href="/admin/requirements">{t("toRequirements")}</Link>
            </Button>
            <Button variant="outline" size="sm" asChild data-writes="SCHEMALAGGNING">
              <Link href="/admin/generate">{t("toGenerate")}</Link>
            </Button>
          </>
        }
      />
      <ProjectedRostersBanner year={year} active={active} rosters={rosters} failed={rostersFailed} />

      {failed ? (
        <LoadError title={t("loadFailed")} hint={t("loadFailedHint")} action={<Button variant="outline" size="sm" onClick={() => void board.refetch()}>{t("retry")}</Button>} />
      ) : loading || !everything || !shown || !summary ? (
        <div className="space-y-3" aria-busy="true">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <>
          {running ? (
            <div data-testid="placement-running">
              <Notice tone="warning">{t("running")}</Notice>
            </div>
          ) : null}

          <SinceRunNote board={everything} jobs={jobsQuery.data} running={running} missing={missing} />

          <p role="status" className="text-sm" data-testid="placement-summary">
            {t("summary", { rows: summary.rows, left: summary.left })}
          </p>

          {summary.rows === 0 ? (
            <Notice title={t("noneTitle")}>{t("noneBody")}</Notice>
          ) : (
            <Notice tone="neutral">{t("beforeAfter")}</Notice>
          )}

          {summary.failing > 0 ? (
            <Notice tone="destructive" title={t("failingTitle", { count: summary.failing })} id="placement-failing">
              <p>{t("failingBody")}</p>
              {failingShown.length + failingBlockLessons.length > 0 ? (
                <ul className="mt-2 space-y-1.5">
                  {failingShown.map((row) => (
                    <li key={row.id} data-testid="failing-row">
                      <span className="font-medium">
                        {postName(postById.get(row.requirementId))}, {rowLine(row)}
                      </span>
                      {": "}
                      {verdictSentence(tPlacements, row.verdict.reason, row.verdict.params)}
                    </li>
                  ))}
                  {/* A lesson of a block is one line, the posts that fail for one sentence said together. */}
                  {failingBlockLessons.map(({ block, row }) => (
                    <li key={row.id} className="[overflow-wrap:anywhere]" data-testid="failing-row">
                      <span className="font-medium">
                        {block.name}, {blockRowLine(block, row)}
                      </span>
                      {": "}
                      {linesOf(block, row.verdicts).join(" ")}
                    </li>
                  ))}
                </ul>
              ) : null}
              {failingShown.length + failingBlockLessons.length < summary.failing ? (
                <p className="mt-2">{t("failingHidden", { count: summary.failing - failingShown.length - failingBlockLessons.length })}</p>
              ) : null}
            </Notice>
          ) : null}

          <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("filters")}>
            <FilterPicker
              sections={filterSections}
              value={[...filters.groups]}
              onChange={pick("groups")}
              label={tTimetable("filterGroup")}
              allLabel={tTimetable("allGroups")}
              countLabel={(count) => tTimetable("groupsSelected", { count })}
            />
            <FilterPicker
              sections={[{ options: teachers.map((teacher) => ({ id: teacher.id, name: `${teacher.firstName} ${teacher.lastName}` })) }]}
              value={[...filters.teachers]}
              onChange={pick("teachers")}
              label={tTimetable("filterTeacher")}
              allLabel={tTimetable("allTeachers")}
              countLabel={(count) => tTimetable("teachersSelected", { count })}
            />
            <FilterPicker
              sections={[{ options: (roomsQuery.data ?? []).map((room) => ({ id: room.id, name: room.name })) }]}
              value={[...filters.rooms]}
              onChange={pick("rooms")}
              label={tTimetable("filterRoom")}
              allLabel={tTimetable("allRooms")}
              countLabel={(count) => tTimetable("roomsSelected", { count })}
            />
            {isFiltered(filters) ? (
              <Button variant="ghost" size="sm" onClick={() => setFilters(NO_FILTERS)}>
                {t("clearFilters")}
              </Button>
            ) : null}
            <span data-writes="PLANERING" className="ml-auto inline-flex items-center gap-1.5" role="group" aria-label={t("history")}>
              <Button variant="outline" size="sm" disabled={(!history.canUndo && !held) || saving} onClick={() => void undoOrRedo("undo")}>
                <Undo2 className="mr-1 size-4" aria-hidden />
                {t("undo")}
              </Button>
              <Button variant="outline" size="sm" disabled={!history.canRedo || saving} onClick={() => void undoOrRedo("redo")}>
                <Redo2 className="mr-1 size-4" aria-hidden />
                {t("redo")}
              </Button>
            </span>
          </div>

          {message ? (
            message.tone === "problem" ? (
              <div data-testid="placement-message">
                {/* A block's name can be one long word: the message breaks inside it at 320 px rather than leave its box. */}
                <Notice tone="destructive">
                  <span className="[overflow-wrap:anywhere]">{message.text}</span>
                </Notice>
              </div>
            ) : null
          ) : null}
          <p role="status" aria-live="polite" className={cn("text-sm [overflow-wrap:anywhere]", message?.tone === "ok" ? "" : "sr-only")} data-testid="placement-status">
            {message?.tone === "ok" ? message.text : saving ? t("saving") : ""}
            {warned.said ? <span> {warned.said}</span> : null}
          </p>
          {linkGone ? (
            <p role="status" className="text-sm text-muted-foreground" data-testid="placement-link-gone">
              {tBlock("linkGone")}
            </p>
          ) : null}

          <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
            <div data-writes="PLANERING" className="lg:sticky lg:top-4 lg:w-72 lg:shrink-0">
              <SectionCard id="placement-to-lay" title={t("toLayTitle")} description={t("toLayDescription")}>
                <div className="max-h-72 overflow-y-auto pr-1 lg:max-h-[32rem]">
                  <BrickList
                    groups={[...brickGroups, ...blockBrickGroups]}
                    selected={selectedBrick?.key ?? brickKey}
                    onSelect={(key) => {
                      if (held) {
                        // The chosen brick stays the held half's; another is not chosen until the half is laid or let go.
                        const brick = brickByKey.get(key);
                        if (!brick || partKeyOfBrick(brick) !== held.partKey) setMessage({ tone: "problem", text: tPair("finishFirst") });
                        return;
                      }
                      setBrickKey((current) => (current === key ? null : key));
                    }}
                    onPull={pull}
                  />
                </div>
              </SectionCard>
            </div>

            <div className="min-w-0 flex-1">
              <SectionCard id="placement-week" title={t("weekTitle")} description={t("weekDescription")}>
                {yearWeeks.length > 0 ? (
                  <div className="mb-3">
                    <Suspense fallback={null}>
                      <WeekPicker weeks={yearWeeks} value={week} onChange={setWeek} />
                    </Suspense>
                  </div>
                ) : null}
                <LatestSwitch
                  on={showLatest}
                  onChange={setShowLatest}
                  picked={!keptFilterNeeded}
                  state={latest.isError ? "failed" : latest.data && weekTools ? "ready" : "loading"}
                  count={ghosts.length}
                />
                <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label={t("legend")}>
                  <li>{t("legendPlaced")}</li>
                  <li>{t("legendKept")}</li>
                  <li>{t("legendFailing")}</li>
                  {warned.legend ? <li>{warned.legend}</li> : null}
                  {ghosts.length > 0 ? <li>{tLatest("legend")}</li> : null}
                </ul>
                {selectedBrick && mayWrite && toolsHere ? (
                  <div data-writes="PLANERING" className="mb-3 space-y-2 rounded-md border p-3" data-testid="lay-row">
                    <h3 className="text-sm font-semibold">{t("layTitle")}</h3>
                    <p className="text-sm">{t("layChosen", { lesson: lessonOfBrick(selectedBrick) })}</p>
                    {postById.has(selectedBrick.postId) && canBePair(postById.get(selectedBrick.postId)!) ? (
                      <Suspense fallback={null}>
                        <PairFields
                          choice={held ? held.recurrence : weeksChoice}
                          onChoice={(choice) => pair?.choose(choice)}
                          held={pair?.heldText ?? null}
                          onRelease={() => pair?.release(tPair("released"))}
                          // Until the module that does the laying is here the choice waits: a pair chosen with nobody to lay it would lay nothing.
                          disabled={saving || !pair}
                        />
                      </Suspense>
                    ) : null}
                    <Suspense fallback={null}>
                      <PlaceFields
                        key={`${selectedBrick.key}:${held ? "second" : "first"}`}
                        focusKey={`${selectedBrick.key}:${held ? "second" : "first"}`}
                        submitLabel={pairWeeksOf(selectedBrick) === null ? t("lay") : held ? tPair("laySecond") : tPair("layFirst")}
                        requireRoom={pairWeeksOf(selectedBrick) !== null}
                        minutes={selectedBrick.minutes}
                        rooms={roomsList}
                        initial={{ ...firstSpot, roomId: held && pairWeeksOf(selectedBrick) !== null ? held.roomId : roomFor(selectedBrick) }}
                        refusal={refusal}
                        saving={saving}
                        onValueChange={setDraft}
                        sentenceOf={(value) => {
                          const mover = moverOfBrick(selectedBrick, value.roomId);
                          const drop = drag && mover ? drag.dropOf(mover, { dayOfWeek: value.dayOfWeek, startMinutes: value.startMinutes, endMinutes: value.startMinutes + selectedBrick.minutes }) : OK_DROP;
                          return { drop, text: sentenceOf(drop) };
                        }}
                        nextFree={(value) => {
                          const mover = moverOfBrick(selectedBrick, value.roomId);
                          return drag && mover ? drag.nextFreeSpot(mover, selectedBrick.minutes, value) : null;
                        }}
                        onSubmit={(value) => void layBrick(selectedBrick, { dayOfWeek: value.dayOfWeek, startMinutes: value.startMinutes }, value.roomId)}
                      />
                    </Suspense>
                    <Button variant="ghost" size="sm" onClick={() => setBrickKey(null)}>
                      {t("unchoose")}
                    </Button>
                  </div>
                ) : null}
                {selectedBlockBrick && mayWrite && toolsHere ? (
                  <div data-writes="PLANERING" className="mb-3 space-y-2 rounded-md border p-3" data-testid="lay-row">
                    <h3 className="text-sm font-semibold">{t("layTitle")}</h3>
                    <p className="text-sm [overflow-wrap:anywhere]">{t("layChosen", { lesson: lessonOfBlockBrick(selectedBlockBrick) })}</p>
                    <Suspense fallback={null}>
                      <BlockPlaceFields
                        key={selectedBlockBrick.key}
                        focusKey={selectedBlockBrick.key}
                        submitLabel={t("lay")}
                        minutes={selectedBlockBrick.minutes}
                        members={membersOf(blockById.get(selectedBlockBrick.blockId)!)}
                        rooms={roomsList}
                        initial={{ ...firstBlockSpot, rooms: Object.fromEntries(blockRoomsFor(blockById.get(selectedBlockBrick.blockId)!)) }}
                        refusal={refusal}
                        saving={saving}
                        onValueChange={setBlockDraft}
                        sentenceOf={(value) => {
                          const block = blockById.get(selectedBlockBrick.blockId)!;
                          const drop = drag
                            ? drag.dropOfBlock(drag.moverOfBlockBrick(selectedBlockBrick.key, block, postById, new Map(Object.entries(value.rooms))), { dayOfWeek: value.dayOfWeek, startMinutes: value.startMinutes, endMinutes: value.startMinutes + selectedBlockBrick.minutes })
                            : OK_DROP;
                          return { drop, text: blockSentenceOf(drop) };
                        }}
                        nextFree={(value) => {
                          const block = blockById.get(selectedBlockBrick.blockId)!;
                          return drag ? drag.nextFreeSpotOfBlock(drag.moverOfBlockBrick(selectedBlockBrick.key, block, postById, new Map(Object.entries(value.rooms))), selectedBlockBrick.minutes, value) : null;
                        }}
                        onSubmit={(value) => void placeBlock(selectedBlockBrick, { dayOfWeek: value.dayOfWeek, startMinutes: value.startMinutes }, new Map(Object.entries(value.rooms)))}
                      />
                    </Suspense>
                    <Button variant="ghost" size="sm" onClick={() => setBrickKey(null)}>
                      {t("unchoose")}
                    </Button>
                  </div>
                ) : null}
                {!mayWrite && cards.length === 0 && ghosts.length === 0 ? (
                  <p className="text-sm text-muted-foreground" data-testid="placement-week-empty">
                    {t("weekEmpty")}
                  </p>
                ) : (
                  <div>
                    {cards.length === 0 ? (
                      <p className="mb-2 text-sm text-muted-foreground" data-testid="placement-week-empty">
                        {t("weekEmpty")}
                      </p>
                    ) : null}
                    <TimetableGrid
                      ref={gridRef}
                      lessons={markedCards}
                      bands={allBands}
                      behind={ghosts.length > 0 && weekTools ? (day, scale) => <weekTools.GhostColumn ghosts={ghosts} day={day} scale={scale} /> : undefined}
                      dayEndMinutes={DAY_END_MINUTES}
                      dates={week && weekTools ? weekTools.datesOfWeek(week) : undefined}
                      editable={mayWrite}
                      onLessonClick={(lesson) => {
                        // The held half has no dialog: it is not written. Its fields are the row above the week.
                        if (held && lesson.id === heldHalfCardId(held.partKey)) return;
                        setMarkedBlockCard(null);
                        setOpenCard(lesson.id);
                      }}
                      selectedIds={selectedCards}
                      validateChange={validateChange}
                      // Let go outside the week: nothing is laid (the grid would otherwise take the last place it was over).
                      onDropOutside={() => undefined}
                      onLessonChange={handleChange}
                      onInvalidDrop={(id, to) => refuseDrop(id, to, !brickByKey.has(id) && !blockBrickByKey.has(id))}
                      onSlotClick={handleSlot}
                    />
                  </div>
                )}
                {keptFilterNeeded && everything.kept.length > 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground" data-testid="placement-kept-hidden">
                    {t("keptHidden", { count: everything.kept.length })}
                  </p>
                ) : null}
              </SectionCard>
            </div>
          </div>

          <SectionCard id="placement-posts" title={t("postsTitle")} description={t("postsDescription")}>
            {orderedPosts.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noPosts")}</p>
            ) : (
              <ul className="divide-y">
                {orderedPosts.map((post) => {
                  const total = totalsOf(post);
                  const rows = rowsByPost.get(post.id) ?? [];
                  return (
                    <li
                      key={post.id}
                      id={`post-${post.id}`}
                      tabIndex={-1}
                      className="scroll-mt-4 py-3 outline-none [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-ring"
                      data-testid="placement-post"
                    >
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <h3 className="min-w-0 break-words text-sm font-semibold">{postName(post)}</h3>
                        <span className="text-sm text-muted-foreground">{teacherText(post.teacherId)}</span>
                      </div>
                      <p className="text-sm">
                        {t("postFigures", { placed: total.placed, count: total.count, locked: total.locked, left: total.left })}
                      </p>
                      {post.cannotPlace ? (
                        <p className="text-sm text-muted-foreground">
                          {/* A post of a block is laid with its block: the block is named, not just "it is in a block". */}
                          {post.cannotPlace === "BLOCK" && blockOfPost.has(post.id) ? tBlock("memberOf", { block: blockOfPost.get(post.id)!.name }) : fitSentence(tPlacements, post.cannotPlace)}
                        </p>
                      ) : null}
                      {post.parts.length > 1 || post.parts.some((part) => part.cannotPlace) ? (
                        <ul className="mt-1 space-y-0.5 text-sm">
                          {post.parts.map((part) => (
                            <li key={`${part.teacherId ?? "none"}-${part.minutes}`}>
                              {t("part", {
                                teacher: teacherText(part.teacherId),
                                count: part.count,
                                minutes: part.minutes,
                                placed: part.placed,
                                locked: part.locked,
                                left: part.left,
                              })}
                              {part.cannotPlace ? ` ${fitSentence(tPlacements, part.cannotPlace)}` : ""}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      {rows.length > 0 ? (
                        <ul className="mt-2 space-y-1 text-sm">
                          {rows.map((row) => (
                            <li key={row.id} className={cn("break-words", !row.verdict.ok && "font-medium")} data-testid="placement-row">
                              {rowLine(row)}
                              {post.parts.length > 1 || post.teacherId !== teacherOfPlacement(row, post) ? ` · ${teacherText(teacherOfPlacement(row, post))}` : ""}
                              {" — "}
                              {row.verdict.ok ? t("holds") : verdictSentence(tPlacements, row.verdict.reason, row.verdict.params)}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      <WarningLines items={warned.ofRows(rows.map((row) => row.id))} />
                      {rows.length > 0 ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t("savedAt", { when: savedAt([...rows.map((row) => row.changedAt)].sort().at(-1)!, locale) })}
                          {post.startDate || post.endDate
                            ? ` · ${t("postWindow", {
                                from: post.startDate ? weekDay(post.startDate, locale) : t("windowFromStart"),
                                to: post.endDate ? weekDay(post.endDate, locale) : t("windowToEnd"),
                              })}`
                            : ""}
                        </p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </SectionCard>

          {/* Only a year that has parallel blocks has the list; a school with none (and a gateway that sends none) is not told "no blocks". */}
          {everything.blocks.length > 0 ? (
            <SectionCard id="placement-blocks" title={tBlock("sectionTitle")} description={tBlock("sectionDescription")}>
              {shownBlocks.length === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="placement-blocks-empty">
                  {tBlock("noBlocks")}
                </p>
              ) : (
                <ul className="divide-y">
                  {shownBlocks.map((block) => {
                    const whole = blockById.get(block.id) ?? block;
                    return (
                      <li
                        key={block.id}
                        id={`block-${block.id}`}
                        tabIndex={-1}
                        className="scroll-mt-4 py-3 outline-none [overflow-wrap:anywhere] focus-visible:ring-2 focus-visible:ring-ring"
                        data-testid="placement-block"
                      >
                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                          <h3 className="min-w-0 break-words text-sm font-semibold">{block.name}</h3>
                          <span className="min-w-0 break-words text-sm text-muted-foreground">{membersOf(block).map((member) => member.name).join(" · ")}</span>
                        </div>
                        <p className="text-sm">{tBlock("blockFigures", { placed: whole.rows.length, count: whole.lengths.length, left: blockLessonsLeft(whole) })}</p>
                        {block.cannotPlace ? (
                          <p className="text-sm text-muted-foreground">
                            {blockFitSentence(tBlockFit, block.cannotPlace, block.followsBlockId ? (blockById.get(block.followsBlockId)?.name ?? tBlockFit("otherBlock")) : tBlockFit("otherBlock"))}
                          </p>
                      ) : null}
                      {block.rows.length > 0 ? (
                        <ul className="mt-2 space-y-1 text-sm">
                          {block.rows.map((row) => (
                            <li key={row.id} className={cn("break-words", row.verdicts.some((verdict) => !verdict.ok) && "font-medium")} data-testid="placement-block-row">
                              {blockRowLine(block, row)}
                              {" — "}
                              {row.verdicts.some((verdict) => !verdict.ok) ? linesOf(block, row.verdicts).join(" ") : t("holds")}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                      <WarningLines items={warned.ofRows(block.rows.map((row) => row.id))} />
                      {block.rows.length > 0 ? (
                        <p className="mt-1 text-xs text-muted-foreground">{t("savedAt", { when: savedAt([...block.rows.map((row) => row.changedAt)].sort().at(-1)!, locale) })}</p>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </SectionCard>
          ) : null}

          {openCard && (openedRow || openedKept || openedLesson) ? (
            <Suspense fallback={null}>
              <CardDialog
                // One dialog per card: its fields start from the card as it stands.
                key={openCard}
                mayWrite={mayWrite && toolsHere && (openedRow !== undefined || openedLesson !== undefined)}
                placed={
                  openedRow && openedPost
                    ? {
                        key: openCard,
                        postId: openedPost.id,
                        title: `${postName(openedPost)} · ${teacherText(teacherOfPlacement(openedRow, openedPost))} · ${openedRow.minutes} min`,
                        line: rowLine(openedRow),
                        verdictText: openedRow.verdict.ok ? t("holds") : verdictSentence(tPlacements, openedRow.verdict.reason, openedRow.verdict.params),
                        savedAt: savedAt(openedRow.changedAt, locale),
                        warnings: warned.ofCard(openCard),
                        minutes: openedRow.minutes,
                        initial: { dayOfWeek: openedRow.dayOfWeek, startMinutes: minutesOfClock(openedRow.startTime), roomId: openedRow.roomId },
                        pair: (() => {
                          const rowsOfThePost = everything ? rowsOfPost(everything, openedPost.id) : [];
                          const doomed = removalOf(rowsOfThePost, openedPost, keys.get(openedRow.id) ?? "");
                          if (doomed.length < 2) return null;
                          const rowKeys = keysOfRows(rowsOfThePost);
                          const lines = rowsOfThePost.filter((_, index) => doomed.includes(rowKeys[index]!)).map(rowLine);
                          return t("pairConfirm", { lesson: postName(openedPost), rows: lines.join("; ") });
                        })(),
                      }
                    : undefined
                }
                block={
                  openedLesson
                    ? {
                        key: openedLesson.key,
                        blockId: openedLesson.block.id,
                        title: `${openedLesson.block.name} · ${openedLesson.row.minutes} min`,
                        line: blockRowLine(openedLesson.block, openedLesson.row),
                        verdictLines: openedLesson.row.verdicts.some((verdict) => !verdict.ok) ? linesOf(openedLesson.block, openedLesson.row.verdicts) : [t("holds")],
                        savedAt: savedAt(openedLesson.row.changedAt, locale),
                        warnings: warned.ofCard(openCard),
                        minutes: openedLesson.row.minutes,
                        initial: {
                          dayOfWeek: openedLesson.row.dayOfWeek,
                          startMinutes: minutesOfClock(openedLesson.row.startTime),
                          rooms: Object.fromEntries(openedLesson.row.rooms.map((room) => [room.requirementId, room.roomId])),
                        },
                        members: membersOf(openedLesson.block),
                      }
                    : undefined
                }
                kept={
                  openedKept
                    ? {
                        title: [names.subject(openedKept.subjectId)?.name, names.group(openedKept.studentGroupId)].filter(Boolean).join(" "),
                        line: `${tDays(String(openedKept.dayOfWeek))} ${openedKept.startTime}–${openedKept.endTime}`,
                        note: openedKept.locked ? t("keptLocked") : t("keptByHand"),
                      }
                    : undefined
                }
                fields={{
                  rooms: roomsList,
                  refusal,
                  saving,
                  sentenceOf: (value) => {
                    const mover = drag && openedRow && openedPost ? drag.moverOfRow(openCard, openedRow, openedPost) : null;
                    const drop =
                      drag && mover && openedRow
                        ? drag.dropOf({ ...mover, roomId: value.roomId }, { dayOfWeek: value.dayOfWeek, startMinutes: value.startMinutes, endMinutes: value.startMinutes + openedRow.minutes })
                        : OK_DROP;
                    return { drop, text: sentenceOf(drop) };
                  },
                  nextFree: (value) => {
                    const mover = drag && openedRow && openedPost ? drag.moverOfRow(openCard, openedRow, openedPost) : null;
                    return drag && mover && openedRow ? drag.nextFreeSpot({ ...mover, roomId: value.roomId }, openedRow.minutes, value) : null;
                  },
                }}
                blockFields={{
                  rooms: roomsList,
                  refusal,
                  saving,
                  sentenceOf: (value) => {
                    const drop =
                      drag && openedLesson
                        ? drag.dropOfBlock(
                            drag.moverOfBlockRow(openCard, openedLesson.key, openedLesson.block, openedLesson.row, postById, new Map(Object.entries(value.rooms))),
                            { dayOfWeek: value.dayOfWeek, startMinutes: value.startMinutes, endMinutes: value.startMinutes + openedLesson.row.minutes },
                          )
                        : OK_DROP;
                    return { drop, text: blockSentenceOf(drop) };
                  },
                  nextFree: (value) =>
                    drag && openedLesson
                      ? drag.nextFreeSpotOfBlock(drag.moverOfBlockRow(openCard, openedLesson.key, openedLesson.block, openedLesson.row, postById, new Map(Object.entries(value.rooms))), openedLesson.row.minutes, value)
                      : null,
                }}
                onSave={(value) => {
                  void move(openCard, { dayOfWeek: value.dayOfWeek, startMinutes: value.startMinutes }, value.roomId).then((done) => done && setOpenCard(null));
                }}
                onSaveBlock={(value) => {
                  void moveBlock(openCard, { dayOfWeek: value.dayOfWeek, startMinutes: value.startMinutes }, new Map(Object.entries(value.rooms))).then((done) => done && setOpenCard(null));
                }}
                onRemove={() => void (openedLesson ? removeBlockLesson(openCard) : remove(openCard))}
                onClose={() => setOpenCard(null)}
              />
            </Suspense>
          ) : null}
        </>
      )}
    </Page>
  );
}

const OK_DROP: Drop = { kind: "OK" };
