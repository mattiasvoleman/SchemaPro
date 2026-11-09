import type { LessonRecurrence, PrismaClient } from '@prisma/client';
import { requirementPlacementsConflict } from '../common/utils/prisma-errors';
import { followPlacements, type FollowedRow, type PlacementPost, type PlacementsFollow } from './placement-fit';

/*
 * DELADE LEKTIONER: A CHANGE OF A POST'S TEACHERS AND ITS FÖRLÄGGNINGAR
 * (migration 20270208090000, placement-fit.ts followPlacements).
 *
 * Every writer that changes who teaches which of a post's lessons — the
 * requirements PATCH (the post's dialog, the tillsättning's panel, Byt lärare),
 * the staffing proposal's apply and undo, the requirements import — writes the
 * post and its shares first, as it always did, and then carries the post's
 * förläggningar along with carryPlacementTeachers: each teacher who stays
 * keeps theirs, one teacher out and one in with the same lessons hands them
 * over, and anything else is refused by naming the förläggning that has to be
 * changed first (409 REQUIREMENT_PLACEMENTS_DO_NOT_FIT, params reason, day,
 * start, end, weeks). The rows move in the same transaction, after the shares,
 * so that the database's rules per teacher (deferred to the end of the
 * transaction) are judged on the post as the write leaves it — and they are
 * asked for at the end of the step (judgePlacementTeachersNow), so that what
 * the database refuses is a statement, never a COMMIT.
 *
 * A post that shares nothing before and after is not touched here at all, and
 * the step costs a school without förläggningar one indexed read.
 */

/** A post's förläggning as a change of its teachers reads it. */
export interface StoredPlacement extends FollowedRow {
  requirementId: string;
  dayOfWeek: number;
  /** TIME(0), midnight UTC. */
  startTime: Date;
}

/** One post's change: as stored, and as the write leaves it. */
export interface PostTeachersChange {
  requirementId: string;
  before: PlacementPost;
  after: PlacementPost;
}

/** The three deferred constraint triggers of 20270208090000, by name: never ALL (SS12000's flush is deferred too). */
export const PLACEMENT_TEACHER_CONSTRAINTS = [
  'TeachingRequirementPlacements_teachers_fit',
  'TeachingRequirementShares_placement_teachers_fit',
  'TeachingRequirements_placement_teachers_fit',
] as const;

const minutesOfClock = (time: Date): number => time.getUTCHours() * 60 + time.getUTCMinutes();
const pad = (value: number): string => String(value).padStart(2, '0');
// placement-judge.ts's clockText, written out here: this file is imported by the requirements service, and a
// second path from it into the judge's imports (calendar, swaps) is how #293's HÖG-1 import cycle began.
const clockText = (minutes: number): string => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

/** The förläggningar of these posts, by post, in a stable order (day, clock, weeks, id). */
export async function placementsOfPosts(
  tx: PrismaClient,
  requirementIds: readonly string[],
): Promise<Map<string, StoredPlacement[]>> {
  const byPost = new Map<string, StoredPlacement[]>();
  if (requirementIds.length === 0) return byPost;
  const rows = await tx.teachingRequirementPlacement.findMany({
    where: { requirementId: { in: [...new Set(requirementIds)] } },
    select: { id: true, requirementId: true, teacherId: true, dayOfWeek: true, startTime: true, minutes: true, recurrence: true },
    orderBy: [{ requirementId: 'asc' }, { dayOfWeek: 'asc' }, { startTime: 'asc' }, { recurrence: 'asc' }, { id: 'asc' }],
  });
  for (const row of rows) {
    const list = byPost.get(row.requirementId);
    if (list) list.push(row);
    else byPost.set(row.requirementId, [row]);
  }
  return byPost;
}

/**
 * The 409 that names the förläggning a change has to wait for
 * (followPlacements' refusal), and its post: a write of many posts at once
 * (the staffing proposal) says which. A förläggning that names nobody on a
 * shared post (its teacher was removed; followPlacements says it) can only be
 * removed, and the sentence says so.
 */
export function placementFollowRefusal(refusal: Extract<PlacementsFollow, { ok: false }>, requirementId: string) {
  const row = refusal.row as StoredPlacement;
  const start = minutesOfClock(row.startTime);
  return requirementPlacementsConflict(refusal.reason, {
    placement: {
      dayOfWeek: row.dayOfWeek,
      start: clockText(start),
      end: clockText(start + row.minutes),
      recurrence: row.recurrence as LessonRecurrence,
    },
    requirementId,
    unstaffed: refusal.unstaffed,
  });
}

/** The refusal's Swedish sentence, for a writer that reports it in a sentence of its own (the import's row). */
export function placementFollowSentence(refusal: Extract<PlacementsFollow, { ok: false }>, requirementId: string): string {
  const body = placementFollowRefusal(refusal, requirementId).getResponse() as { message: string };
  return body.message;
}

/**
 * What the changes do to the förläggningar, without writing: the rows to move
 * (and to whom), or the first refusal. For a writer that reports a refusal its
 * own way (the import names the file's row).
 */
export function followOfChanges(
  changes: readonly PostTeachersChange[],
  placements: ReadonlyMap<string, readonly StoredPlacement[]>,
): { moves: { id: string; teacherId: string | null }[] } | { refused: Extract<PlacementsFollow, { ok: false }>; requirementId: string } {
  const moves: { id: string; teacherId: string | null }[] = [];
  for (const change of changes) {
    const rows = placements.get(change.requirementId) ?? [];
    const follow = followPlacements(change.before, change.after, rows);
    if (!follow.ok) return { refused: follow, requirementId: change.requirementId };
    moves.push(...follow.moves);
  }
  return { moves };
}

/** Writes the moves: one statement per new teacher, and none for a school with nothing to move. */
export async function moveTeachers(
  tx: PrismaClient,
  moves: readonly { id: string; teacherId: string | null }[],
): Promise<void> {
  const byTeacher = new Map<string | null, string[]>();
  for (const move of moves) {
    const list = byTeacher.get(move.teacherId);
    if (list) list.push(move.id);
    else byTeacher.set(move.teacherId, [move.id]);
  }
  for (const [teacherId, ids] of byTeacher) {
    await tx.teachingRequirementPlacement.updateMany({ where: { id: { in: ids } }, data: { teacherId } });
  }
}

/**
 * Asks the database for its rules per teacher now (SET CONSTRAINTS … IMMEDIATE
 * by name), so that a refusal is FP409 on this statement and not on the
 * COMMIT, and puts them back to the end of the transaction for anything
 * written after.
 */
export async function judgePlacementTeachersNow(tx: PrismaClient): Promise<void> {
  await tx.$executeRaw`SET CONSTRAINTS "TeachingRequirementPlacements_teachers_fit", "TeachingRequirementShares_placement_teachers_fit", "TeachingRequirements_placement_teachers_fit" IMMEDIATE`;
  await tx.$executeRaw`SET CONSTRAINTS "TeachingRequirementPlacements_teachers_fit", "TeachingRequirementShares_placement_teachers_fit", "TeachingRequirements_placement_teachers_fit" DEFERRED`;
}

/**
 * The whole step, after the post and its shares are written: read the posts'
 * förläggningar, carry them along or refuse with the one to change first, move
 * them, and have the database judge. A change whose post shares nothing
 * before and after reads nothing.
 */
export async function carryPlacementTeachers(tx: PrismaClient, changes: readonly PostTeachersChange[]): Promise<void> {
  const relevant = changes.filter(
    (change) => (change.before.shares ?? []).length > 0 || (change.after.shares ?? []).length > 0,
  );
  if (relevant.length === 0) return;
  const placements = await placementsOfPosts(
    tx,
    relevant.map((change) => change.requirementId),
  );
  if (placements.size === 0) return;
  const follow = followOfChanges(relevant, placements);
  if ('refused' in follow) throw placementFollowRefusal(follow.refused, follow.requirementId);
  await moveTeachers(tx, follow.moves);
  await judgePlacementTeachersNow(tx);
}
