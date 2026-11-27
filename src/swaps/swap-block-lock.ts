import type { SwapData } from './swap-snapshot';

/*
 * THE LOCK A SWAP DOES NOT PUT ON A PARALLEL BLOCK'S LESSONS (E4, beslut 2, g505 M-1).
 *
 * A swap locks the lessons it moves, so that the next Generera keeps them where the hand put them. A block is the exception that proves the
 * rule's other half: Generera refuses a block with some of its lessons locked while the rest are still to be placed (BLOCK_PARTLY_LOCKED,
 * parallel-blocks.ts), because a block's lessons are placed together. A swap moves one card of a block (a lesson of each member at one
 * slot) and leaves the block's other cards where they stand and unlocked; locking the moved card would make the next Generera a refusal.
 *
 * So a lesson of a block is locked by a swap only when every placed lesson of the block (and of a block on the same times, which the
 * generation takes as one) is locked already or moves in the same swap. Otherwise it is left as it was, and Generera lays the block again
 * as it did before the lock came; a block is placed by hand with its card (PATCH master-lessons/block-card), which locks the block whole.
 * A block of one member is no block to the generation (judgeBlocks), so its lessons are locked as any lesson is.
 *
 * Pure: the snapshot's own relations (the posts' blockId and the blocks' times link).
 */
export function lessonsLeftUnlockedByBlock(
  data: Pick<SwapData, 'lessons' | 'posts' | 'blocks'>,
  movedIds: ReadonlySet<string>,
): Set<string> {
  const blockOfPost = new Map(data.posts.map((post) => [`${post.studentGroupId}:${post.subjectId}`, post.blockId]));
  const blockOf = (lesson: { studentGroupId: string; subjectId: string }): string | null =>
    blockOfPost.get(`${lesson.studentGroupId}:${lesson.subjectId}`) ?? null;
  const takesTimesOf = new Map(data.blocks.map((block) => [block.id, block.sameTimesAsBlockId]));
  /** The block and the blocks tied to it by their times: the generation judges them together. */
  const familyOf = (blockId: string): Set<string> => {
    const family = new Set([blockId]);
    const leader = takesTimesOf.get(blockId);
    if (leader) family.add(leader);
    for (const [id, follows] of takesTimesOf) if (follows === blockId) family.add(id);
    return family;
  };

  const left = new Set<string>();
  const judged = new Set<string>();
  for (const lesson of data.lessons) {
    if (!movedIds.has(lesson.id)) continue;
    const blockId = blockOf(lesson);
    if (blockId === null || judged.has(blockId)) continue;
    const family = familyOf(blockId);
    for (const id of family) judged.add(id);
    const members = data.posts.filter((post) => post.blockId !== null && family.has(post.blockId)).length;
    // One member and no linked block: no block for the generation, a lock on it is any lesson's lock.
    if (family.size === 1 && members < 2) continue;
    const ofFamily = data.lessons.filter((candidate) => {
      const candidateBlock = blockOf(candidate);
      return candidateBlock !== null && family.has(candidateBlock);
    });
    if (ofFamily.every((candidate) => candidate.isLocked || movedIds.has(candidate.id))) continue;
    for (const candidate of ofFamily) if (movedIds.has(candidate.id)) left.add(candidate.id);
  }
  return left;
}
