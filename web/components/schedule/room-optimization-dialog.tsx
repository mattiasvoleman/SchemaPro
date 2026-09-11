"use client";

import { useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Info, Loader2 } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { ApiError } from "@/lib/api";
import {
  useRoomOptimization,
  type RoomApplyResult,
  type RoomMove,
  type RoomProposal,
  type RoomWalkers,
  type Walk,
} from "@/lib/queries";
import type { Person, Room } from "@/lib/types";
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

/** The gateway's code for "the schedule moved since the proposal was read". */
const STALE = "ROOM_PROPOSAL_STALE";

/** How many walkers the proposal names; the rest are in the totals. */
const MOST_IMPROVED = 5;

/**
 * How long the applied toast, and with it Ångra, stays up.
 *
 * Sonner's default four seconds is shorter than it takes to read the message,
 * and this is the app's only toast that carries an action. Once it is gone the
 * way back is the "Före salsoptimering" version, which the manual says.
 */
const UNDO_TOAST_MS = 15_000;

const WALKER_CHOICES: ReadonlyArray<{ value: RoomWalkers; label: string }> = [
  { value: "TEACHERS", label: "walkersTeachers" },
  { value: "GROUPS", label: "walkersGroups" },
  { value: "BOTH", label: "walkersBoth" },
];

/** The three counts, heaviest first — the order a school feels them in. */
const DIMENSIONS: ReadonlyArray<{ key: keyof Walk; label: string }> = [
  { key: "buildingChanges", label: "colBuildings" },
  { key: "floorChanges", label: "colFloors" },
  { key: "roomChanges", label: "colRooms" },
];

/**
 * Walkers who are better off on every count and worse off on none, in the
 * order the proposal lists them.
 *
 * Only strict improvements are listed. The engine trades counts against each
 * other with weights, and a teacher who lost a building change but gained two
 * room changes is better off by the engine's measure and not obviously so by
 * theirs. Naming them under "biggest difference" would invite the argument;
 * the totals above still carry them.
 *
 * No sort of its own. The engine lists walkers by how much its weights say
 * they gained, and the gateway keeps that order. Any ranking made here would
 * be a second opinion on the same question — a lexicographic one put a class
 * spared one floor above a teacher spared twenty rooms — and the list would
 * then disagree with the totals it sits under.
 */
function mostImproved(walkers: RoomProposal["walkers"]): RoomProposal["walkers"] {
  return walkers
    .filter((walker) => {
      const gains = DIMENSIONS.map(({ key }) => walker.before[key] - walker.after[key]);
      return gains.every((gain) => gain >= 0) && gains.some((gain) => gain > 0);
    })
    .slice(0, MOST_IMPROVED);
}

function BeforeAfter({ before, after }: { before: number; after: number }) {
  return (
    <span
      className={cn(
        "tabular-nums",
        after < before && "font-medium text-emerald-700",
        after > before && "font-medium text-red-700",
      )}
    >
      {before} → {after}
    </span>
  );
}

export interface RoomOptimizationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  academicYearId: string | null;
  /** The page's room list — read for the floor hint before any proposal exists. */
  rooms: readonly Room[];
  /**
   * The page's own lists, which is where every name comes from. The proposal
   * carries ids only: names never cross to the engine, and resolving them here
   * keeps them out of anything the gateway computes or stores.
   */
  teachers: ReadonlyArray<Pick<Person, "id" | "firstName" | "lastName">>;
  groups: ReadonlyArray<{ id: string; name: string }>;
  /** Called after an apply and after its undo — each rewrote rooms under the page. */
  onApplied: () => void;
}

/**
 * Salsoptimering: the rooms of the grundschema re-dealt so that people walk
 * less, with times held fixed.
 *
 * Two steps, because the change touches lessons the admin is not looking at:
 * first who should be spared the walk, then what the proposal would do —
 * counted before and after — and only then a write. The write is undoable
 * from its toast by sending the same moves back.
 */
export function RoomOptimizationDialog({
  open,
  onOpenChange,
  academicYearId,
  rooms,
  teachers,
  groups,
  onApplied,
}: RoomOptimizationDialogProps) {
  const t = useTranslations("roomOptimization");
  const tCommon = useTranslations("common");
  const { propose, apply } = useRoomOptimization();
  const [walkers, setWalkers] = useState<RoomWalkers>("TEACHERS");
  const [proposal, setProposal] = useState<RoomProposal | null>(null);
  /*
   * Which ask an answer belongs to. Closing the dialog abandons the ask in
   * flight, but the solve goes on and resolves later into a component that is
   * still mounted — the page keeps it, only the content unmounts. Without this
   * the late answer lands in `proposal` after the close cleared it, and the
   * next open offers a stale proposal to apply.
   */
  const ask = useRef(0);

  const nameOf = useMemo(() => {
    const teacherNames = new Map(
      teachers.map((teacher) => [teacher.id, `${teacher.firstName} ${teacher.lastName}`]),
    );
    const groupNames = new Map(groups.map((group) => [group.id, group.name]));
    return (walker: { kind: "TEACHER" | "GROUP"; id: string }) =>
      (walker.kind === "TEACHER" ? teacherNames.get(walker.id) : groupNames.get(walker.id)) ??
      "?";
  }, [teachers, groups]);

  const roomsWithoutFloor = rooms.filter((room) => room.floor === null).length;

  const errorMessage = (error: unknown) =>
    error instanceof Error ? error.message : tCommon("error");

  const changeOpen = (next: boolean) => {
    // A proposal is an answer about the schedule as it was when it was asked.
    // Reopening later must ask again, not offer the old answer to apply — and
    // that includes an answer still on its way.
    if (!next) {
      ask.current += 1;
      setProposal(null);
    }
    onOpenChange(next);
  };

  const compute = async () => {
    if (!academicYearId) return;
    const mine = ++ask.current;
    try {
      const answer = await propose.mutateAsync({ academicYearId, walkers });
      if (mine === ask.current) setProposal(answer);
    } catch (error) {
      // An abandoned ask has nobody left to tell.
      if (mine === ask.current) toast.error(errorMessage(error));
    }
  };

  /**
   * The same moves sent back, against the basis the apply returned.
   *
   * A 409 here means somebody changed the schedule after the optimisation —
   * any reason, stale or clash — and reversing blind would undo their change
   * too. The version the apply saved is the way back, so that is what the
   * toast names.
   */
  const undo = async (yearId: string, moves: RoomMove[], applied: RoomApplyResult) => {
    try {
      await apply.mutateAsync({
        academicYearId: yearId,
        basis: applied.basis,
        changes: moves.map((move) => ({
          lessonId: move.lessonId,
          fromRoomId: move.toRoomId,
          toRoomId: move.fromRoomId,
        })),
      });
      onApplied();
      toast.success(t("undone"));
    } catch (error) {
      toast.error(
        error instanceof ApiError && error.status === 409 ? t("undoStale") : errorMessage(error),
      );
    }
  };

  const doApply = async () => {
    if (!proposal || !academicYearId) return;
    const moves = proposal.changes;
    try {
      const result = await apply.mutateAsync({
        academicYearId,
        basis: proposal.basis,
        changes: moves,
      });
      onApplied();
      changeOpen(false);
      toast.success(t("applied", { count: result.updated }), {
        // Said only when it happened: most schools optimise before they
        // publish, and "0 calendar lessons" would only raise the question.
        ...(result.calendarUpdated > 0
          ? { description: t("calendarUpdated", { count: result.calendarUpdated }) }
          : {}),
        duration: UNDO_TOAST_MS,
        action: {
          label: t("undo"),
          onClick: () => void undo(academicYearId, moves, result),
        },
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        // Either the schedule moved since the proposal was read, or the moves
        // would now clash. Both make this proposal unappliable, so the way on
        // is the same: back to step one and compute again.
        toast.error(error.code === STALE ? t("stale") : error.message);
        setProposal(null);
        return;
      }
      toast.error(errorMessage(error));
    }
  };

  const floorHint = (missing: number, total: number) =>
    missing > 0 && total > 0 ? (
      <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
        <Info className="mt-0.5 size-4 shrink-0 text-amber-600" />
        <div className="space-y-1">
          <p>{t("floorsMissing", { missing, total })}</p>
          <Link href="/admin/rooms" className="font-medium underline underline-offset-4">
            {t("floorsMissingLink")}
          </Link>
        </div>
      </div>
    ) : null;

  const improved = proposal ? mostImproved(proposal.walkers) : [];
  const showWishes =
    proposal !== null && (proposal.missedWishes.before > 0 || proposal.missedWishes.after > 0);

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("body")}</DialogDescription>
        </DialogHeader>

        {proposal === null ? (
          <>
            <fieldset className="space-y-2" disabled={propose.isPending}>
              <legend className="mb-2 text-sm font-medium">{t("walkersLabel")}</legend>
              <div className="flex flex-wrap gap-2">
                {WALKER_CHOICES.map((choice) => (
                  <label
                    key={choice.value}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm",
                      walkers === choice.value && "border-primary bg-primary/5",
                    )}
                  >
                    <input
                      type="radio"
                      name="room-walkers"
                      value={choice.value}
                      checked={walkers === choice.value}
                      onChange={() => setWalkers(choice.value)}
                      className="accent-primary"
                    />
                    {t(choice.label)}
                  </label>
                ))}
              </div>
            </fieldset>
            <p className="text-sm text-muted-foreground">{t("unchanged")}</p>
            {floorHint(roomsWithoutFloor, rooms.length)}
            <DialogFooter className="flex-wrap gap-2">
              <Button variant="outline" onClick={() => changeOpen(false)}>
                {tCommon("cancel")}
              </Button>
              <Button onClick={() => void compute()} disabled={!academicYearId || propose.isPending}>
                {propose.isPending ? (
                  <>
                    <Loader2 className="animate-spin" />
                    {t("computing")}
                  </>
                ) : (
                  t("compute")
                )}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            {proposal.changes.length === 0 ? (
              <p className="text-sm font-medium">{t("nothingToDo")}</p>
            ) : (
              <p className="text-sm font-medium">{t("moves", { count: proposal.changes.length })}</p>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="py-1 pr-3 font-medium">{t("who")}</th>
                    {[...DIMENSIONS].reverse().map((dimension) => (
                      <th key={dimension.key} className="py-1 pr-3 font-medium">
                        {t(dimension.label)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ["rowTeachers", proposal.teachers],
                      ["rowGroups", proposal.groups],
                    ] as const
                  ).map(([label, walk]) => (
                    <tr key={label} className="border-t">
                      <th scope="row" className="py-1.5 pr-3 text-left font-medium">
                        {t(label)}
                      </th>
                      {[...DIMENSIONS].reverse().map((dimension) => (
                        <td key={dimension.key} className="py-1.5 pr-3">
                          <BeforeAfter
                            before={walk.before[dimension.key]}
                            after={walk.after[dimension.key]}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                  {showWishes ? (
                    <tr className="border-t">
                      <th scope="row" className="py-1.5 pr-3 text-left font-medium">
                        {t("missedWishes")}
                      </th>
                      <td className="py-1.5 pr-3" colSpan={DIMENSIONS.length}>
                        <BeforeAfter
                          before={proposal.missedWishes.before}
                          after={proposal.missedWishes.after}
                        />
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            {improved.length > 0 ? (
              <div className="space-y-1">
                <h4 className="text-sm font-medium">{t("mostImproved")}</h4>
                <ul className="space-y-1 text-sm" aria-label={t("mostImproved")}>
                  {improved.map((walker) => (
                    <li key={`${walker.kind}:${walker.id}`} className="flex flex-wrap gap-x-3">
                      <span className="font-medium">{nameOf(walker)}</span>
                      {DIMENSIONS.filter(
                        ({ key }) => walker.before[key] !== walker.after[key],
                      ).map(({ key, label }) => (
                        <span key={key} className="text-muted-foreground">
                          {t(label)}{" "}
                          <BeforeAfter before={walker.before[key]} after={walker.after[key]} />
                        </span>
                      ))}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {proposal.frozenLessonIds.length > 0 ? (
              <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
                {t("frozen", { count: proposal.frozenLessonIds.length })}
              </p>
            ) : null}

            {floorHint(proposal.roomsWithoutFloor, proposal.roomsTotal)}

            {proposal.changes.length > 0 ? (
              <p className="text-xs text-muted-foreground">{t("calendarNote")}</p>
            ) : null}

            <DialogFooter className="flex-wrap gap-2">
              {proposal.changes.length === 0 ? (
                <Button onClick={() => changeOpen(false)}>{tCommon("close")}</Button>
              ) : (
                <>
                  <Button
                    variant="outline"
                    onClick={() => setProposal(null)}
                    disabled={apply.isPending}
                  >
                    {t("back")}
                  </Button>
                  <Button onClick={() => void doApply()} disabled={apply.isPending}>
                    {apply.isPending ? <Loader2 className="animate-spin" /> : null}
                    {t("apply")}
                  </Button>
                </>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
