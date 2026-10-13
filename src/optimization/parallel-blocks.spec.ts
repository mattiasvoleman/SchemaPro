import { judgeBlocks, partlyLockedRefusal } from './parallel-blocks';

describe('judgeBlocks', () => {
  const rows = [
    { id: 'ty', blockId: 'b' },
    { id: 'fr', blockId: 'b' },
    { id: 'sv', blockId: null },
  ];
  const remaining = (left: Record<string, number>) => (id: string) => left[id] ?? 0;
  const locked = (held: Record<string, number>) => (id: string) => held[id] ?? 0;

  it('sends a block of two with every lesson to place and none locked', () => {
    expect(judgeBlocks(rows, remaining({ ty: 2, fr: 2, sv: 3 }), locked({}))).toEqual({
      sent: new Set(['b']),
      partlyLocked: [],
    });
  });

  it('refuses a block with a lesson locked while lessons are left, naming every member', () => {
    expect(judgeBlocks(rows, remaining({ ty: 1, fr: 2 }), locked({ ty: 1 }))).toEqual({
      sent: new Set(),
      partlyLocked: [{ blockId: 'b', memberIds: ['ty', 'fr'], locked: 1 }],
    });
  });

  it('counts a lock that cancels no demand: its member still has its lessons to place', () => {
    expect(judgeBlocks(rows, remaining({ ty: 2, fr: 2 }), locked({ fr: 1 })).partlyLocked).toEqual([
      { blockId: 'b', memberIds: ['ty', 'fr'], locked: 1 },
    ]);
  });

  it('leaves a block whose every lesson is locked alone: nothing to place, nothing to refuse', () => {
    expect(judgeBlocks(rows, remaining({}), locked({ ty: 2, fr: 2 }))).toEqual({
      sent: new Set(),
      partlyLocked: [],
    });
  });

  it('sends a block of one member nothing', () => {
    expect(
      judgeBlocks([{ id: 'ty', blockId: 'b' }, { id: 'sv' }], remaining({ ty: 2, sv: 3 }), locked({})).sent,
    ).toEqual(new Set());
  });
});

describe('partlyLockedRefusal', () => {
  it('is an analysis with the catalogue’s codes, one line per block, in the ids it was given', () => {
    const refusal = partlyLockedRefusal([
      { block: 'B1', members: ['R1', 'R2'], locked: 1 },
      { block: 'B2', members: ['R3', 'R4'], locked: 3 },
    ]);

    expect(refusal.summaryCode).toBe('BLOCK_PARTLY_LOCKED_SUMMARY');
    expect(refusal.summaryParams).toEqual({ count: 2 });
    expect(refusal.summary).toMatch(/^2 blocks have lessons locked/);
    expect(refusal.conflicts.map((detail) => [detail.code, detail.params, detail.resourceIds])).toEqual([
      ['BLOCK_PARTLY_LOCKED', { block: 'B1', locked: 1 }, ['B1']],
      ['BLOCK_PARTLY_LOCKED', { block: 'B2', locked: 3 }, ['B2']],
    ]);
    expect(refusal.conflicts[1]!.message).toBe(
      "B2 has 3 lessons locked or placed by hand while the rest of it is still to be placed. Unlock the block's lessons, or lock all of them.",
    );
    expect(refusal.conflicts[0]!.category).toBe('TEACHING_BLOCK');
  });
});
