"use client";

import { useEffect, useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Plus, X } from "lucide-react";
import { ApiError } from "@/lib/api";
import {
  blockCannotPlace,
  blockFitSentence,
  blockPlacementsKey,
  blockPlacementsRefusal,
  fetchPlacementsOfBlock,
  invalidateBlockPlacements,
  partsOfLengths,
  saveBlockPlacements,
  type BlockPlacementInput,
  type BlockVerdict,
} from "@/lib/block-placements";
import { useRooms } from "@/lib/queries";
import type { PlacementRecurrence } from "@/lib/requirement-placements";
import {
  PLACEMENT_DAY_END,
  PLACEMENT_DAY_START,
  PLACEMENT_GRID_MINUTES,
  clockOfMinutes,
  minutesOfClock,
  verdictSentence,
} from "@/lib/requirement-placement-text";
import { sortByName } from "@/lib/sorting";
import type { TeachingBlock, TeachingRequirement } from "@/lib/types";
import { useLengthsInWords } from "@/components/timplan/use-lengths-in-words";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { labelClassName } from "@/components/ui/label-style";
import { NativeSelect } from "@/components/ui/native-select";
import { Notice } from "@/components/ui/notice";

/*
 * Förlägg blocket: ONE lesson of a parallel block that the school already knows
 * has to stand at a day and a start, given before Generera lays the rest of the
 * week around it. Every post of the block sits the lesson, so the dialog asks
 * for the day, the start and the length once, and then, for each post, a room of
 * its own or none.
 *
 * HELD BY teaching-blocks.tsx, which the timplan page fetches on the first press
 * of "Block": the dialog is part of that chunk, and /admin/requirements does not
 * carry it. The reads, the write and the way a 409 is read are in
 * lib/block-placements.ts, apart from the module the page imports for the marks
 * of the posts (requirement-placements.ts), which has no bytes to spare.
 *
 * It decides nothing. The gateway judges the lessons of every post by the rule a
 * hand edit of the timetable is judged by, and this shows the verdict it was
 * given: when the dialog opens (a lesson can stop holding after a teacher was
 * changed or a lesson was locked beside it), and again, lesson by lesson and
 * post by post, when a save is refused. What the dialog does know is the block's
 * shape, because it offers only what can be saved: the block's lengths, no more
 * lessons of a length than the block has, and the block's weeks, which it only
 * says (the gateway sets them).
 *
 * THE ROOM IS OPTIONAL, PER POST. Its empty choice is "Motorn väljer sal": the
 * post is sent with no room and the engine chooses it at every Generera, so it
 * can be another room next time; a post with a room has it every time. Several
 * posts of one lesson may not name one room (they sit the lesson at once), and
 * the gateway refuses a lesson that makes it so, at the post it clashes with.
 *
 * A BLOCK THAT CANNOT BE PLACED says so where the lessons would be, instead of
 * refusing a save: one that takes another block's times (it follows the lessons
 * of the block it follows), one with no post, and one whose post shares its
 * lessons between teachers. A lesson stored before the block became one of them
 * is listed, and can be removed: that is the one save such a block takes.
 */

interface LessonDraft {
  /** Stable across removals, so an error stays on the lesson it was said of. */
  key: number;
  day: string;
  start: string;
  minutes: string;
  /** The block's weeks as stored; a lesson added here has the posts' own. */
  recurrence: PlacementRecurrence;
  /** The room each post chose by the post's id; a post with no entry (or "") has its room chosen by the engine. */
  rooms: Record<string, string>;
  /** A stored room's name by post, for a room the list no longer offers. */
  roomNames: Record<string, string>;
  /** The gateway's verdicts on the lesson as stored, only those that do not hold; gone as soon as the lesson is changed. */
  verdicts: BlockVerdict[];
}

interface FieldErrors {
  start?: string;
}

/** A sentence said of one lesson, by the posts it is said of ("Tyska för Ty7 och Franska för Fr7: …"). */
type LessonLine = { posts: string[]; text: string };

export interface BlockPlacementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The block being placed; null while nothing is. */
  block: TeachingBlock | null;
  /** The block's posts, in the order the page lists them. */
  members: readonly TeachingRequirement[];
  /** What a post is called ("Tyska för Ty7"), as the page names it. */
  label: (requirement: TeachingRequirement) => string;
  /** The block this one takes the times of, by name, for the sentence that points at it. */
  followedName?: string | null;
}

const DAYS = [1, 2, 3, 4, 5] as const;

export function BlockPlacementDialog({ open, onOpenChange, block, members, label, followedName }: BlockPlacementDialogProps) {
  const t = useTranslations("requirements.blockPlacements");
  const client = useQueryClient();
  // Bumped to read the block again from the start, after a save that found the block changed.
  const [reads, setReads] = useState(0);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The dialog is a grid, and a grid's one column is as wide as its widest word unless it may be narrower: a name of one long word
            would widen the whole dialog past the screen at 320 px, whatever the words below it are allowed to do. */}
      <DialogContent className="grid-cols-[minmax(0,1fr)] sm:max-w-2xl">
        <DialogHeader>
          {/* A block's name can be one long word (a compound, a code): it breaks inside the word at 320 px rather than leave the dialog. */}
          <DialogTitle className="break-words">{t("title", { block: block?.name ?? "" })}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {block ? (
          <BlockPlacementForm
            // A fresh form per block, and per read, so nothing of the last one is left in it.
            key={`${block.id}:${reads}`}
            block={block}
            members={members}
            label={label}
            followedName={followedName ?? null}
            onClose={() => onOpenChange(false)}
            onReload={() => {
              client.removeQueries({ queryKey: blockPlacementsKey(block.id) });
              setReads((count) => count + 1);
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function BlockPlacementForm({
  block,
  members,
  label,
  followedName,
  onClose,
  onReload,
}: {
  block: TeachingBlock;
  members: readonly TeachingRequirement[];
  label: (requirement: TeachingRequirement) => string;
  followedName: string | null;
  onClose: () => void;
  onReload: () => void;
}) {
  const t = useTranslations("requirements.blockPlacements");
  // The words of the single post's dialog that a block says in the same way: the day, the time, the weeks, and why a lesson stands wrong.
  const tp = useTranslations("requirements.placements");
  const tDays = useTranslations("days");
  const tCommon = useTranslations("common");
  const locale = useLocale();
  const lengthsInWords = useLengthsInWords();
  const client = useQueryClient();
  const uid = useId();
  const { data: roomRows, isError: roomsFailed } = useRooms();
  const rooms = sortByName(roomRows ?? [], (room) => room.name);

  const cannot = blockCannotPlace(block, members);
  const read = useQuery({
    queryKey: blockPlacementsKey(block.id),
    queryFn: () => fetchPlacementsOfBlock(block.id),
    // The lessons are copied into the form once and then edited; a refetch on focus must not be able to write over a half-made change.
    refetchOnWindowFocus: false,
    gcTime: 0,
  });

  const [rows, setRows] = useState<LessonDraft[] | null>(null);
  const [nextKey, setNextKey] = useState(1);
  /** A lesson the gateway refused on save, by its key, and what it said. */
  const [refused, setRefused] = useState<{ key: number; line: LessonLine } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<number, FieldErrors>>({});
  /** The lessons do not fit the block, the block has changed, or the base timetable is being written. */
  const [topError, setTopError] = useState<{ text: string; stale: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);

  const memberById = new Map(members.map((member) => [member.id, member]));
  const nameOfPost = (requirementId: string) => {
    const member = memberById.get(requirementId);
    return member ? label(member) : t("postGone");
  };
  const listOf = (names: string[]) => new Intl.ListFormat(locale, { type: "conjunction" }).format(names);
  const followed = followedName ?? t("otherBlock");

  useEffect(() => {
    if (rows !== null || !read.data) return;
    const stored = read.data;
    const roomOfStored = (index: number) => {
      const placement = stored.placements[index]!;
      const here = placement.rooms.filter((room) => memberById.has(room.requirementId));
      return {
        rooms: Object.fromEntries(here.map((room) => [room.requirementId, room.roomId])),
        roomNames: Object.fromEntries(here.map((room) => [room.requirementId, room.roomName])),
      };
    };
    setRows(
      stored.placements.map((placement, index) => ({
        key: index + 1,
        day: String(placement.dayOfWeek),
        start: placement.startTime,
        minutes: String(placement.minutes),
        recurrence: placement.recurrence,
        ...roomOfStored(index),
        verdicts: stored.verdicts.filter((verdict) => verdict.index === index && !verdict.ok),
      })),
    );
    setNextKey(stored.placements.length + 1);
    // The dialog opens before its lessons are read, and what Radix focuses then is the footer: the keyboard starts at the first
    // lesson's first field once it is drawn, or at the button that adds one.
    if (cannot === null) setFocusId(stored.placements.length > 0 ? `${uid}-day-1` : `${uid}-add`);
    // `memberById` is rebuilt every render; the rows are copied from the read once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [read.data, rows]);

  // Focus follows the first thing that went wrong, once it is drawn.
  useEffect(() => {
    if (focusId === null) return;
    document.getElementById(focusId)?.focus();
    setFocusId(null);
  }, [focusId]);

  const id = (part: string, key: number | string) => `${uid}-${part}-${key}`;
  const topId = `${uid}-top`;
  const addId = `${uid}-add`;
  const roomsHintId = `${uid}-rooms-hint`;

  const list = rows ?? [];
  const lengths = read.data?.lengths ?? [];
  const parts = partsOfLengths(lengths);
  const mixed = parts.length > 1;
  // The first lesson the block still has to place: of the first length that has one left.
  const openPart = parts.find((part) => list.filter((row) => Number(row.minutes) === part.minutes).length < part.count);
  const canAdd = cannot === null && openPart !== undefined;
  const storedCount = read.data?.placements.length ?? 0;
  const stale = list.filter((row) => row.verdicts.length > 0).length;
  // A block that cannot be placed takes one save: the lessons stored before it became so, all removed.
  const canSave = rows !== null && (cannot === null || (list.length === 0 && storedCount > 0));
  const weeksOf = (weeks: PlacementRecurrence) =>
    weeks === "ODD_WEEKS" ? tp("weeksOdd") : weeks === "EVEN_WEEKS" ? tp("weeksEven") : tp("weeksAll");
  const blockWeeks = members[0]?.recurrence ?? "ALL_WEEKS";

  const update = (key: number, patch: Partial<LessonDraft>) => {
    setRows((current) => (current ?? []).map((row) => (row.key === key ? { ...row, ...patch, verdicts: [] } : row)));
    setRefused((current) => (current?.key === key ? null : current));
    setFieldErrors((current) => {
      if (!current[key]) return current;
      const { [key]: _gone, ...rest } = current;
      return rest;
    });
  };

  const chooseRoom = (row: LessonDraft, requirementId: string, roomId: string) =>
    update(row.key, { rooms: { ...row.rooms, [requirementId]: roomId } });

  const add = () => {
    const row: LessonDraft = {
      key: nextKey,
      day: "1",
      start: "",
      minutes: String(openPart!.minutes),
      recurrence: blockWeeks,
      rooms: {},
      roomNames: {},
      verdicts: [],
    };
    setNextKey(nextKey + 1);
    setRows([...list, row]);
    setFocusId(id("day", nextKey));
  };

  const remove = (key: number) => {
    setRows(list.filter((row) => row.key !== key));
    setRefused((current) => (current?.key === key ? null : current));
    setFocusId(addId);
  };

  const startProblem = (row: LessonDraft): string | undefined => {
    const start = minutesOfClock(row.start);
    const end = start + Number(row.minutes);
    return Number.isFinite(start) &&
      start % PLACEMENT_GRID_MINUTES === 0 &&
      start >= PLACEMENT_DAY_START &&
      end <= PLACEMENT_DAY_END
      ? undefined
      : tp("problemStart", { from: clockOfMinutes(PLACEMENT_DAY_START), to: clockOfMinutes(PLACEMENT_DAY_END) });
  };

  /** The lines a lesson's verdicts say, the posts with the same sentence said together, in the order the posts have in the dialog. */
  const linesOf = (verdicts: readonly BlockVerdict[]): LessonLine[] => {
    const byText = new Map<string, string[]>();
    const place = (requirementId: string) => members.findIndex((member) => member.id === requirementId);
    const inOrder = [...verdicts].sort(
      (a, b) => (place(a.requirementId) + 1 || Infinity) - (place(b.requirementId) + 1 || Infinity),
    );
    for (const verdict of inOrder) {
      const text = verdictSentence(tp, verdict.reason, verdict.params);
      byText.set(text, [...(byText.get(text) ?? []), nameOfPost(verdict.requirementId)]);
    }
    return [...byText].map(([text, posts]) => ({ posts, text }));
  };
  const lineText = (line: LessonLine) => t("postSaid", { posts: listOf(line.posts), sentence: line.text });

  const submit = async () => {
    setTopError(null);
    setRefused(null);
    // What the gateway would only refuse with a 400 it cannot word, said first.
    const errors: Record<number, FieldErrors> = {};
    let first: string | null = null;
    for (const row of list) {
      const start = startProblem(row);
      if (start) {
        errors[row.key] = { start };
        first ??= id("start", row.key);
      }
    }
    setFieldErrors(errors);
    if (first) {
      setFocusId(first);
      return;
    }

    const body: BlockPlacementInput[] = list.map((row) => ({
      dayOfWeek: Number(row.day),
      startTime: row.start,
      minutes: Number(row.minutes),
      // Only the posts that chose a room: a post left out has its room chosen by the engine at every Generera.
      rooms: members.flatMap((member) => (row.rooms[member.id] ? [{ requirementId: member.id, roomId: row.rooms[member.id]! }] : [])),
    }));
    setSaving(true);
    try {
      await saveBlockPlacements(block.id, body, read.data!.rowsKey);
      void invalidateBlockPlacements(client);
      toast.success(t("saved"));
      onClose();
    } catch (error) {
      const refusal = blockPlacementsRefusal(error);
      if (refusal?.kind === "ROW") {
        const row = list[refusal.index];
        const line: LessonLine = {
          posts: [nameOfPost(refusal.requirementId)],
          text: verdictSentence(tp, refusal.reason, refusal.params),
        };
        if (row) {
          setRefused({ key: row.key, line });
          setFocusId(id("day", row.key));
        } else {
          setTopError({ text: lineText(line), stale: false });
          setFocusId(topId);
        }
      } else if (refusal?.kind === "FIT") {
        const sentence = blockFitSentence(t, refusal.reason, followed);
        const row = refusal.index === null ? undefined : list[refusal.index];
        if (row) {
          setRefused({ key: row.key, line: { posts: [], text: sentence } });
          setFocusId(id(refusal.reason === "LENGTH" && mixed ? "length" : "day", row.key));
        } else {
          setTopError({ text: sentence, stale: false });
          setFocusId(topId);
        }
      } else if (refusal?.kind === "STALE") {
        setTopError({ text: t("staleBody"), stale: true });
        setFocusId(topId);
      } else if (error instanceof ApiError && error.code === "SCHEDULE_BUSY") {
        setTopError({ text: tp("busy"), stale: false });
        setFocusId(topId);
      } else {
        setTopError({ text: error instanceof Error ? error.message : tCommon("error"), stale: false });
        setFocusId(topId);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div
        id={topId}
        tabIndex={-1}
        className="outline-none focus-visible:ring-2 focus-visible:ring-ring"
        // Said out loud when it appears: a save that went wrong is not on the field the reader is in.
        hidden={topError === null}
      >
        {topError !== null ? (
          <Notice
            tone="destructive"
            title={topError.stale ? t("staleTitle") : tp("notSaved")}
            action={
              topError.stale ? (
                <Button type="button" variant="outline" size="sm" onClick={onReload}>
                  {t("reload")}
                </Button>
              ) : undefined
            }
          >
            {topError.text}
          </Notice>
        ) : null}
      </div>

      {read.isError ? (
        <Notice tone="destructive">{t("loadFailed")}</Notice>
      ) : rows === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          {tp("loading")}
        </p>
      ) : (
        <fieldset disabled={saving} className="min-w-0 space-y-4">
          {cannot !== null ? <Notice role={null}>{blockFitSentence(t, cannot, followed)}</Notice> : null}
          {stale > 0 ? (
            <Notice tone="warning" title={tp("staleTitle", { count: stale })}>
              {tp("staleBody", { count: stale })}
            </Notice>
          ) : null}
          {roomsFailed ? <Notice tone="destructive">{tp("roomsFailed")}</Notice> : null}

          {cannot === null ? (
            // Said as the lessons change, so a reader hears how many of the block's lessons are left.
            <p aria-live="polite" className="text-sm">
              {t("summary", { lessons: lengthsInWords(parts), placed: list.length, count: lengths.length })}
            </p>
          ) : null}
          {cannot === null ? (
            <p id={roomsHintId} className="text-xs text-muted-foreground">
              {t("roomsHint")}
            </p>
          ) : null}

          {list.length === 0 && cannot === null ? <p className="text-sm text-muted-foreground">{t("empty")}</p> : null}

          {list.map((row, index) => {
            const errors = fieldErrors[row.key] ?? {};
            const lines = refused?.key === row.key ? [refused.line] : linesOf(row.verdicts);
            const rowErrorId = id("error", row.key);
            const lessonErrorText = lines.map((line) => (line.posts.length > 0 ? lineText(line) : line.text));
            const end = Number.isFinite(minutesOfClock(row.start))
              ? clockOfMinutes(minutesOfClock(row.start) + Number(row.minutes))
              : null;
            // A block that cannot be placed lists what was stored, to be removed and not changed: the fields are shown, and shut.
            const frozen = cannot !== null;
            return (
              <fieldset
                key={row.key}
                // A fieldset is as wide as its longest word unless told it may be narrower (min-width: min-content in the browser's own
                // style): min-w-0 lets a name of one long word break at the lesson's edge instead of widening the lesson past the dialog.
                className="min-w-0 space-y-3 rounded-md border p-3 [&_label]:break-words"
                aria-describedby={lessonErrorText.length > 0 ? rowErrorId : undefined}
              >
                <legend className="px-1 text-sm font-medium">{tp("rowTitle", { n: index + 1 })}</legend>
                <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
                  <div className="space-y-1.5">
                    <Label htmlFor={id("day", row.key)}>{tp("day")}</Label>
                    <NativeSelect
                      id={id("day", row.key)}
                      value={row.day}
                      disabled={frozen}
                      aria-invalid={lessonErrorText.length > 0 ? true : undefined}
                      aria-describedby={lessonErrorText.length > 0 ? rowErrorId : undefined}
                      onChange={(event) => update(row.key, { day: event.target.value })}
                    >
                      {DAYS.map((day) => (
                        <option key={day} value={day}>
                          {tDays(String(day))}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                  <FormField
                    id={id("start", row.key)}
                    label={tp("start")}
                    hint={end ? tp("ends", { end }) : undefined}
                    error={errors.start}
                  >
                    <Input
                      type="time"
                      step={300}
                      min={clockOfMinutes(PLACEMENT_DAY_START)}
                      max={clockOfMinutes(PLACEMENT_DAY_END - PLACEMENT_GRID_MINUTES)}
                      value={row.start}
                      disabled={frozen}
                      onChange={(event) => update(row.key, { start: event.target.value })}
                    />
                  </FormField>
                  {mixed ? (
                    <div className="space-y-1.5">
                      <Label htmlFor={id("length", row.key)}>{tp("length")}</Label>
                      <NativeSelect
                        id={id("length", row.key)}
                        value={row.minutes}
                        disabled={frozen}
                        aria-invalid={lessonErrorText.length > 0 ? true : undefined}
                        onChange={(event) => update(row.key, { minutes: event.target.value })}
                      >
                        {(parts.some((part) => String(part.minutes) === row.minutes)
                          ? parts.map((part) => part.minutes)
                          : [...parts.map((part) => part.minutes), Number(row.minutes)]
                        ).map((minutes) => (
                          <option key={minutes} value={minutes}>
                            {tp("minutes", { minutes })}
                          </option>
                        ))}
                      </NativeSelect>
                    </div>
                  ) : (
                    // One length in the block: said, not asked.
                    <div className="space-y-1.5">
                      <span className={labelClassName}>{tp("length")}</span>
                      <p className="flex h-9 items-center text-sm">{tp("minutes", { minutes: row.minutes })}</p>
                    </div>
                  )}
                  {/* The block's own weeks: the gateway sets them, so they are said and not asked. */}
                  <div className="space-y-1.5">
                    <span className={labelClassName}>{tp("weeks")}</span>
                    <p className="flex h-9 items-center text-sm">{weeksOf(row.recurrence)}</p>
                  </div>
                </div>

                <div role="group" aria-labelledby={id("rooms", row.key)} className="space-y-2">
                  <p id={id("rooms", row.key)} className="text-sm font-medium">
                    {t("rooms")}
                  </p>
                  <div className="grid gap-3 sm:grid-cols-2 [&>*]:min-w-0">
                    {members.map((member) => {
                      const chosen = row.rooms[member.id] ?? "";
                      const storedName = row.roomNames[member.id];
                      return (
                        <FormField key={member.id} id={id(`room-${member.id}`, row.key)} label={t("roomOf", { post: label(member) })}>
                          {(control) => (
                            <NativeSelect
                              {...control}
                              aria-describedby={[control["aria-describedby"], cannot === null ? roomsHintId : undefined, lessonErrorText.length > 0 ? rowErrorId : undefined]
                                .filter(Boolean)
                                .join(" ") || undefined}
                              value={chosen}
                              disabled={frozen}
                              onChange={(event) => chooseRoom(row, member.id, event.target.value)}
                            >
                              {/* The empty choice is a choice: the engine chooses the post's room at every Generera. */}
                              <option value="">{tp("roomAny")}</option>
                              {rooms.map((room) => (
                                <option key={room.id} value={room.id}>
                                  {room.name}
                                </option>
                              ))}
                              {/* A room the list does not offer any more is kept as stored, not dropped. */}
                              {chosen && storedName && !rooms.some((room) => room.id === chosen) ? (
                                <option value={chosen}>{storedName}</option>
                              ) : null}
                            </NativeSelect>
                          )}
                        </FormField>
                      );
                    })}
                  </div>
                </div>

                {lessonErrorText.length > 0 ? (
                  <div id={rowErrorId} className="space-y-1">
                    {lessonErrorText.map((text) => (
                      <p key={text} className="break-words text-sm text-destructive">
                        {text}
                      </p>
                    ))}
                  </div>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={tp("remove", { n: index + 1 })}
                  onClick={() => remove(row.key)}
                >
                  <X className="mr-1 size-4" aria-hidden />
                  {tp("removeShort")}
                </Button>
              </fieldset>
            );
          })}

          {cannot === null ? (
            <div className="space-y-1.5">
              <Button
                id={addId}
                type="button"
                variant="outline"
                size="sm"
                disabled={!canAdd}
                aria-describedby={canAdd ? undefined : `${addId}-full`}
                onClick={add}
              >
                <Plus className="mr-1 size-4" aria-hidden />
                {tp("add")}
              </Button>
              {canAdd ? null : (
                <p id={`${addId}-full`} className="text-xs text-muted-foreground">
                  {t("addFull", { count: lengths.length })}
                </p>
              )}
            </div>
          ) : null}

          {list.length === 0 && storedCount > 0 ? <Notice role={null}>{t("emptySave")}</Notice> : null}
        </fieldset>
      )}

      <Notice role={null}>
        <p>{t("nextGenerate")}</p>
        <p>{t("handMove")}</p>
        <p>{tp("neverGivesWay")}</p>
      </Notice>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {tCommon("cancel")}
        </Button>
        <Button
          type="button"
          data-writes="PLANERING"
          disabled={saving || !canSave}
          onClick={() => void submit()}
        >
          {tCommon("save")}
        </Button>
      </DialogFooter>
    </>
  );
}
