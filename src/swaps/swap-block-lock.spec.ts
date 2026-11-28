import { lessonsLeftUnlockedByBlock } from './swap-block-lock';
import type { SwapData } from './swap-snapshot';

type Data = Pick<SwapData, 'lessons' | 'posts' | 'blocks'>;

const lesson = (id: string, group: string, subject: string, isLocked = false) =>
  ({ id, studentGroupId: group, subjectId: subject, isLocked }) as unknown as Data['lessons'][number];
const post = (group: string, subject: string, blockId: string | null) =>
  ({ studentGroupId: group, subjectId: subject, blockId }) as unknown as Data['posts'][number];

/** Språk A (7A) and Språk B (8B), one block, two cards: a1+b1 and a2+b2. And a plain lesson p. */
const world = (over: Partial<Data> = {}): Data => ({
  lessons: [lesson('a1', '7A', 'A'), lesson('b1', '8B', 'B'), lesson('a2', '7A', 'A'), lesson('b2', '8B', 'B'), lesson('p', '7A', 'Mat')],
  posts: [post('7A', 'A', 'blk'), post('8B', 'B', 'blk'), post('7A', 'Mat', null)],
  blocks: [{ id: 'blk', sameTimesAsBlockId: null }],
  ...over,
});
const ids = (...values: string[]) => new Set(values);

describe('lessonsLeftUnlockedByBlock (a swap locks what it moves, but not into a partly locked block)', () => {
  it('leaves the moved card of a block with another card unlocked: Generera refuses a partly locked block', () => {
    expect(lessonsLeftUnlockedByBlock(world(), ids('a1', 'b1', 'p'))).toEqual(ids('a1', 'b1'));
  });

  it('locks a block whose lessons all move in the swap', () => {
    expect(lessonsLeftUnlockedByBlock(world(), ids('a1', 'b1', 'a2', 'b2'))).toEqual(ids());
  });

  it('locks the moved card when the block\'s other lessons are locked already', () => {
    const data = world();
    data.lessons = data.lessons.map((l) => (l.id === 'a2' || l.id === 'b2' ? { ...l, isLocked: true } : l));
    expect(lessonsLeftUnlockedByBlock(data, ids('a1', 'b1'))).toEqual(ids());
  });

  it('is not moved by a lesson that is no block\'s', () => {
    expect(lessonsLeftUnlockedByBlock(world(), ids('p'))).toEqual(ids());
  });

  it('treats a post alone in its block as no block: its lessons are locked as any lesson is', () => {
    const data = world({ posts: [post('7A', 'A', 'blk'), post('7A', 'Mat', null)], blocks: [{ id: 'blk', sameTimesAsBlockId: null }] });
    expect(lessonsLeftUnlockedByBlock(data, ids('a1'))).toEqual(ids());
  });

  it('judges two blocks on the same times together: the follower\'s other lessons count for the leader', () => {
    const data: Data = {
      lessons: [lesson('l1', '7A', 'A'), lesson('l2', '8B', 'B'), lesson('f1', '7A', 'C'), lesson('f2', '8B', 'D')],
      posts: [post('7A', 'A', 'lead'), post('8B', 'B', 'lead'), post('7A', 'C', 'follow'), post('8B', 'D', 'follow')],
      blocks: [
        { id: 'lead', sameTimesAsBlockId: null },
        { id: 'follow', sameTimesAsBlockId: 'lead' },
      ],
    };
    // The leader's card moves, the follower's lessons stay unlocked: left unlocked. Both blocks move: locked.
    expect(lessonsLeftUnlockedByBlock(data, ids('l1', 'l2'))).toEqual(ids('l1', 'l2'));
    expect(lessonsLeftUnlockedByBlock(data, ids('l1', 'l2', 'f1', 'f2'))).toEqual(ids());
    // A block of one post on the times of another is a block here, whatever its size.
    const single: Data = {
      lessons: [lesson('s1', '7A', 'A'), lesson('t1', '7A', 'C')],
      posts: [post('7A', 'A', 'lead'), post('7A', 'C', 'follow')],
      blocks: [
        { id: 'lead', sameTimesAsBlockId: null },
        { id: 'follow', sameTimesAsBlockId: 'lead' },
      ],
    };
    expect(lessonsLeftUnlockedByBlock(single, ids('s1'))).toEqual(ids('s1'));
  });
});
