"use client";

// Block i schemat: a parallel block's lessons on the grundschema as ONE card
// per slot.
//
// A block (TeachingRequirements."blockId", Parallella block) holds posts whose
// lessons the generator places at the same times — "Språkval åk 7" is Tyska
// för Ty7, Franska för Fr7 and Spanska för Sp7. On the grid that was three
// cards side by side that each moved alone, and a drag of one quietly broke
// what the generator had put together. Here the lessons of a block's members
// that stand in one slot (day, clock and weeks) are one card: it names the
// block and lists the members, a drag or a keyboard move of it moves every
// member as one move (PATCH /api/v1/master-lessons/block-card), and its dialog
// locks the whole block. A member moved ALONE — from a filtered view, a
// board, or its lesson dialog — splits the block: the drag asks first, and
// the save says so with "Flytta tillbaka med blocket" beside it. The gateway
// decides what a split means (src/calendar/block-lessons.ts).
//
// LOADED ONLY WHEN THE YEAR HAS A BLOCK, as Mål mode and the requirements
// page's block panel are: /admin/timetable sat at 188.3 KB of its 190 KB
// budget. The page imports this file by hand once its timplan names a block,
// renders BlockHost, and asks the kit BlockHost hands it; every hook, dialog
// and write of the feature is here, behind that import.
//
// A lesson cannot name its post: it is found by the post's own key (group,
// subject), as everywhere else (lib/conflicts.ts, buildPupilBufferMap). A
// card's id is "block:" and its first lesson's id, so the page's lookups by
// lesson id pass a card by, and nothing the page does to one lesson is done
// to a card unless this kit says so.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { MessageLookup } from "@/lib/engine-message";
import { warningText } from "@/lib/staffing-warnings";
import type { MasterLesson, StaffingWarning, TeachingBlock, TeachingRequirement } from "@/lib/types";
import type { HistoryEntry } from "@/lib/use-schedule-history";
import { createClient } from "@/utils/supabase/client";
import type { LessonChange, TimetableLesson } from "@/components/schedule/timetable-grid";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const CARD = "block:";

/** One slot of a block: the lessons of two or more of its members standing together. */
export interface BlockCard {
  /** "block:" + the first lesson's id: stable while the card's lessons are. */
  id: string;
  blockId: string;
  name: string;
  /** One lesson per member, by id. */
  lessons: MasterLesson[];
  /** Whether every member with a placed lesson stands here; false is a split block. */
  complete: boolean;
}

/** What a lesson write answers (PATCH /:id and PATCH block-card alike). */
export interface SavedWrite {
  propagatedLessons: number;
  removedCalendarLessons?: number;
  warnings?: StaffingWarning[];
  /** PATCH block-card: the block's lessons the card landed beside, with the owner each had. */
  joined?: { id: string; isGenerated: boolean }[];
  /** PATCH block-card: the lessons of a block on the same times that moved with the card. */
  followed?: string[];
}

/**
 * A card move's undo: back where it stood, leaving behind what it took in
 * where it landed (`joined`) and taking back exactly the other term's card it
 * moved (`followed`), so a move that took none does not take one back. An
 * API older than `followed` gets the body it always got.
 */
export function moveBackOf<T extends object>(from: T, result: SavedWrite): T & { leave?: SavedWrite["joined"]; follow?: string[] } {
  return {
    ...from,
    ...(result.joined && result.joined.length > 0 ? { leave: result.joined } : {}),
    ...(result.followed ? { follow: result.followed } : {}),
  };
}

/** A lesson's PATCH as it answers: the write, and the lesson as written. */
export type SavedLesson = SavedWrite & Partial<MasterLesson>;

/** The page's own ways of writing, saying and opening, which the kit uses. */
export interface BlockActions {
  /** undoableUpdate: one lesson's PATCH, with its undo. */
  update: (
    lesson: MasterLesson,
    patch: {
      dayOfWeek: number;
      startTime: string;
      endTime: string;
      recurrence?: MasterLesson["recurrence"];
      startDate?: string | null;
      endDate?: string | null;
    },
  ) => Promise<SavedLesson>;
  /**
   * The page's drop: asked first when the lessons reach more than one class,
   * by the dialog that names them; `go` moves them (else the page's own move
   * of the first), `block` names a card in that dialog.
   */
  drop: (moved: MasterLesson[], change: LessonChange, go?: () => void, block?: string) => void;
  /** The page's validateChange: may this lesson stand there, `without` the lessons moving with it. */
  validate: (id: string, change: LessonChange, without?: ReadonlySet<string>) => boolean;
  history: { push: (entry: HistoryEntry) => void };
  showError: (error: unknown) => void;
  /** The page's saved toast. */
  announce: (result: SavedWrite) => void;
  /** The page's saved sentence ("Sparat. 3 lektioner i kalendern flyttades."). */
  title: (result: SavedWrite) => string;
  /** "Tyska · Ty7 · K. Ek · A12": a lesson as the page names it. */
  name: (lesson: MasterLesson) => string;
  openEditor: (lessonId: string) => void;
}

/** What the page asks of the blocks, once BlockHost has them. */
export interface BlockKit {
  /** The grid's cards: each card's visible members drawn as one. */
  grid: (shown: readonly MasterLesson[], toGrid: (lesson: MasterLesson) => TimetableLesson) => TimetableLesson[];
  /** A drag of a card holds every member, with the card's own lessons out of the way. */
  validate: (
    id: string,
    change: LessonChange,
    one: (id: string, change: LessonChange, without?: ReadonlySet<string>) => boolean,
  ) => boolean;
  /** Handles a move of a card, or of a member out of its card; false: the page's own move. */
  move: (id: string, change: LessonChange) => boolean;
  /** Opens a card's dialog; false: not a card. */
  open: (id: string) => boolean;
  /** A card's lessons, or with `whole` its block's placed lessons, for the bulk actions; undefined: not a card. */
  lessonIdsOf: (id: string, whole?: boolean) => string[] | undefined;
  /** Says why a card was not moved there, or not set aside; false: not a card. */
  refuse: (id: string, tray: boolean) => boolean;
  /** Says a save that split a block, with the way back; false: the page's own toast. */
  announce: (before: MasterLesson, result: SavedLesson) => boolean;
}

const slotOf = (lesson: MasterLesson): string =>
  [lesson.dayOfWeek, lesson.startTime, lesson.endTime, lesson.recurrence, lesson.startDate, lesson.endDate].join("|");
const keyOf = (lesson: Pick<MasterLesson, "studentGroupId" | "subjectId">): string =>
  `${lesson.studentGroupId}:${lesson.subjectId}`;
const clock = (time: string): string => time.slice(0, 5);
/** A lesson's or a card's button on the grid (timetable-grid.tsx marks each with its id). */
const onGrid = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-lesson-id="${CSS.escape(id)}"]`);
const hhmm = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * The year's cards, and the block of every lesson in one: from the posts'
 * blockId by (group, subject), over the placed lessons. A slot holding two or
 * more members is a card (a second lesson of one member there stands apart);
 * a lesson of a block alone in its slot stands apart from it.
 */
export function cardsOf(
  lessons: readonly MasterLesson[],
  requirements: readonly TeachingRequirement[],
  names: ReadonlyMap<string, string>,
  /** A block whose name has not been read (yet). */
  unnamed = "",
): {
  cards: Map<string, BlockCard>;
  cardOf: Map<string, BlockCard>;
  apart: Map<string, string>;
  /** Each block's placed lessons. */
  byBlock: Map<string, MasterLesson[]>;
} {
  const blockOfKey = new Map(
    requirements.flatMap((post) => (post.blockId ? [[keyOf(post), post.blockId] as const] : [])),
  );
  const byBlock = new Map<string, MasterLesson[]>();
  for (const lesson of lessons) {
    const blockId = lesson.isParked ? undefined : blockOfKey.get(keyOf(lesson));
    if (blockId) byBlock.set(blockId, [...(byBlock.get(blockId) ?? []), lesson]);
  }
  const cards = new Map<string, BlockCard>();
  const cardOf = new Map<string, BlockCard>();
  const apart = new Map<string, string>();
  for (const [blockId, placed] of byBlock) {
    const name = names.get(blockId) ?? unnamed;
    const standing = new Set(placed.map(keyOf)).size;
    const slots = new Map<string, MasterLesson[]>();
    for (const lesson of [...placed].sort((a, b) => a.id.localeCompare(b.id))) {
      slots.set(slotOf(lesson), [...(slots.get(slotOf(lesson)) ?? []), lesson]);
    }
    for (const here of slots.values()) {
      const members = new Map<string, MasterLesson>();
      for (const lesson of here) if (!members.has(keyOf(lesson))) members.set(keyOf(lesson), lesson);
      const inCard = [...members.values()];
      if (inCard.length < 2) {
        if (standing > 1) for (const lesson of here) apart.set(lesson.id, name);
        continue;
      }
      const card: BlockCard = {
        id: `${CARD}${inCard[0]!.id}`,
        blockId,
        name,
        lessons: inCard,
        complete: inCard.length === standing,
      };
      cards.set(card.id, card);
      for (const lesson of inCard) cardOf.set(lesson.id, card);
      for (const lesson of here) if (!inCard.includes(lesson)) apart.set(lesson.id, name);
    }
  }
  return { cards, cardOf, apart, byBlock };
}

/** The year's block names, as the requirements page reads them (same key). */
function useBlockNames(academicYearId: string) {
  return useQuery({
    queryKey: ["teachingBlocks", academicYearId],
    queryFn: async () => {
      const { data, error } = await createClient()
        .from("TeachingBlocks")
        .select("id, academicYearId, name, sameTimesAsBlockId")
        .eq("academicYearId", academicYearId)
        .order("name");
      if (error) throw error;
      return (data ?? []) as TeachingBlock[];
    },
  });
}

export interface BlockHostProps {
  academicYearId: string;
  lessons: readonly MasterLesson[];
  requirements: readonly TeachingRequirement[];
  actions: BlockActions;
  /** Hands the page its kit, and null when the host goes. */
  onKit: (kit: BlockKit | null) => void;
}

export function BlockHost({ academicYearId, lessons, requirements, actions, onKit }: BlockHostProps) {
  const t = useTranslations("timetable.blocks");
  const tCommon = useTranslations("common");
  const tDays = useTranslations("days");
  const tEngine = useTranslations("engineMessages") as unknown as MessageLookup;
  const queryClient = useQueryClient();
  const { data: blocks } = useBlockNames(academicYearId);
  // The page's actions are new every render, and a translator need not be the
  // same function twice: the kit reads the latest of each through a ref, so it
  // changes only with the cards, and handing it to the page cannot loop.
  const acts = useRef(actions);
  acts.current = actions;
  const say = useRef({ t, tEngine });
  say.current = { t, tEngine };
  const [opened, setOpened] = useState<BlockCard | null>(null);
  const [splitting, setSplitting] = useState<{ card: BlockCard; lesson: MasterLesson; change: LessonChange } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  /*
   * What a dialog of the kit hands on to once it has closed: the lesson
   * editor from a card's Ändra, the page's drop from the split question. Run
   * from its onCloseAutoFocus with focus put back on the card or the lesson
   * on the grid first, so the next dialog takes that as the place to give
   * focus back to; opened while the first was still closing it took a button
   * inside it, and a keyboard user ended on <body>.
   */
  const handOff = useRef<{ focus: string; run: () => void } | null>(null);
  const afterClose = (event: Event) => {
    const next = handOff.current;
    handOff.current = null;
    if (!next) return;
    const target = onGrid(next.focus);
    if (target) {
      event.preventDefault();
      target.focus();
    }
    next.run();
  };
  /*
   * A card moved with the keyboard whose lessons stand on another card after
   * the move — it took in a lesson of the block, and the card took that
   * lesson's lower id — or a lesson apart that a move put on a card: the
   * grid follows the id it moved (timetable-grid.tsx, refocusRef), which is
   * gone. This follows a lesson of it to whatever card it is on now, on the
   * same terms: only while focus is lost, and for ten seconds.
   */
  const follow = useRef<{ lessonId: string; until: number } | null>(null);

  const names = useMemo(() => new Map((blocks ?? []).map((block) => [block.id, block.name])), [blocks]);
  // A string, so the cards change with its text and not with the translator.
  const unnamed = t("unnamed");
  const { cards, cardOf, apart, byBlock } = useMemo(
    () => cardsOf(lessons, requirements, names, unnamed),
    [lessons, requirements, names, unnamed],
  );

  // The writes the kit and the dialogs share. They read the page's actions
  // through the ref, so they do not change when the page re-renders.
  const writes = useMemo(() => {
    const invalidate = () => {
      for (const key of ["masterLessons", "calendarLessons", "teacherLessons"]) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    };
    const patchCard = (body: Record<string, unknown>) =>
      api.patch<SavedWrite>("/api/v1/master-lessons/block-card", body).finally(invalidate);

    const moveCard = async (card: BlockCard, change: LessonChange) => {
      const lessonIds = card.lessons.map((lesson) => lesson.id);
      const lead = card.lessons[0]!;
      const to = {
        lessonIds,
        dayOfWeek: change.dayOfWeek,
        startTime: hhmm(change.startMinutes),
        endTime: hhmm(change.endMinutes),
      };
      const from = { lessonIds, dayOfWeek: lead.dayOfWeek, startTime: clock(lead.startTime), endTime: clock(lead.endTime) };
      try {
        // What the card took in where it landed, and the other term's card
        // it took along: its undo leaves the one and takes back the other.
        let result = await patchCard(to);
        acts.current.history.push({
          label: "block-move",
          undo: async () => void (await patchCard(moveBackOf(from, result))),
          redo: async () => {
            result = await patchCard(to);
          },
        });
        acts.current.announce(result);
      } catch (error) {
        acts.current.showError(error);
      }
    };

    /** A save that split a block: its sentence, and the way back with the block. */
    const announce: BlockKit["announce"] = (before, result) => {
      if (!result.warnings?.some((warning) => warning.code === "BLOCK_SPLIT")) return false;
      toast.warning(acts.current.title(result), {
        description: result.warnings.map((warning) => warningText(say.current.tEngine, warning)).join(" "),
        duration: 12_000,
        action: {
          label: say.current.t("moveBack"),
          onClick: () => {
            const moved = { ...before, ...result } as MasterLesson;
            void acts.current
              .update(moved, {
                dayOfWeek: before.dayOfWeek,
                startTime: clock(before.startTime),
                endTime: clock(before.endTime),
                recurrence: before.recurrence,
                startDate: before.startDate,
                endDate: before.endDate,
              })
              .then((back) => announce(moved, back) || acts.current.announce(back))
              .catch(acts.current.showError);
          },
        },
      });
      return true;
    };

    return { moveCard, announce };
  }, [queryClient]);

  const kit = useMemo<BlockKit>(
    () => ({
      grid: (shown, toGrid) => {
        const visible = new Set(shown.map((lesson) => lesson.id));
        const drawn = new Set<string>();
        const out: TimetableLesson[] = [];
        for (const lesson of shown) {
          const card = cardOf.get(lesson.id);
          if (card && card.lessons.filter((member) => visible.has(member.id)).length > 1) {
            if (drawn.has(card.id)) continue;
            drawn.add(card.id);
            // Every member, not only those the filter shows: a drag of the
            // card moves them all, so the card names them all.
            const parts = card.lessons.map(toGrid);
            out.push({
              ...parts[0]!,
              id: card.id,
              title: card.name,
              // Each member as the page writes a lesson: its group and its teacher.
              subtitle: parts.map((part) => part.subtitle).filter(Boolean).join("; "),
              room: [...new Set(parts.map((part) => part.room).filter(Boolean))].join(", ") || undefined,
              locked: parts.every((part) => part.locked),
              conflicted: parts.some((part) => part.conflicted),
              remoteEditor: parts.find((part) => part.remoteEditor)?.remoteEditor,
              recurrenceNote: [parts[0]!.recurrenceNote, card.complete ? null : say.current.t("split")]
                .filter(Boolean)
                .join(" · ") || undefined,
              pupilTimeNote: undefined,
              share: undefined,
              shareLabel: undefined,
            });
            continue;
          }
          // A member shown alone (a filter, a board) or standing apart: its
          // block's name under it, and whether the block is split.
          const base = toGrid(lesson);
          const block = card?.name ?? apart.get(lesson.id);
          out.push(
            block === undefined
              ? base
              : {
                  ...base,
                  recurrenceNote: [
                    base.recurrenceNote,
                    apart.has(lesson.id) || (card && !card.complete) ? say.current.t("apart", { name: block }) : block,
                  ]
                    .filter(Boolean)
                    .join(" · "),
                },
          );
        }
        return out;
      },
      validate: (id, change, one) => {
        const card = cards.get(id);
        if (!card) return one(id, change);
        const ids = new Set(card.lessons.map((lesson) => lesson.id));
        return card.lessons.every((lesson) => one(lesson.id, change, ids));
      },
      move: (id, change) => {
        const card = cards.get(id);
        const focused = document.activeElement === onGrid(id) && document.activeElement !== null;
        if (card) {
          if (focused) follow.current = { lessonId: card.lessons[0]!.id, until: Date.now() + 10_000 };
          acts.current.drop(card.lessons, change, () => void writes.moveCard(card, change), card.name);
          return true;
        }
        if (focused && apart.has(id)) follow.current = { lessonId: id, until: Date.now() + 10_000 };
        const own = cardOf.get(id);
        const lesson = own?.lessons.find((member) => member.id === id);
        if (!own || !lesson) return false;
        setSplitting({ card: own, lesson, change });
        return true;
      },
      open: (id) => {
        const card = cards.get(id);
        if (!card) return false;
        setOpened(card);
        return true;
      },
      lessonIdsOf: (id, whole) => {
        const card = cards.get(id);
        if (!card) return undefined;
        return (whole ? (byBlock.get(card.blockId) ?? card.lessons) : card.lessons).map((lesson) => lesson.id);
      },
      refuse: (id, tray) => {
        const card = cards.get(id);
        if (!card) return false;
        toast.error(say.current.t(tray ? "refusedTray" : "refusedSlot", { name: card.name }));
        return true;
      },
      announce: writes.announce,
    }),
    [cards, cardOf, apart, byBlock, writes],
  );
  // The block's placed lessons, which Lås blocket acts on: its label is theirs, not the card's.
  const blockLocked = opened ? (byBlock.get(opened.blockId) ?? opened.lessons).every((lesson) => lesson.isLocked) : false;

  useEffect(() => {
    const pending = follow.current;
    if (!pending) return;
    if (Date.now() > pending.until) {
      follow.current = null;
      return;
    }
    const button = onGrid(cardOf.get(pending.lessonId)?.id ?? pending.lessonId);
    if (!button || button === document.activeElement) return;
    const active = document.activeElement;
    if (active === null || active === document.body) {
      button.focus();
      follow.current = null;
    }
  });
  useEffect(() => {
    onKit(kit);
  }, [kit, onKit]);
  useEffect(() => () => onKit(null), [onKit]);

  const lock = async (card: BlockCard, isLocked: boolean) => {
    setBusy(true);
    try {
      const patchLock = (body: Record<string, unknown>) =>
        api
          .patch<{ blockId: string; isLocked: boolean; lessonIds: string[]; parked: number }>(
            "/api/v1/master-lessons/block-lock",
            body,
          )
          .finally(() => void queryClient.invalidateQueries({ queryKey: ["masterLessons"] }));
      const result = await patchLock({ blockId: card.blockId, isLocked });
      const lessonIds = result.lessonIds;
      if (lessonIds.length > 0) {
        actions.history.push({
          label: "block-lock",
          undo: async () => void (await patchLock({ blockId: card.blockId, isLocked: !isLocked, lessonIds })),
          redo: async () => void (await patchLock({ blockId: card.blockId, isLocked, lessonIds })),
        });
      }
      const done = t(isLocked ? "locked" : "unlocked", { name: card.name, count: lessonIds.length });
      // A lesson on the tray takes no lock, and the generation refuses the
      // block while one is there (lockBlock): said with the lock.
      if (isLocked && result.parked > 0) {
        toast.warning(done, { description: t("lockedParked", { parked: result.parked }), duration: 12_000 });
      } else {
        toast.success(done);
      }
      setOpened(null);
    } catch (error) {
      actions.showError(error);
    } finally {
      setBusy(false);
    }
  };

  const others = splitting
    ? splitting.card.lessons.filter((member) => member.id !== splitting.lesson.id).map(actions.name)
    : [];
  const lead = opened?.lessons[0];

  return (
    <>
      <Dialog open={opened !== null} onOpenChange={(next) => !next && !busy && setOpened(null)}>
        {/* Closed by its own X or Escape, as the app's dialogs are: a second
            "Stäng" in the footer read twice to a screen reader. */}
        <DialogContent className="max-w-lg" closeDisabled={busy} onCloseAutoFocus={afterClose}>
          <DialogHeader>
            <DialogTitle>{opened?.name ?? ""}</DialogTitle>
            <DialogDescription>
              {lead
                ? t("cardBody", {
                    day: tDays(String(lead.dayOfWeek)),
                    start: clock(lead.startTime),
                    end: clock(lead.endTime),
                  })
                : ""}
            </DialogDescription>
          </DialogHeader>
          {opened ? (
            <div className="space-y-3">
              <ul className="divide-y rounded-md border">
                {opened.lessons.map((lesson) => (
                  <li key={lesson.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span>{actions.name(lesson)}</span>
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={t("editMemberNamed", { lesson: actions.name(lesson) })}
                      data-writes="SCHEMALAGGNING DRIFT"
                      onClick={() => {
                        handOff.current = { focus: opened.id, run: () => actions.openEditor(lesson.id) };
                        setOpened(null);
                      }}
                    >
                      {t("editMember")}
                    </Button>
                  </li>
                ))}
              </ul>
              {opened.complete ? null : <p className="text-sm text-foreground">{t("splitNote")}</p>}
              <p className="text-sm text-foreground">{t("lockHint")}</p>
            </div>
          ) : null}
          <DialogFooter>
            {opened ? (
              <Button
                disabled={busy}
                onClick={() => void lock(opened, !blockLocked)}
                data-writes="SCHEMALAGGNING DRIFT"
              >
                {blockLocked ? t("unlock") : t("lock")}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={splitting !== null} onOpenChange={(next) => !next && setSplitting(null)}>
        <DialogContent className="max-w-md" onCloseAutoFocus={afterClose}>
          <DialogHeader>
            <DialogTitle>{t("splitTitle", { name: splitting?.card.name ?? "" })}</DialogTitle>
            <DialogDescription>
              {splitting
                ? t("splitBody", { lesson: actions.name(splitting.lesson), others: others.join(", ") })
                : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSplitting(null)}>
              {tCommon("cancel")}
            </Button>
            <Button
              variant="outline"
              data-writes="SCHEMALAGGNING DRIFT"
              onClick={() => {
                if (!splitting) return;
                const { lesson, change } = splitting;
                // The page's own drop: its classes asked, its save said.
                handOff.current = { focus: lesson.id, run: () => actions.drop([lesson], change) };
                setSplitting(null);
              }}
            >
              {t("moveOne")}
            </Button>
            <Button
              data-writes="SCHEMALAGGNING DRIFT"
              onClick={() => {
                if (!splitting) return;
                const { card, lesson, change } = splitting;
                // The slot was checked for the one lesson; the card is checked
                // as a card's drop is, every member beside the rest of the day.
                handOff.current = {
                  focus: lesson.id,
                  run: () =>
                    kit.validate(card.id, change, actions.validate) ? kit.move(card.id, change) : kit.refuse(card.id, false),
                };
                setSplitting(null);
              }}
            >
              {t("moveBlock")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
