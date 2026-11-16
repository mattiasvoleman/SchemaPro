"use client";

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Redo2, Undo2 } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { Page } from "@/components/layout/page";
import { PageHeader } from "@/components/layout/page-header";
import { useProfile, useReadOnly } from "@/components/profile-context";
import { BrickList, type BrickGroup } from "@/components/placements/brick-list";
import { FilterPicker } from "@/components/schedule/filter-picker";
import { PlanningYearPicker, ProjectedRostersBanner } from "@/components/schedule/planning-year";
import { recurrenceBadge } from "@/components/schedule/recurrence-badge";
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
import { profileWrites } from "@/lib/admin-areas";
import { ApiError } from "@/lib/api";
import { usePlanningYear } from "@/lib/planning-year";
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
  summaryOf,
  teacherOfPlacement,
  totalsOf,
  visibleBoard,
  weekDay,
  type BoardFilters,
  type BoardPlacement,
  type BoardPost,
  type CardNames,
} from "@/lib/placement-board";
import { usePlacementBoard } from "@/lib/placement-board-queries";
import { dropOf, moverOfRow, nextFreeSpot, suggestedRoom, type Drop, type Mover, type OtherNames } from "@/lib/placement-drop";
import { buildMirror } from "@/lib/placement-mirror";
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
import { usePlacementEditor, writeProblemOf } from "@/lib/placement-write";
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
import { useHistoryKeyboard } from "@/lib/use-schedule-history";
import { cn, subjectColor } from "@/lib/utils";
import type { PlaceValue } from "@/components/placements/place-fields";

// What a brick chosen, or a card opened, needs and nothing else does: fetched when the first is pressed, not with the page.
const PlaceFields = lazy(() => import("@/components/placements/place-fields").then((module) => ({ default: module.PlaceFields })));
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
 */

/** "A. Ek". */
const shortName = (person: { firstName: string; lastName: string }): string => `${person.firstName[0] ?? ""}. ${person.lastName}`;

/** What the address may name: ?post=, the post to open on (the link in the Förlägg dialog). */
function postFromAddress(): string | null {
  return new URLSearchParams(window.location.search).get("post");
}

/** How long the gateway counts a PENDING or RUNNING run as running (the Generera page's own figure). */
const RUNNING_MS = 15 * 60 * 1000;

/** What a keyboard shortcut on a page that writes nothing does: nothing. */
const NO_HISTORY = { undo: async () => null, redo: async () => null };

export default function PlacementsPage() {
  const t = useTranslations("placementWeek");
  const tTimetable = useTranslations("timetable");
  const tPlacements = useTranslations("requirements.placements");
  const tDays = useTranslations("days");
  const locale = useLocale();
  const { profile } = useProfile();
  const readOnly = useReadOnly();
  // Planering's: the profiles that write a förläggning. What the others see is the week, read.
  const mayWrite = !readOnly && profileWrites(profile.adminProfile, "PLANERING");

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
  const [message, setMessage] = useState<{ tone: "ok" | "problem"; text: string } | null>(null);
  /** The gateway's sentence for the last row it refused, shown in the fields until they change. */
  const [refusal, setRefusal] = useState<string | null>(null);
  /** An element to move focus to once the week has been drawn with the change: a selector. */
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);
  const [focusPost, setFocusPost] = useState<string | null>(null);
  useEffect(() => setFocusPost(postFromAddress()), []);
  const gridRef = useRef<TimetableGridHandle>(null);

  const groups = useMemo(
    () => (groupsQuery.data ?? []).filter((group) => !year || group.academicYearId === year.id),
    [groupsQuery.data, year],
  );
  const groupById = useMemo(() => new Map((groupsQuery.data ?? []).map((group) => [group.id, group])), [groupsQuery.data]);
  const subjectById = useMemo(() => new Map((subjectsQuery.data ?? []).map((subject) => [subject.id, subject])), [subjectsQuery.data]);
  const roomById = useMemo(() => new Map((roomsQuery.data ?? []).map((room) => [room.id, room])), [roomsQuery.data]);
  const teachers = useMemo(() => (peopleQuery.data ?? []).filter((person) => person.role === "TEACHER"), [peopleQuery.data]);
  const teacherById = useMemo(() => new Map(teachers.map((teacher) => [teacher.id, teacher])), [teachers]);

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
      weeks: (lesson) => recurrenceBadge(lesson, tTimetable),
      color: (subjectId, color) => subjectColor(subjectId, color),
      keptNote: t("keptNote"),
    }),
    [subjectById, groupById, teacherById, roomById, tTimetable, tPlacements, t],
  );
  const otherNames: OtherNames = useMemo(
    () => ({ group: (id) => groupById.get(id)?.name, subject: (id) => subjectById.get(id)?.name }),
    [groupById, subjectById],
  );

  const everything = board.data;
  const shown = useMemo(() => (everything ? visibleBoard(everything, filters) : null), [everything, filters]);
  const postById = useMemo(() => new Map((everything?.posts ?? []).map((post) => [post.id, post])), [everything]);
  const summary = useMemo(() => (everything ? summaryOf(everything) : null), [everything]);
  // Every row of the year by key: a card is named by the lesson, and the keys are made over all of the rows so that a filter changes none.
  const keys = useMemo(() => keyByRowId(everything?.placements ?? []), [everything]);
  const rowByCard = useMemo(
    () => new Map((everything?.placements ?? []).map((row) => [placementCardId(keys.get(row.id) ?? row.id), row])),
    [everything, keys],
  );
  const keptById = useMemo(() => new Map((everything?.kept ?? []).map((lesson) => [keptCardId(lesson.id), lesson])), [everything]);

  // What the ghost and the arrow keys are held against; built when the week or a list changes, not at every pixel of a drag.
  const students = useMemo(
    () => new Map((peopleQuery.data ?? []).filter((person) => person.role === "STUDENT" && person.isActive).map((person) => [person.id, person.studentGroupId] as const)),
    [peopleQuery.data],
  );
  const mirror = useMemo(
    () =>
      mayWrite && everything
        ? buildMirror({
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
    [mayWrite, everything, keys, groupsQuery.data, students, membershipsQuery.data, constraintsQuery.data, framesQuery.data, year?.gradeNumbering, year?.id],
  );

  const keptFilterNeeded = !isFiltered(filters);
  const cards = useMemo(
    () =>
      shown
        ? [
            ...placementCards(shown.placements, postById, names, keys),
            // The lessons Generera keeps are the school's whole grundschema, on a school that built one by hand: drawn
            // for what is picked, not for everything (review of #315, LÅG-3).
            ...(keptFilterNeeded ? [] : keptCards(shown.kept, names)),
          ]
        : [],
    [shown, postById, names, keys, keptFilterNeeded],
  );
  const bands = useMemo(
    () => (shown ? mealBands(shown.meals, (meal) => t("meal", { group: groupById.get(meal.studentGroupId)?.name ?? "" })) : []),
    [shown, groupById, t],
  );

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

  // Att lägga: a brick per lesson still to lay, of the posts the filters show, grouped by post.
  const bricks = useMemo(() => (mayWrite ? bricksOf(orderedPosts) : []), [mayWrite, orderedPosts]);
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
  const selectedBrick = brickKey ? brickByKey.get(brickKey) : undefined;
  // A brick that is gone (it was the post's last) is a selection that ends.
  useEffect(() => {
    if (brickKey !== null && everything && !selectedBrick) setBrickKey(null);
  }, [brickKey, selectedBrick, everything]);
  // What the gateway refused belongs to the lesson it was said about.
  useEffect(() => setRefusal(null), [brickKey, openCard]);

  // The week is read again after a write (and when somebody else changes it); a key that is not the one our last write left ends the history.
  useEffect(() => {
    if (reconcile(everything)) setMessage({ tone: "problem", text: t("staleHistory") });
  }, [everything, reconcile, t]);
  useEffect(() => {
    history.clear();
    setBrickKey(null);
    setOpenCard(null);
    setMessage(null);
    // The history is one stack for the page, and a year has its own rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year?.id]);

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
  }, [pendingFocus, cards, brickGroups]);

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

  const roomsList = useMemo(() => (roomsQuery.data ?? []).map((room) => ({ id: room.id, name: room.name })), [roomsQuery.data]);
  const roomFor = useCallback(
    (brick: Brick): string | null => {
      const post = postById.get(brick.postId);
      if (!post) return null;
      return suggestedRoom({
        postRows: rowsOfPost(everything ?? { placements: [] }, post.id),
        rules: roomRulesQuery.data ?? [],
        subjectId: post.subjectId,
        gradeLevel: groupById.get(post.studentGroupId)?.gradeLevel ?? null,
        filterRooms: filters.rooms,
      });
    },
    [postById, everything, roomRulesQuery.data, groupById, filters.rooms],
  );
  const moverOfBrick = useCallback(
    (brick: Brick, roomId: string | null): Mover | null => {
      const post = postById.get(brick.postId);
      return post ? { id: brick.key, post, teacherId: brick.teacherId ?? post.teacherId, roomId, recurrence: post.recurrence } : null;
    },
    [postById],
  );

  /** One thing the gateway refused, or failed to do, said once and in place. */
  const problemFrom = useCallback(
    (error: unknown) => {
      const problem = writeProblemOf(error);
      if (problem === "STALE") {
        setMessage({ tone: "problem", text: t("stale") });
        void board.refetch();
        return;
      }
      if (problem === "BUSY") {
        setMessage({ tone: "problem", text: tPlacements("busy") });
        return;
      }
      const refused = placementsRefusal(error);
      if (refused) {
        const sentence = refused.kind === "ROW" ? verdictSentence(tPlacements, refused.reason, refused.params) : fitSentence(tPlacements, refused.reason);
        setRefusal(sentence);
        setMessage({ tone: "problem", text: t("cannotStandThere", { reason: sentence }) });
        return;
      }
      setMessage({ tone: "problem", text: `${t("notSaved")} ${error instanceof ApiError || error instanceof Error ? error.message : ""}`.trim() });
    },
    [board, t, tPlacements],
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
        setMessage({ tone: "ok", text: `${said} ${t("fromNextGenerate")}` });
        const target = focusOn(keysOfRows(result.answer.placements));
        if (target) setPendingFocus(target);
        return true;
      } catch (error) {
        problemFrom(error);
        return false;
      }
    },
    [saving, editor, board, problemFrom, t],
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

  // ---------------------------------------------------------------- the grid's side

  const validateChange = useCallback(
    (id: string, to: LessonChange): boolean => {
      if (!mirror) return true;
      const span = { dayOfWeek: to.dayOfWeek, startMinutes: to.startMinutes, endMinutes: to.endMinutes };
      const brick = brickByKey.get(id);
      if (brick) {
        const mover = moverOfBrick(brick, roomFor(brick));
        return mover !== null && dropOf(mirror, mover, span, otherNames).kind === "OK";
      }
      const row = rowByCard.get(id);
      const post = row ? postById.get(row.requirementId) : undefined;
      // A kept lesson is not moved here, and a placed lesson keeps its length: the post's.
      if (!row || !post || to.endMinutes - to.startMinutes !== row.minutes) return false;
      return dropOf(mirror, moverOfRow(id, row, post), span, otherNames).kind === "OK";
    },
    [mirror, brickByKey, moverOfBrick, roomFor, otherNames, rowByCard, postById],
  );

  /** Why a lesson cannot stand where it was let go or pointed to. */
  const refuseDrop = useCallback(
    (id: string, to: LessonChange, moving: boolean) => {
      let drop: Drop = { kind: "OK" };
      const span = { dayOfWeek: to.dayOfWeek, startMinutes: to.startMinutes, endMinutes: to.endMinutes };
      const brick = brickByKey.get(id);
      const row = rowByCard.get(id);
      const post = row ? postById.get(row.requirementId) : undefined;
      if (!brick && !row) drop = { kind: "KEPT" };
      else if (row && to.endMinutes - to.startMinutes !== row.minutes) drop = { kind: "LENGTH" };
      else if (mirror) {
        const mover = brick ? moverOfBrick(brick, roomFor(brick)) : row && post ? moverOfRow(id, row, post) : null;
        if (mover) drop = dropOf(mirror, mover, span, otherNames);
      }
      setMessage({ tone: "problem", text: t(moving ? "cannotMoveThere" : "cannotStandThere", { reason: sentenceOf(drop) }) });
    },
    [brickByKey, rowByCard, postById, mirror, moverOfBrick, roomFor, otherNames, sentenceOf, t],
  );

  const handleChange = useCallback(
    (id: string, to: LessonChange) => {
      const brick = brickByKey.get(id);
      if (brick) {
        // Pulled in from Att lägga: the room is the one the fields hold when this brick is the chosen one, else the suggestion.
        void place(brick, { dayOfWeek: to.dayOfWeek, startMinutes: to.startMinutes }, brickKey === brick.key && draft ? draft.roomId : roomFor(brick));
        return;
      }
      if (rowByCard.has(id)) void move(id, { dayOfWeek: to.dayOfWeek, startMinutes: to.startMinutes });
    },
    [brickByKey, brickKey, draft, roomFor, place, rowByCard, move],
  );

  const handleSlot = useCallback(
    (day: number, minute: number) => {
      if (!mayWrite || !selectedBrick) return;
      const span = { dayOfWeek: day, startMinutes: minute, endMinutes: minute + selectedBrick.minutes };
      const room = draft ? draft.roomId : roomFor(selectedBrick);
      if (mirror) {
        const mover = moverOfBrick(selectedBrick, room);
        const drop = mover ? dropOf(mirror, mover, span, otherNames) : OK_DROP;
        // The mirror may be stricter than the gateway, and is asked for what it knows; the gateway answers the press either way.
        if (drop.kind === "DAY") return void setMessage({ tone: "problem", text: t("cannotStandThere", { reason: sentenceOf(drop) }) });
      }
      void place(selectedBrick, { dayOfWeek: day, startMinutes: minute }, room);
    },
    [mayWrite, selectedBrick, draft, roomFor, mirror, moverOfBrick, otherNames, place, sentenceOf, t],
  );

  const pull = useCallback(
    (key: string, event: React.PointerEvent) => {
      const brick = brickByKey.get(key);
      const post = brick ? postById.get(brick.postId) : undefined;
      if (!brick || !post) return;
      event.preventDefault();
      gridRef.current?.beginExternalDrag(
        {
          id: brick.key,
          dayOfWeek: 1,
          startMinutes: 8 * 60,
          endMinutes: 8 * 60 + brick.minutes,
          title: names.subject(post.subjectId)?.name ?? "",
          subtitle: [names.group(post.studentGroupId), names.teacher(brick.teacherId)].filter(Boolean).join(" · "),
          color: names.color(post.subjectId, names.subject(post.subjectId)?.color),
        },
        { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY },
      );
    },
    [brickByKey, postById, names],
  );

  const openedRow = openCard ? rowByCard.get(openCard) : undefined;
  const openedKept = openCard ? keptById.get(openCard) : undefined;
  const openedPost = openedRow ? postById.get(openedRow.requirementId) : undefined;
  // A card that is gone (somebody else removed it, a save gave it another place) is a dialog that closes.
  useEffect(() => {
    if (openCard !== null && everything && !openedRow && !openedKept) setOpenCard(null);
  }, [openCard, everything, openedRow, openedKept]);

  /** Where the fields of a chosen brick start: the first time the week is free for it, else Monday 08:00. */
  const firstSpotOf = (brick: Brick): Spot => {
    const mover = moverOfBrick(brick, roomFor(brick));
    const start = { dayOfWeek: 1, startMinutes: 8 * 60 };
    // From a quarter before the day: the first time the search offers is Monday 08:00 itself when it is free.
    return (mirror && mover && nextFreeSpot(mirror, mover, brick.minutes, { dayOfWeek: 1, startMinutes: start.startMinutes - 15 }, otherNames)) || start;
  };

  const lessonOfBrick = (brick: Brick | undefined): string =>
    brick ? t("brickLabel", { lesson: postName(postById.get(brick.postId)), teacher: teacherText(brick.teacherId), minutes: brick.minutes }) : "";

  const undoOrRedo = useCallback(
    async (kind: "undo" | "redo") => {
      if (saving) return void setMessage({ tone: "ok", text: t("waitSaving") });
      try {
        const step = await (kind === "undo" ? history.undo() : history.redo());
        if (!step) return;
        setMessage({ tone: "ok", text: `${t(kind === "undo" ? "undone" : "redone", { what: t(step.label === "place" ? "stepPlace" : step.label === "move" ? "stepMove" : "stepRemove") })} ${t("fromNextGenerate")}` });
      } catch (error) {
        // A step on a post somebody else has changed is refused; the history is no longer ours, and the week is read again.
        if (writeProblemOf(error) === "STALE") history.clear();
        problemFrom(error);
      }
    },
    [saving, history, problemFrom, t],
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
              {failingShown.length > 0 ? (
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
                </ul>
              ) : null}
              {failingShown.length < summary.failing ? <p className="mt-2">{t("failingHidden", { count: summary.failing - failingShown.length })}</p> : null}
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
              <Button variant="outline" size="sm" disabled={!history.canUndo || saving} onClick={() => void undoOrRedo("undo")}>
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
                <Notice tone="destructive">{message.text}</Notice>
              </div>
            ) : null
          ) : null}
          <p role="status" aria-live="polite" className={cn("text-sm", message?.tone === "ok" ? "" : "sr-only")} data-testid="placement-status">
            {message?.tone === "ok" ? message.text : saving ? t("saving") : ""}
          </p>

          <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
            <div data-writes="PLANERING" className="lg:sticky lg:top-4 lg:w-72 lg:shrink-0">
              <SectionCard id="placement-to-lay" title={t("toLayTitle")} description={t("toLayDescription")}>
                <div className="max-h-72 overflow-y-auto pr-1 lg:max-h-[32rem]">
                  <BrickList groups={brickGroups} selected={brickKey} onSelect={(key) => setBrickKey((current) => (current === key ? null : key))} onPull={pull} />
                </div>
              </SectionCard>
            </div>

            <div className="min-w-0 flex-1">
              <SectionCard id="placement-week" title={t("weekTitle")} description={t("weekDescription")}>
                <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label={t("legend")}>
                  <li>{t("legendPlaced")}</li>
                  <li>{t("legendKept")}</li>
                  <li>{t("legendFailing")}</li>
                </ul>
                {selectedBrick && mayWrite ? (
                  <div data-writes="PLANERING" className="mb-3 space-y-2 rounded-md border p-3" data-testid="lay-row">
                    <h3 className="text-sm font-semibold">{t("layTitle")}</h3>
                    <p className="text-sm">{t("layChosen", { lesson: lessonOfBrick(selectedBrick) })}</p>
                    <Suspense fallback={null}>
                      <PlaceFields
                        key={selectedBrick.key}
                        focusKey={selectedBrick.key}
                        submitLabel={t("lay")}
                        minutes={selectedBrick.minutes}
                        rooms={roomsList}
                        initial={{ ...firstSpotOf(selectedBrick), roomId: roomFor(selectedBrick) }}
                        refusal={refusal}
                        saving={saving}
                        onValueChange={setDraft}
                        sentenceOf={(value) => {
                          const mover = moverOfBrick(selectedBrick, value.roomId);
                          const drop = mirror && mover ? dropOf(mirror, mover, { dayOfWeek: value.dayOfWeek, startMinutes: value.startMinutes, endMinutes: value.startMinutes + selectedBrick.minutes }, otherNames) : OK_DROP;
                          return { drop, text: sentenceOf(drop) };
                        }}
                        nextFree={(value) => {
                          const mover = moverOfBrick(selectedBrick, value.roomId);
                          return mirror && mover ? nextFreeSpot(mirror, mover, selectedBrick.minutes, value, otherNames) : null;
                        }}
                        onSubmit={(value) => void place(selectedBrick, { dayOfWeek: value.dayOfWeek, startMinutes: value.startMinutes }, value.roomId)}
                      />
                    </Suspense>
                    <Button variant="ghost" size="sm" onClick={() => setBrickKey(null)}>
                      {t("unchoose")}
                    </Button>
                  </div>
                ) : null}
                {!mayWrite && cards.length === 0 ? (
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
                      lessons={cards}
                      bands={bands}
                      dayEndMinutes={DAY_END_MINUTES}
                      editable={mayWrite}
                      onLessonClick={(lesson) => setOpenCard(lesson.id)}
                      selectedIds={openCard ? new Set([openCard]) : undefined}
                      validateChange={validateChange}
                      // Let go outside the week: nothing is laid (the grid would otherwise take the last place it was over).
                      onDropOutside={() => undefined}
                      onLessonChange={handleChange}
                      onInvalidDrop={(id, to) => refuseDrop(id, to, !brickByKey.has(id))}
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
                      className="scroll-mt-4 py-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      data-testid="placement-post"
                    >
                      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                        <h3 className="min-w-0 break-words text-sm font-semibold">{postName(post)}</h3>
                        <span className="text-sm text-muted-foreground">{teacherText(post.teacherId)}</span>
                      </div>
                      <p className="text-sm">
                        {t("postFigures", { placed: total.placed, count: total.count, locked: total.locked, left: total.left })}
                      </p>
                      {post.cannotPlace ? <p className="text-sm text-muted-foreground">{fitSentence(tPlacements, post.cannotPlace)}</p> : null}
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

          {openCard && (openedRow || openedKept) ? (
            <Suspense fallback={null}>
              <CardDialog
                // One dialog per card: its fields start from the card as it stands.
                key={openCard}
                mayWrite={mayWrite && openedRow !== undefined}
                placed={
                  openedRow && openedPost
                    ? {
                        key: openCard,
                        title: `${postName(openedPost)} · ${teacherText(teacherOfPlacement(openedRow, openedPost))} · ${openedRow.minutes} min`,
                        line: rowLine(openedRow),
                        verdictText: openedRow.verdict.ok ? t("holds") : verdictSentence(tPlacements, openedRow.verdict.reason, openedRow.verdict.params),
                        savedAt: savedAt(openedRow.changedAt, locale),
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
                    const mover = openedRow && openedPost ? moverOfRow(openCard, openedRow, openedPost) : null;
                    const drop =
                      mirror && mover && openedRow
                        ? dropOf(mirror, { ...mover, roomId: value.roomId }, { dayOfWeek: value.dayOfWeek, startMinutes: value.startMinutes, endMinutes: value.startMinutes + openedRow.minutes }, otherNames)
                        : OK_DROP;
                    return { drop, text: sentenceOf(drop) };
                  },
                  nextFree: (value) => {
                    const mover = openedRow && openedPost ? moverOfRow(openCard, openedRow, openedPost) : null;
                    return mirror && mover && openedRow ? nextFreeSpot(mirror, { ...mover, roomId: value.roomId }, openedRow.minutes, value, otherNames) : null;
                  },
                }}
                onSave={(value) => {
                  void move(openCard, { dayOfWeek: value.dayOfWeek, startMinutes: value.startMinutes }, value.roomId).then((done) => done && setOpenCard(null));
                }}
                onRemove={() => void remove(openCard)}
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
