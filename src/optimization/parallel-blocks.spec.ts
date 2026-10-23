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
      lockedApart: [],
      mirrored: new Map(),
    });
  });

  it('refuses a block with a lesson locked while lessons are left, naming every member', () => {
    expect(judgeBlocks(rows, remaining({ ty: 1, fr: 2 }), locked({ ty: 1 }))).toEqual({
      sent: new Set(),
      partlyLocked: [{ blockId: 'b', memberIds: ['ty', 'fr'], locked: 1 }],
      lockedApart: [],
      mirrored: new Map(),
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
      lockedApart: [],
      mirrored: new Map(),
    });
  });

  it('treats a lock on a block of one member as any post\'s lock: neither sent nor refused', () => {
    const alone = [{ id: 'ty', blockId: 'b' }, { id: 'sv', blockId: null }];

    expect(judgeBlocks(alone, remaining({ ty: 1, sv: 3 }), locked({ ty: 1 }))).toEqual({
      sent: new Set(),
      partlyLocked: [],
      lockedApart: [],
      mirrored: new Map(),
    });
  });

  it('sends a block of one member nothing', () => {
    expect(
      judgeBlocks([{ id: 'ty', blockId: 'b' }, { id: 'sv' }], remaining({ ty: 2, sv: 3 }), locked({})).sent,
    ).toEqual(new Set());
  });

  describe('two blocks on the same times (a term split: the spring on the autumn)', () => {
    // ht holds 7A:1 textil and 7A:2 trä in the autumn, vt the swap in the spring.
    const terms = [
      { id: 'ht1', blockId: 'ht' },
      { id: 'ht2', blockId: 'ht' },
      { id: 'vt1', blockId: 'vt' },
      { id: 'vt2', blockId: 'vt' },
      { id: 'sv', blockId: null },
    ];
    const link = { leaderBlockId: 'ht', followerBlockId: 'vt' };
    const all = { ht1: 2, ht2: 2, vt1: 2, vt2: 2, sv: 3 };

    it('sends the autumn block and mirrors the spring, when both have every lesson to place', () => {
      expect(judgeBlocks(terms, remaining(all), locked({}), [link])).toEqual({
        sent: new Set(['ht']),
        partlyLocked: [],
        lockedApart: [],
        mirrored: new Map([['vt', link]]),
      });
    });

    it('places neither when the school locked both', () => {
      expect(
        judgeBlocks(terms, remaining({ sv: 3 }), locked({ ht1: 2, ht2: 2, vt1: 2, vt2: 2 }), [link]),
      ).toEqual({ sent: new Set(), partlyLocked: [], lockedApart: [], mirrored: new Map() });
    });

    it('refuses the two by name when one is locked and the other has all its lessons to place, either way round', () => {
      expect(
        judgeBlocks(terms, remaining({ vt1: 2, vt2: 2 }), locked({ ht1: 2, ht2: 2 }), [link]).lockedApart,
      ).toEqual([{ blockId: 'ht', otherBlockId: 'vt', memberIds: ['ht1', 'ht2', 'vt1', 'vt2'], locked: 4 }]);
      const springLocked = judgeBlocks(terms, remaining({ ht1: 2, ht2: 2 }), locked({ vt1: 1, vt2: 2 }), [link]);
      expect(springLocked.lockedApart).toEqual([
        { blockId: 'vt', otherBlockId: 'ht', memberIds: ['vt1', 'vt2', 'ht1', 'ht2'], locked: 3 },
      ]);
      expect([springLocked.sent, springLocked.mirrored, springLocked.partlyLocked]).toEqual([new Set(), new Map(), []]);
    });

    it('refuses a partly locked one as partly locked, and mirrors nothing', () => {
      const judged = judgeBlocks(terms, remaining({ ...all, ht1: 1 }), locked({ ht1: 1 }), [link]);
      expect(judged.partlyLocked).toEqual([{ blockId: 'ht', memberIds: ['ht1', 'ht2'], locked: 1 }]);
      expect([judged.sent, judged.mirrored, judged.lockedApart]).toEqual([new Set(), new Map(), []]);
    });

    it('judges a linked block of one member as a block: its partial lock decides the other\'s times', () => {
      const single = [
        { id: 'ht1', blockId: 'ht' },
        { id: 'vt1', blockId: 'vt' },
      ];
      expect(judgeBlocks(single, remaining({ ht1: 1, vt1: 2 }), locked({ ht1: 1 }), [link]).partlyLocked).toEqual([
        { blockId: 'ht', memberIds: ['ht1'], locked: 1 },
      ]);
      // Both open: mirrored, and the leader of one sent with no blockId.
      const open = judgeBlocks(single, remaining({ ht1: 2, vt1: 2 }), locked({}), [link]);
      expect([open.sent, open.mirrored]).toEqual([new Set(), new Map([['vt', link]])]);
    });

    it('ignores a link to a block with no row this year: the block is judged on its own', () => {
      const lone = terms.filter((row) => row.blockId !== 'ht');
      expect(judgeBlocks(lone, remaining(all), locked({}), [link])).toEqual({
        sent: new Set(['vt']),
        partlyLocked: [],
        lockedApart: [],
        mirrored: new Map(),
      });
    });
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

  it('says two blocks on the same times, one locked, as its own line under the same summary', () => {
    const refusal = partlyLockedRefusal([
      { block: 'HT', other: 'VT', members: ['R1', 'R2', 'R3', 'R4'], locked: 4 },
    ]);

    expect(refusal.summaryCode).toBe('BLOCK_PARTLY_LOCKED_SUMMARY');
    expect(refusal.summaryParams).toEqual({ count: 1 });
    expect(refusal.conflicts.map((detail) => [detail.code, detail.params, detail.resourceIds, detail.requirementIds])).toEqual([
      ['BLOCK_SAME_TIMES_PARTLY_LOCKED', { block: 'HT', other: 'VT', locked: 4 }, ['HT', 'VT'], ['R1', 'R2', 'R3', 'R4']],
    ]);
    expect(refusal.conflicts[0]!.message).toBe(
      'HT has 4 lessons locked or placed by hand, while VT, which takes the same times in other weeks, still has ' +
        'all of its lessons to place. Lock the two blocks together, or unlock HT.',
    );
  });
});
