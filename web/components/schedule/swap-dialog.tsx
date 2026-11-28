"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Lock } from "lucide-react";
import { ApiError } from "@/lib/api";
import { LESSON_IS_PLACED } from "@/lib/lesson-is-placed";
import {
  applyBody,
  clockOf,
  SWAP_LOCKED,
  SWAP_SPLITS_PARALLEL,
  SWAP_STALE,
  useSwaps,
  type ExternalTouch,
  type SoftCost,
  type SwapMove,
  type SwapPair,
  type SwapProposal,
  type SwapSlot,
  type SwapSuggestion,
} from "@/lib/swaps";
import { swapPreview } from "@/lib/swap-store";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Notice } from "@/components/ui/notice";
import { apiErrorText } from "@/lib/api-error-text";
import { DirectReachDeclined } from "@/lib/direct-reach";

/** How long the applied toast, and with it Ångra, stays up (as after the room optimisation). */
const UNDO_TOAST_MS = 15_000;

/** The soft rules in the order a school feels them: the pupils' day first. */
const SOFT_ORDER = ["PUPIL_GAPS", "TEACHER_GAPS", "DISTRIBUTION", "TEACHER_DAY"] as const;

/** The names a proposal's lines are told in: the page's own lists, since a proposal names ids only. */
export interface SwapNames {
  teacherName: (id: string) => string | null;
  roomName: (id: string) => string | null;
}

/** What one apply is: who was picked, and so which lessons may be locked. */
interface ApplyHow {
  /** The lesson the schemaläggare picked. */
  lessonId: string;
  /** Byt plats: the other lesson of the two, whom the person chose as well and who may therefore be locked. */
  alsoPicked?: string[];
}

interface Applying {
  onApplied: () => void;
  /** The question before a change in Direkt that reaches families (lib/use-direct-reach-ask.tsx), asked around an apply and never around its undo. */
  guard?: <T>(run: () => Promise<T>) => Promise<T>;
  /** The proposals no longer describe the timetable: ask again. */
  again: () => void;
}

/**
 * Applying a proposal and taking it back, the one way for every list of them (Föreslå byten, Byt plats, Gör plats): the gateway's own sentence
 * for every 409, an Ångra on the toast that sends the same moves reversed, and what was said of the calendar. `done` runs when the apply went
 * through, before the toast, so that the list that asked can close.
 */
function useApplyProposal({ onApplied, guard, again }: Applying) {
  const t = useTranslations("swaps");
  const tCommon = useTranslations("common");
  const { apply } = useSwaps();
  const message = (error: unknown) => (error instanceof Error ? apiErrorText(error, tCommon) : t("failed"));

  /**
   * The same moves sent back: the apply's answer names them. What it says is what it did: the timetable's lessons stand on their old times and
   * the published ones that followed are moved back. The calendar lessons the swap removed (`removedBySwap`), and any the undo had to remove in
   * its turn, do not come back with it, nor does what hung on them. A lesson the person chose that was locked is still locked and is the
   * person's to move back, so `alsoPicked` goes with the undo.
   */
  const undo = async (how: ApplyHow, moves: SwapMove[], removedBySwap: number) => {
    try {
      const result = await apply.mutateAsync(applyBody(how.lessonId, moves, "Före ångra", { alsoPicked: how.alsoPicked }));
      onApplied();
      const gone = removedBySwap + result.removedCalendarLessons;
      const description = [
        result.propagatedLessons > 0 ? t("undoneCalendar", { count: result.propagatedLessons }) : null,
        gone > 0 ? t("undoneNotRestored", { count: gone }) : null,
      ]
        .filter((part) => part !== null)
        .join(" ");
      if (description) toast.success(t("undone"), { description, duration: UNDO_TOAST_MS });
      else toast.success(t("undone"));
    } catch (error) {
      toast.error(error instanceof ApiError && error.status === 409 ? t("undoStale") : message(error));
    }
  };

  const run = async (proposal: SwapProposal, how: ApplyHow, done: () => void) => {
    try {
      const send = () => apply.mutateAsync(applyBody(how.lessonId, proposal.moves, undefined, { alsoPicked: how.alsoPicked }));
      const result = await (guard ? guard(send) : send());
      onApplied();
      done();
      const description = [
        result.propagatedLessons > 0 ? t("calendarUpdated", { count: result.propagatedLessons }) : null,
        result.removedCalendarLessons > 0 ? t("calendarRemoved", { count: result.removedCalendarLessons }) : null,
        // Låset vid en flytt (E4): the swap locked what it moved, and Ångra takes the lock off with it.
        result.lockedByMove && result.lockedLessonIds?.length ? t("lockedByMove", { count: result.lockedLessonIds.length }) : null,
        // Undantag med flit (E1b): a lesson moved by hand loses the exemption it stood on, and Ångra does not give it back.
        result.exemptionsEnded?.length ? t("exemptionsEnded", { count: result.exemptionsEnded.length }) : null,
      ]
        .filter((part) => part !== null)
        .join(" ");
      toast.success(t("applied", { count: proposal.moves.length }), {
        ...(description ? { description } : {}),
        duration: UNDO_TOAST_MS,
        action: {
          label: t("undo"),
          onClick: () => void undo(how, result.undo, result.removedCalendarLessons),
        },
      });
    } catch (error) {
      // Avbryt on the question before a change in Direkt is an answer and not a failure: the proposal stands, nothing was changed.
      if (error instanceof DirectReachDeclined) return;
      if (error instanceof ApiError && error.status === 409) {
        // Stale, parted, locked or placed: the proposals no longer describe the
        // timetable, and the clash rule's own sentence is the reason otherwise.
        toast.error(
          error.code === SWAP_STALE
            ? t("stale")
            : error.code === SWAP_SPLITS_PARALLEL
              ? t("splitsParallel")
              : error.code === SWAP_LOCKED
                ? t("lockedPartner")
                : error.code === LESSON_IS_PLACED
                  ? t("placed")
                  : apiErrorText(error, tCommon),
        );
        again();
        return;
      }
      toast.error(message(error));
    }
  };

  return { run, applying: apply.isPending };
}

/** "Tisdag 10:00–11:00", the way a move line says where a lesson stands. */
function useSlotLabel() {
  const tDays = useTranslations("days");
  return useCallback((slot: SwapSlot) => `${tDays(String(slot.dayOfWeek))} ${clockOf(slot.startMinutes)}–${clockOf(slot.endMinutes)}`, [tDays]);
}

interface ProposalCardProps extends SwapNames {
  proposal: SwapProposal;
  /** The lessons the schemaläggare chose themselves: marked "Vald". */
  pickedIds: ReadonlySet<string>;
  applying: boolean;
  onApply: () => void;
  /** Gör plats and Byt plats: the board shows one proposal at a time, and this says which, and lets another be shown. */
  shown?: boolean;
  onShow?: () => void;
}

/** One proposal: what moves where, what goes along, what it takes out of the calendar, what it holds and what it costs. */
function ProposalCard({ proposal, pickedIds, teacherName, roomName, applying, onApply, shown, onShow }: ProposalCardProps) {
  const t = useTranslations("swaps");
  const slotLabel = useSlotLabel();
  const lessonOf = (id: string) => proposal.lessons.find((lesson) => lesson.id === id);
  const labelOf = (id: string) => {
    const lesson = lessonOf(id);
    return lesson ? `${lesson.subjectName} ${lesson.groupName}` : "?";
  };

  const costText = (cost: SoftCost) => {
    const text = (value: number) => (cost.unit === "MINUTES" ? t("minutes", { count: Math.round(value) }) : t("breaches", { count: value }));
    return (
      <span className={cn("tabular-nums", cost.delta < 0 && "font-semibold text-foreground", cost.delta > 0 && "font-semibold text-destructive")}>
        {text(cost.before)} → {text(cost.after)}
      </span>
    );
  };

  const externalText = (touch: ExternalTouch) =>
    t(`external.${touch.kind}`, {
      teacher: teacherName(touch.resourceId) ?? t("unnamedTeacher"),
      room: roomName(touch.resourceId) ?? "?",
      schools: touch.schools.join(", "),
      when: slotLabel(touch),
    });

  const heading = proposal.kind === "SWAP" ? t("swap") : proposal.kind === "CHAIN" ? t("chain") : t("makeRoom");
  return (
    <li className={cn("space-y-2 rounded-md border p-3", shown && "border-primary ring-1 ring-primary")} data-swap-proposal={proposal.kind} aria-current={shown ? "true" : undefined}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`swap-${proposal.id}`} className="text-sm font-semibold">
          {heading}
          {/* What the heading is about, for the reader of a list of twelve of them. */}
          <span className="sr-only">
            {": "}
            {proposal.moves.map((move) => labelOf(move.lessonId)).join(", ")}
          </span>
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {onShow ? (
            <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" aria-pressed={shown} aria-describedby={`swap-${proposal.id}`} onClick={onShow}>
              {shown ? t("shownOnBoard") : t("showOnBoard")}
            </Button>
          ) : null}
          <Button
            size="sm"
            className="min-h-11 sm:min-h-8"
            onClick={onApply}
            aria-describedby={proposal.removedCalendarLessons > 0 ? `swap-${proposal.id} swap-${proposal.id}-removes` : `swap-${proposal.id}`}
            disabled={applying}
            data-writes="SCHEMALAGGNING DRIFT"
          >
            {applying ? <Loader2 className="animate-spin" /> : null}
            {t("apply")}
          </Button>
        </div>
      </div>

      <ul className="space-y-1 text-sm">
        {proposal.moves.map((move) => {
          const lesson = lessonOf(move.lessonId);
          const level = proposal.levels?.[move.lessonId];
          return (
            <li key={move.lessonId} className="flex flex-wrap gap-x-2">
              <span className="font-medium">{labelOf(move.lessonId)}</span>
              <span className="text-muted-foreground">{t("moveLine", { from: slotLabel(move.from), to: slotLabel(move.to) })}</span>
              {pickedIds.has(move.lessonId) ? (
                <span className="text-xs text-muted-foreground">({t("picked")})</span>
              ) : level !== undefined && level > 0 ? (
                <span className="text-xs text-muted-foreground">({t("level", { level })})</span>
              ) : null}
              {lesson?.isLocked ? (
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                  <Lock className="size-3" aria-hidden />
                  {t("locked")}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>

      {proposal.removedCalendarLessons > 0 ? (
        <Notice tone="warning" role={null} id={`swap-${proposal.id}-removes`}>
          <p>{t("removesCalendar", { count: proposal.removedCalendarLessons })}</p>
        </Notice>
      ) : null}

      {proposal.parallels.length > 0 ? (
        <p className="text-sm">
          <span className="font-medium">{t("follows")}: </span>
          {proposal.parallels.map((link) => t("followsBecause", { lesson: labelOf(link.lessonId), reason: t(`parallel.${link.kind}`) })).join("; ")}
        </p>
      ) : null}

      {proposal.external.length > 0 ? (
        <div className="text-sm">
          <p className="font-medium">{t("otherSchools")}</p>
          <ul className="list-disc space-y-0.5 pl-5 text-muted-foreground">
            {proposal.external.map((touch, index) => (
              <li key={`${touch.lessonId}-${touch.resourceId}-${index}`}>{externalText(touch)}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{t("hardTitle")}: </span>
        {proposal.hard.map((code) => t(`hard.${code}`)).join("; ")}
      </p>

      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm" aria-label={t("softTitle")}>
        {SOFT_ORDER.map((code) => {
          const cost = proposal.soft.find((entry) => entry.code === code);
          if (!cost) return null;
          return (
            <div key={code} className="contents">
              <dt className="text-muted-foreground">{t(`soft.${code}`)}</dt>
              <dd className="text-right">{costText(cost)}</dd>
            </div>
          );
        })}
        <dt className="text-muted-foreground">{t("soft.MOVED_LESSONS")}</dt>
        <dd className="text-right tabular-nums">{t("lessons", { count: proposal.moves.length })}</dd>
      </dl>
    </li>
  );
}

export interface SwapDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The picked lesson; null while nothing is. */
  lessonId: string | null;
  /** What it is called, for the description. */
  lessonName: string | null;
  /** The page's own lists: the proposal names ids only, and the names are the page's. */
  teacherName: (id: string) => string | null;
  roomName: (id: string) => string | null;
  /** Called after an apply and after its undo: each rewrote lessons under the page. */
  onApplied: () => void;
  /**
   * The question before a change in Direkt that reaches families (lib/use-direct-reach-ask.tsx), asked around an apply and never around its
   * undo. Left out, an apply is run as it is and the gateway's own guard answers 409 DIRECT_REACH_UNANSWERED when it reached families unasked.
   */
  guard?: <T>(run: () => Promise<T>) => Promise<T>;
}

/**
 * Byten och flyttar: the swaps and chains of three a picked lesson can take
 * part in, each with the lessons that go along with it, the hard rules it was
 * judged by and what it costs in the soft ones.
 *
 * It decides nothing itself. The gateway judges every proposal by the write
 * path's own clash rule, as one move, and this only shows the verdict and the
 * costs and sends the moves it was given back to apply — whole, parallel
 * lessons included, so a proposal is never finished on the page's behalf.
 */
export function SwapDialog({
  open,
  onOpenChange,
  lessonId,
  lessonName,
  teacherName,
  roomName,
  onApplied,
  guard,
}: SwapDialogProps) {
  const t = useTranslations("swaps");
  const { suggest } = useSwaps();
  const [suggestion, setSuggestion] = useState<SwapSuggestion | null>(null);
  const [failed, setFailed] = useState(false);
  /*
   * Which ask an answer belongs to. Closing the dialog, or picking another
   * lesson, abandons the ask in flight; a late answer must not land in the
   * next lesson's list (as in the room optimisation dialog).
   */
  const ask = useRef(0);

  const search = useCallback(async () => {
    if (!lessonId) return;
    const mine = ++ask.current;
    setFailed(false);
    setSuggestion(null);
    try {
      const answer = await suggest.mutateAsync({ lessonId });
      if (mine === ask.current) setSuggestion(answer);
    } catch {
      if (mine === ask.current) setFailed(true);
    }
    // `suggest` is a fresh object each render; its mutation function is the same one.
  }, [lessonId]);

  useEffect(() => {
    if (open && lessonId) void search();
    if (!open) {
      ask.current += 1;
      setSuggestion(null);
      setFailed(false);
    }
  }, [open, lessonId, search]);

  const { run, applying } = useApplyProposal({ onApplied, guard, again: () => void search() });
  const doApply = (proposal: SwapProposal) => {
    if (!lessonId) return Promise.resolve();
    return run(proposal, { lessonId }, () => onOpenChange(false));
  };

  const pending = suggest.isPending;
  const pickedIds = new Set(lessonId ? [lessonId] : []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {lessonName !== null ? <span className="block font-medium text-foreground">{lessonName}</span> : null}
            {t("body")}
          </DialogDescription>
        </DialogHeader>

        {pending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" />
            {t("computing")}
          </p>
        ) : null}

        {failed ? (
          <Notice tone="warning">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p>{t("failed")}</p>
              <Button size="sm" variant="outline" onClick={() => void search()}>
                {t("retry")}
              </Button>
            </div>
          </Notice>
        ) : null}

        {suggestion?.immovable ? (
          <Notice tone="warning">
            <p>{suggestion.immovable === "PARKED" ? t("parked") : suggestion.immovable === "PLACED" ? t("placed") : t("notPlaced")}</p>
          </Notice>
        ) : null}

        {suggestion && !suggestion.immovable ? (
          <>
            {suggestion.selectedLocked ? <p className="text-sm text-muted-foreground">{t("lockedPicked")}</p> : null}
            {suggestion.unit.links.length > 0 ? (
              <p className="text-sm text-muted-foreground">{t("withParallel", { count: suggestion.unit.lessonIds.length - 1 })}</p>
            ) : null}

            {suggestion.proposals.length === 0 ? (
              <p className="text-sm font-medium">{t("none")}</p>
            ) : (
              <>
                <p className="text-sm font-medium">{t("found", { count: suggestion.proposals.length })}</p>
                <ul className="space-y-3" aria-label={t("title")}>
                  {suggestion.proposals.map((proposal) => (
                    <ProposalCard
                      key={proposal.id}
                      proposal={proposal}
                      pickedIds={pickedIds}
                      teacherName={teacherName}
                      roomName={roomName}
                      applying={applying}
                      onApply={() => void doApply(proposal)}
                    />
                  ))}
                </ul>
              </>
            )}

            {suggestion.proposals.length > 0 ? <p className="text-xs text-muted-foreground">{t("notChecked")}</p> : null}
            {suggestion.stats.truncated ? <p className="text-xs text-muted-foreground">{t("truncated")}</p> : null}
          </>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("closeAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// E5a: Byt plats and Gör plats, the lists that sit beside the board
// ---------------------------------------------------------------------------

/**
 * What a list of proposals is asked: two marked lessons that trade starts (`pair`), what has to move for a lesson to stand at a time (`room`),
 * or, for a lesson let go on a taken time, the swap with the one lesson that stands there (`swap`).
 */
export type ProposalAsk =
  | { kind: "pair"; lessonId: string; otherLessonId: string }
  | { kind: "room"; lessonId: string; target: { dayOfWeek: number; startMinutes: number } }
  | { kind: "swap"; lessonId: string; target: { dayOfWeek: number; startMinutes: number } };

/** What the loader found, in the form the list shows: proposals to choose from, and the words for when there are none. */
interface Found {
  proposals: SwapProposal[];
  /** How an apply of these is made: who was picked, and who else the person chose. */
  how: ApplyHow;
  /** The key under `swaps.room` that says why there is nothing. */
  none?: string;
  /** Gör plats: what stands at the time. */
  blockers?: NonNullable<SwapSuggestion["makeRoom"]>["blockers"];
  /** Byt plats: the judge's reasons, by lesson. */
  refusals?: SwapPair["refusals"];
  truncated?: boolean;
}

export interface SwapProposalsProps extends SwapNames {
  ask: ProposalAsk;
  /** Names a lesson by its id for a refusal, when the host knows how; the reason is told without it otherwise. */
  labelOf?: (lessonId: string) => string | null;
  onApplied: () => void;
  guard?: <T>(run: () => Promise<T>) => Promise<T>;
  /** The apply went through: the host closes. */
  onDone: () => void;
}

/**
 * THE LIST OF PROPOSALS (E5a): asks the gateway, shows what it answers with each proposal's price before and after, draws the one in view on the
 * board (lib/swap-store.ts), and applies the one chosen. The host is a dialog that is not modal, so the board stays in view and in reach.
 *
 * It decides nothing: the gateway judges every proposal by the one judge of the hand edit as one move (src/swaps), and what is shown is what
 * it said, in its words. Nothing is applied by showing.
 */
export function SwapProposals({ ask, labelOf, teacherName, roomName, onApplied, guard, onDone }: SwapProposalsProps) {
  const t = useTranslations("swaps");
  const { suggest, pair } = useSwaps();
  const [found, setFound] = useState<Found | null>(null);
  const [failed, setFailed] = useState(false);
  const [shownId, setShownId] = useState<string | null>(null);
  const asked = useRef(0);
  const askRef = useRef(ask);
  askRef.current = ask;
  const key = JSON.stringify(ask);

  const search = useCallback(async () => {
    const current = askRef.current;
    const mine = ++asked.current;
    setFailed(false);
    setFound(null);
    try {
      let answer: Found;
      if (current.kind === "pair") {
        answer = pairFound(await pair.mutateAsync({ lessonId: current.lessonId, otherLessonId: current.otherLessonId }), {
          lessonId: current.lessonId,
          alsoPicked: [current.otherLessonId],
        });
      } else {
        const room = await suggest.mutateAsync({
          lessonId: current.lessonId,
          makeRoom: { dayOfWeek: current.target.dayOfWeek, startTime: clockOf(current.target.startMinutes) },
          limit: 8,
        });
        if (current.kind === "room" || room.immovable) {
          answer = roomFound(room, { lessonId: current.lessonId });
        } else {
          // A swap is with the one lesson that stands there; with none, or with several, there is no one to swap with.
          const blockers = room.makeRoom?.blockers ?? [];
          const only = blockers.length === 1 ? blockers[0]!.lessonIds[0]! : null;
          answer =
            only === null
              ? { proposals: [], how: { lessonId: current.lessonId }, none: blockers.length === 0 ? "dropNoOne" : "dropSeveral", blockers }
              : {
                  ...pairFound(await pair.mutateAsync({ lessonId: current.lessonId, otherLessonId: only }), { lessonId: current.lessonId, alsoPicked: [only] }),
                  blockers,
                };
        }
      }
      if (mine === asked.current) {
        setFound(answer);
        setShownId(answer.proposals[0]?.id ?? null);
      }
    } catch {
      if (mine === asked.current) setFailed(true);
    }
    // The mutations are fresh objects each render; their functions are the same ones.
  }, []);

  useEffect(() => {
    void search();
    return () => {
      asked.current += 1;
    };
  }, [key, search]);

  // The board draws the proposal in view, and nothing when there is none or when this list goes.
  const shown = found?.proposals.find((proposal) => proposal.id === shownId) ?? null;
  useEffect(() => {
    swapPreview.set(shown);
    return () => swapPreview.set(null);
  }, [shown]);

  const { run, applying } = useApplyProposal({ onApplied, guard, again: () => void search() });
  const how: ApplyHow = found?.how ?? { lessonId: ask.lessonId };
  const pickedIds = new Set([ask.lessonId, ...(how.alsoPicked ?? [])]);
  const pending = suggest.isPending || pair.isPending;

  return (
    <div className="space-y-3" data-swap-proposals={ask.kind}>
      {pending ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" />
          {t("computing")}
        </p>
      ) : null}

      {failed ? (
        <Notice tone="warning">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p>{t("failed")}</p>
            <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => void search()}>
              {t("retry")}
            </Button>
          </div>
        </Notice>
      ) : null}

      {found?.blockers && found.blockers.length > 0 ? (
        <p className="text-sm" data-swap-blockers>
          <span className="font-medium">{t("room.standsThere")}: </span>
          {found.blockers.map((blocker) => `${blocker.subjectName} ${blocker.groupName}${blocker.isLocked ? ` (${t("locked").toLowerCase()})` : ""}`).join(", ")}
        </p>
      ) : null}

      {found && found.proposals.length === 0 && found.none ? (
        <Notice tone="warning" role="status">
          <p>{t(`room.${found.none}`)}</p>
        </Notice>
      ) : null}

      {found?.refusals && found.refusals.length > 0 ? (
        <div className="space-y-1 text-sm" data-swap-refusals>
          <p className="font-medium">{t("pair.refused")}</p>
          <ul className="list-disc space-y-1 pl-5">
            {found.refusals.map((refusal, index) => (
              <li key={`${refusal.lessonId}-${index}`}>
                {labelOf?.(refusal.lessonId) ? <span className="font-medium">{labelOf(refusal.lessonId)}: </span> : null}
                {refusal.text}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {found && found.proposals.length > 0 ? (
        <>
          <p className="text-sm font-medium">{t("found", { count: found.proposals.length })}</p>
          <ul className="space-y-3" aria-label={t(ask.kind === "pair" ? "pair.title" : ask.kind === "swap" ? "pair.dropTitle" : "room.title")}>
            {found.proposals.map((proposal) => (
              <ProposalCard
                key={proposal.id}
                proposal={proposal}
                pickedIds={pickedIds}
                teacherName={teacherName}
                roomName={roomName}
                applying={applying}
                shown={proposal.id === shownId}
                onShow={() => setShownId(proposal.id)}
                onApply={() => void run(proposal, how, onDone)}
              />
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">{t("notChecked")}</p>
          {found.truncated ? <p className="text-xs text-muted-foreground">{t("truncated")}</p> : null}
        </>
      ) : null}
    </div>
  );
}

function roomFound(answer: SwapSuggestion, how: ApplyHow): Found {
  const blockers = answer.makeRoom?.blockers;
  const named = blockers ? { blockers } : {};
  if (answer.immovable) return { proposals: [], how, none: `immovable.${answer.immovable}`, ...named };
  if (answer.proposals.length === 0) return { proposals: [], how, none: answer.makeRoom?.stuck ? `stuck.${answer.makeRoom.stuck}` : "none", ...named };
  return { proposals: answer.proposals, how, truncated: answer.stats.truncated, ...named };
}

function pairFound(answer: SwapPair, how: ApplyHow): Found {
  if (answer.immovable) return { proposals: [], how, none: `pairImmovable.${answer.immovable}` };
  if (!answer.ok || !answer.proposal) return { proposals: [], how, refusals: answer.refusals };
  return { proposals: [answer.proposal], how };
}

/**
 * The dialog the two lists sit in: not modal, so that the board stays in reach and the proposal in view is drawn on it, and set at the bottom
 * of the window with its own scroll. A pointer on the board does not dismiss it (it is the point that the board can be used), and Esc does.
 */
export const sheetClassName = "top-auto bottom-2 max-h-[55dvh] translate-y-0 sm:max-w-2xl";

export interface SwapPairDialogProps extends Partial<SwapNames> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The two lessons that were marked, as the page holds them: the day and clock say which is which when a reason is told. */
  lessons: ReadonlyArray<{ id: string; dayOfWeek: number; startTime: string }>;
  onApplied: () => void;
  guard?: <T>(run: () => Promise<T>) => Promise<T>;
}

/** Byt plats: two marked lessons that each take the other's start (POST /api/v1/swaps/pair), with the swap's price or the reasons it cannot be. */
export function SwapPairDialog({ open, onOpenChange, lessons, teacherName, roomName, onApplied, guard }: SwapPairDialogProps) {
  const t = useTranslations("swaps");
  const tDays = useTranslations("days");
  const [first, second] = lessons;
  const labelOf = (id: string) => {
    const lesson = lessons.find((entry) => entry.id === id);
    return lesson ? `${tDays(String(lesson.dayOfWeek))} ${lesson.startTime.slice(0, 5)}` : null;
  };
  return (
    <Dialog open={open} modal={false} onOpenChange={onOpenChange}>
      <DialogContent className={sheetClassName} onInteractOutside={(event) => event.preventDefault()} onFocusOutside={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{t("pair.title")}</DialogTitle>
          <DialogDescription>{t("pair.body")}</DialogDescription>
        </DialogHeader>
        {open && first && second ? (
          <SwapProposals
            ask={{ kind: "pair", lessonId: first.id, otherLessonId: second.id }}
            labelOf={labelOf}
            teacherName={teacherName ?? (() => null)}
            roomName={roomName ?? (() => null)}
            onApplied={onApplied}
            guard={guard}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
        <DialogFooter>
          <Button variant="outline" className="min-h-11 sm:min-h-9" onClick={() => onOpenChange(false)}>
            {t("closeAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
