import {
  BLOCK_MEMBERS_SHARE_TEACHER,
  BLOCK_SAME_TIMES_DIFFER,
  BLOCK_SAME_TIMES_SPLIT_LESSONS,
  BLOCK_SAME_TIMES_TEACHERS,
  mirrorLessons,
  pairLessons,
  planMirror,
  sameTimesLinks,
  type Mirror,
  type SameTimesRow,
} from './same-times';

const SPRING = new Date('2027-01-11T00:00:00Z');
const AUTUMN_END = new Date('2027-01-10T00:00:00Z');

/** A term split of 7A's slöjd: textil (tx) and trä (tr) on the halves h1 and h2. */
function post(id: string, subjectId: string, studentGroupId: string, term: 'HT' | 'VT', teacherId: string | null): SameTimesRow {
  return {
    id,
    subjectId,
    studentGroupId,
    teacherId,
    coTeacherId: null,
    lessonsPerWeek: 2,
    minutesPerLesson: 60,
    lessonLengths: [],
    recurrence: 'ALL_WEEKS',
    startDate: term === 'HT' ? null : SPRING,
    endDate: term === 'HT' ? AUTUMN_END : null,
  };
}

// The autumn: h1 textil with Tove, h2 trä with Tor. The spring: the swap.
const autumn = [post('a1', 'tx', 'h1', 'HT', 'tove'), post('a2', 'tr', 'h2', 'HT', 'tor')];
const spring = [post('s1', 'tr', 'h1', 'VT', 'tor'), post('s2', 'tx', 'h2', 'VT', 'tove')];

describe('sameTimesLinks', () => {
  it('links a block to the block it names, when both hold a row of the year', () => {
    expect(
      sameTimesLinks([
        { id: 'ht', sameTimesAsBlockId: null },
        { id: 'vt', sameTimesAsBlockId: 'ht' },
        { id: 'sprak', sameTimesAsBlockId: null },
        { id: 'orphan', sameTimesAsBlockId: 'gone' },
      ]),
    ).toEqual([{ leaderBlockId: 'ht', followerBlockId: 'vt' }]);
  });
});

describe('planMirror', () => {
  it('pairs each spring post with the autumn post in its subject, the other half in the same room', () => {
    const judged = planMirror(autumn, spring);
    expect(judged.ok).toBe(true);
    if (!judged.ok) return;
    expect(judged.plan.mirrors).toEqual([
      { leaderId: 'a2', followerId: 's1' },
      { leaderId: 'a1', followerId: 's2' },
    ]);
    // h1's two posts are a1 (autumn) and s1 (spring): a1 keeps s1's buffers.
    expect(judged.plan.sameGroup).toEqual(new Map([['a1', 's1'], ['a2', 's2']]));
    expect(judged.plan.sameSubject).toEqual(new Map([['a2', 's1'], ['a1', 's2']]));
    // The halves swap and the teachers stay: nobody new at the block's times.
    expect(judged.plan.adults).toEqual(
      new Map([
        ['a1', { teacherId: 'tove', coTeacherId: null }],
        ['a2', { teacherId: 'tor', coTeacherId: null }],
      ]),
    );
  });

  it('seats a spring teacher the autumn lacks beside the autumn post in the same subject', () => {
    const otherTextil = [spring[0]!, { ...spring[1]!, teacherId: 'tea' }];
    const judged = planMirror(autumn, otherTextil);
    expect(judged.ok && judged.plan.adults.get('a1')).toEqual({ teacherId: 'tove', coTeacherId: 'tea' });
  });

  it('seats them in another autumn post when the subject’s own is full, and in a teacherless one first-hand', () => {
    const full = [{ ...autumn[0]!, coTeacherId: 'cora' }, { ...autumn[1]!, teacherId: null }];
    const judged = planMirror(full, [spring[0]!, { ...spring[1]!, teacherId: 'tea' }]);
    expect(judged.ok && judged.plan.adults).toEqual(
      new Map([
        ['a1', { teacherId: 'tove', coTeacherId: 'cora' }],
        // tor (spring trä) is not at the autumn's times either: a2 had no teacher.
        ['a2', { teacherId: 'tor', coTeacherId: 'tea' }],
      ]),
    );
  });

  it('refuses spring teachers the autumn posts have no room for', () => {
    const full = autumn.map((row, index) => ({ ...row, coTeacherId: `co${index}` }));
    expect(planMirror(full, [spring[0]!, { ...spring[1]!, teacherId: 'tea' }])).toEqual({
      ok: false,
      code: BLOCK_SAME_TIMES_TEACHERS,
    });
  });

  it('refuses one teacher on both spring posts, naming the two, as the engine refuses a block', () => {
    expect(planMirror(autumn, [spring[0]!, { ...spring[1]!, teacherId: null, coTeacherId: 'tor' }])).toEqual({
      ok: false,
      code: BLOCK_MEMBERS_SHARE_TEACHER,
      requirementId: 's1',
      otherId: 's2',
    });
  });

  it.each([
    ['another subject in the spring', [spring[0]!, { ...spring[1]!, subjectId: 'bild' }]],
    ['another group in the spring', [spring[0]!, { ...spring[1]!, studentGroupId: '7B' }]],
    ['other lessons', [spring[0]!, { ...spring[1]!, lessonsPerWeek: 3 }]],
    ['other lengths', [spring[0]!, { ...spring[1]!, lessonLengths: [80, 40] }]],
    ['a post short', [spring[0]!]],
    ['weeks that meet', spring.map((row) => ({ ...row, startDate: new Date('2027-01-04T00:00:00Z') }))],
    ['every week of the year on both', spring.map((row) => ({ ...row, startDate: null, endDate: null }))],
  ])('refuses %s as two blocks that no longer fit together', (_, followers) => {
    expect(planMirror(autumn, followers as SameTimesRow[])).toEqual({ ok: false, code: BLOCK_SAME_TIMES_DIFFER });
  });

  it('accepts odd and even weeks in place of terms: they never meet either', () => {
    const odd = autumn.map((row) => ({ ...row, recurrence: 'ODD_WEEKS' as const, endDate: null }));
    const even = spring.map((row) => ({ ...row, recurrence: 'EVEN_WEEKS' as const, startDate: null }));
    expect(planMirror(odd, even).ok).toBe(true);
  });

  it('refuses a chain: the autumn block on a third block’s times', () => {
    expect(planMirror(autumn, spring, true)).toEqual({ ok: false, code: BLOCK_SAME_TIMES_DIFFER });
  });

  it('holds no class for a swap: both halves are on the leader’s posts already', () => {
    const judged = planMirror(
      autumn.map((row) => ({ ...row, halfOfId: '7A' })),
      spring.map((row) => ({ ...row, halfOfId: '7A' })),
    );
    expect(judged.ok && judged.plan.holdsClass).toEqual(new Map());
  });
});

describe('planMirror, one subject read by the halves in turn', () => {
  // Hemkunskap for 6.1: 6.1:1 reads it the first half of the autumn, 6.1:2
  // the second, each in a block of its own, the second on the first's times.
  const FIRST_END = new Date('2026-10-30T00:00:00Z');
  const SECOND_START = new Date('2026-11-02T00:00:00Z');
  const hk = (id: string, half: string, startDate: Date | null, endDate: Date | null, teacherId = 'hanna'): SameTimesRow => ({
    ...post(id, 'hk', half, 'HT', teacherId),
    lessonsPerWeek: 4,
    minutesPerLesson: 30,
    startDate,
    endDate,
    halfOfId: '6.1',
  });
  const first = hk('p1', '6.1:1', null, FIRST_END);
  const second = hk('p2', '6.1:2', SECOND_START, AUTUMN_END);

  it('writes the second half’s post at the first half’s times, the first sent as sat by the whole class', () => {
    const judged = planMirror([first], [second]);
    expect(judged.ok).toBe(true);
    if (!judged.ok) return;
    expect(judged.plan.mirrors).toEqual([{ leaderId: 'p1', followerId: 'p2' }]);
    // The class pairs with both halves: 6.1:2 has nothing else at those times.
    expect(judged.plan.holdsClass).toEqual(new Map([['p1', '6.1']]));
    // Its buffers, its room (the larger half) and its rule ride on p1.
    expect(judged.plan.sameGroup).toEqual(new Map([['p1', 'p2']]));
    expect(judged.plan.sameSubject).toEqual(new Map([['p1', 'p2']]));
    // One teacher, the two halves one after the other: nobody new to seat.
    expect(judged.plan.adults).toEqual(new Map([['p1', { teacherId: 'hanna', coTeacherId: null }]]));
  });

  it('seats another teacher of the second half beside the first, held all year as any follower’s', () => {
    const judged = planMirror([first], [{ ...second, teacherId: 'harald' }]);
    expect(judged.ok && judged.plan.adults).toEqual(new Map([['p1', { teacherId: 'hanna', coTeacherId: 'harald' }]]));
  });

  it('accepts half the autumn against half the spring: the weeks never meet', () => {
    const spring = hk('p2', '6.1:2', SPRING, new Date('2027-03-26T00:00:00Z'));
    expect(planMirror([first], [spring]).ok).toBe(true);
  });

  it.each([
    ['the halves of two classes', { ...second, halfOfId: '6.2', studentGroupId: '6.2:2' }],
    ['a class that is no half', { ...second, halfOfId: null, studentGroupId: '6.2' }],
    ['another subject', { ...second, subjectId: 'bild' }],
    ['other lessons', { ...second, lessonsPerWeek: 2 }],
    ['weeks that meet', { ...second, startDate: new Date('2026-10-26T00:00:00Z') }],
  ])('refuses %s', (_, follower) => {
    expect(planMirror([first], [follower as SameTimesRow])).toEqual({ ok: false, code: BLOCK_SAME_TIMES_DIFFER });
  });

  it('refuses a leader whose group is no half, though the follower is one', () => {
    expect(planMirror([{ ...first, halfOfId: null }], [second])).toEqual({ ok: false, code: BLOCK_SAME_TIMES_DIFFER });
  });

  it('refuses two posts on a side: only one post per period is a turn, more is a swap and needs the same halves', () => {
    const other = hk('p3', '6.1:2', null, FIRST_END);
    const leaders = [first, { ...other, subjectId: 'bild' }];
    const followers = [second, { ...second, id: 'p4', subjectId: 'bild', studentGroupId: '6.1:3' }];
    expect(planMirror(leaders, followers)).toEqual({ ok: false, code: BLOCK_SAME_TIMES_DIFFER });
  });
});

describe('mirrorLessons', () => {
  it('writes each leader lesson again for its follower, at the same day, clock and room', () => {
    const lessons = [
      { requirementId: 'a1', roomId: 'textilsal', dayOfWeek: 1, startTime: '09:00', endTime: '10:00' },
      { requirementId: 'sv', roomId: 'b12', dayOfWeek: 2, startTime: '08:00', endTime: '09:00' },
      { requirementId: null, roomId: null, dayOfWeek: 3, startTime: '08:00', endTime: '09:00' },
    ];
    expect(mirrorLessons(lessons, [{ leaderId: 'a1', followerId: 's2' }])).toEqual([
      ...lessons,
      { requirementId: 's2', roomId: 'textilsal', dayOfWeek: 1, startTime: '09:00', endTime: '10:00' },
    ]);
  });

  it('passes the lessons as they are when nothing is mirrored', () => {
    const lessons = [{ requirementId: 'a1' }];
    expect(mirrorLessons(lessons, [])).toEqual(lessons);
  });
});

/*
 * Delade lektioner on a pair of posts (same-times.ts, the header): hemkunskap
 * 7.1 HT and VT, each 1 x 90 with Anna and 1 x 40 with Bo, the halves in turn.
 */
describe('planMirror, delade lektioner', () => {
  const FIRST_END = new Date('2026-12-18T00:00:00Z');
  const SECOND_START = new Date('2027-01-11T00:00:00Z');
  /** Hemkunskap of 7.1: `lead` has the 90 and every lesson no share takes; `shares` are the lessons others take. */
  const hk = (
    id: string,
    half: string,
    term: 'HT' | 'VT',
    lead: string | null,
    shares: SameTimesRow['shares'],
    overrides: Partial<SameTimesRow> = {},
  ): SameTimesRow => ({
    id,
    subjectId: 'hk',
    studentGroupId: half,
    teacherId: lead,
    coTeacherId: null,
    lessonsPerWeek: 2,
    minutesPerLesson: 90,
    lessonLengths: [90, 40],
    recurrence: 'ALL_WEEKS',
    startDate: term === 'HT' ? null : SECOND_START,
    endDate: term === 'HT' ? FIRST_END : null,
    halfOfId: '7.1',
    ...(shares && shares.length > 0 ? { shares } : {}),
    ...overrides,
  });
  const BO_40 = [{ teacherId: 'bo', lessons: 1, minutes: 40 }];
  const leaderOf = (shares: SameTimesRow['shares'] = BO_40, overrides: Partial<SameTimesRow> = {}) =>
    hk('ht', '7.1:1', 'HT', 'anna', shares, overrides);
  const followerOf = (shares: SameTimesRow['shares'] = BO_40, overrides: Partial<SameTimesRow> = {}) =>
    hk('vt', '7.1:2', 'VT', 'anna', shares, overrides);
  const plan = (leaders: SameTimesRow[], followers: SameTimesRow[]) => {
    const judged = planMirror(leaders, followers);
    if (!judged.ok) throw new Error(`refused: ${judged.code}`);
    return judged.plan;
  };
  const refusal = (leaders: SameTimesRow[], followers: SameTimesRow[]) => {
    const judged = planMirror(leaders, followers);
    if (judged.ok) throw new Error('not refused');
    return judged;
  };

  describe('the same teacher on the same lesson, both terms', () => {
    it('is the user’s case: the 90 is Anna’s and the 40 Bo’s in both, so nothing new is held', () => {
      const judged = plan([leaderOf()], [followerOf()]);
      expect(judged.mirrors).toEqual([
        {
          leaderId: 'ht',
          followerId: 'vt',
          lessons: [
            { minutes: 90, leaderTeacherId: 'anna', followerTeacherId: 'anna' },
            { minutes: 40, leaderTeacherId: 'bo', followerTeacherId: 'bo' },
          ],
        },
      ]);
      // The leader is sent as it is: its own teachers, no extra in the co-teacher place.
      expect(judged.adults).toEqual(new Map([['ht', { teacherId: 'anna', coTeacherId: null }]]));
      expect(judged.holdsClass).toEqual(new Map([['ht', '7.1']]));
    });

    it('pairs two 40s by their teacher: Anna’s 40 and Bo’s 40 each find their own, whatever the order of the shares', () => {
      // Leader and follower alike: 90 Anna, 40 Anna, 40 Bo.
      const shape = { lessonsPerWeek: 3, lessonLengths: [90, 40, 40] };
      const judged = plan([leaderOf(BO_40, shape)], [followerOf(BO_40, shape)]);
      expect(judged.mirrors[0]!.lessons).toEqual([
        { minutes: 90, leaderTeacherId: 'anna', followerTeacherId: 'anna' },
        { minutes: 40, leaderTeacherId: 'anna', followerTeacherId: 'anna' },
        { minutes: 40, leaderTeacherId: 'bo', followerTeacherId: 'bo' },
      ]);
    });

    it('accepts a shared follower beside an unshared leader: Anna is on every lesson of it, Bo is the one extra', () => {
      const judged = plan([leaderOf([])], [followerOf()]);
      expect(judged.mirrors[0]!.lessons).toEqual([
        { minutes: 90, followerTeacherId: 'anna' },
        { minutes: 40, followerTeacherId: 'bo' },
      ]);
      // Bo is held in the co-teacher place of the unshared leader, at all its lessons.
      expect(judged.adults).toEqual(new Map([['ht', { teacherId: 'anna', coTeacherId: 'bo' }]]));
    });
  });

  describe('at most one extra teacher', () => {
    it('holds the follower’s 40 teacher, whom the leader lacks, in the leader’s co-teacher place', () => {
      const judged = plan([leaderOf()], [followerOf([{ teacherId: 'cecilia', lessons: 1, minutes: 40 }])]);
      expect(judged.mirrors[0]!.lessons).toEqual([
        { minutes: 90, leaderTeacherId: 'anna', followerTeacherId: 'anna' },
        { minutes: 40, leaderTeacherId: 'bo', followerTeacherId: 'cecilia' },
      ]);
      // The leader keeps its list (its teacher place), and Cecilia sits in the other place.
      expect(judged.adults).toEqual(new Map([['ht', { teacherId: 'anna', coTeacherId: 'cecilia' }]]));
    });

    it('holds a shared leader’s extra only in the co-teacher place, though its teacher place is empty', () => {
      // A leader without a huvudlärare: its teacher place is the list's first entry (null), never a seat.
      const judged = plan(
        [leaderOf([{ teacherId: 'bo', lessons: 1, minutes: 40 }], { teacherId: null })],
        [followerOf([{ teacherId: 'cecilia', lessons: 1, minutes: 40 }], { teacherId: null })],
      );
      expect(judged.adults).toEqual(new Map([['ht', { teacherId: null, coTeacherId: 'cecilia' }]]));
    });

    it('holds an unshared leader’s extra in its teacher place when that is empty, as an unshared follower’s always was', () => {
      const judged = plan([leaderOf([], { teacherId: null })], [followerOf([{ teacherId: 'cecilia', lessons: 1, minutes: 40 }], { teacherId: null })]);
      expect(judged.adults).toEqual(new Map([['ht', { teacherId: 'cecilia', coTeacherId: null }]]));
    });

    it('holds the follower’s co-teacher, who is on every lesson, as the one extra', () => {
      const judged = plan([leaderOf()], [followerOf(BO_40, { coTeacherId: 'dana' })]);
      expect(judged.adults).toEqual(new Map([['ht', { teacherId: 'anna', coTeacherId: 'dana' }]]));
    });

    it('holds a follower that shares nothing: Cecilia has both lessons and is held on all of the leader’s', () => {
      const judged = plan([leaderOf()], [followerOf([], { teacherId: 'cecilia' })]);
      expect(judged.mirrors[0]!.lessons).toEqual([
        { minutes: 90, leaderTeacherId: 'anna' },
        { minutes: 40, leaderTeacherId: 'bo' },
      ]);
      expect(judged.adults).toEqual(new Map([['ht', { teacherId: 'anna', coTeacherId: 'cecilia' }]]));
    });

    it('counts a teacher held everywhere on the leader block as nothing: an unshared sibling’s teacher needs no seat', () => {
      // Two posts a side. The leader's hemkunskap is shared; its bild is
      // Dan's every lesson. The follower's hemkunskap has Dan on the 40: Dan
      // is at every slot of the block already.
      const bild = (id: string, term: 'HT' | 'VT', teacherId: string, half: string): SameTimesRow => ({
        ...hk(id, half, term, teacherId, []),
        subjectId: 'bild',
      });
      const leaders = [leaderOf(), bild('ht2', 'HT', 'dan', '7.1:2')];
      const followers = [
        followerOf([{ teacherId: 'dan', lessons: 1, minutes: 40 }]),
        bild('vt2', 'VT', 'dan2', '7.1:1'),
      ];
      const judged = plan(leaders, followers);
      expect(judged.adults.get('ht')).toEqual({ teacherId: 'anna', coTeacherId: null });
      expect(judged.mirrors.find((mirror) => mirror.followerId === 'vt')!.lessons![1]).toEqual({
        minutes: 40,
        leaderTeacherId: 'bo',
        followerTeacherId: 'dan',
      });
    });
  });

  describe('everything else is refused by name', () => {
    it('refuses two extra teachers, naming the follower post', () => {
      // Dan has the 90 and Cecilia the 40: neither is on those lessons of the leader.
      const cecilia40 = [{ teacherId: 'cecilia', lessons: 1, minutes: 40 }];
      expect(refusal([leaderOf()], [followerOf(cecilia40, { teacherId: 'dan' })])).toEqual({
        ok: false,
        code: BLOCK_SAME_TIMES_SPLIT_LESSONS,
        requirementId: 'vt',
      });
    });

    it('refuses an extra teacher when the co-teacher place is taken', () => {
      expect(refusal([leaderOf(BO_40, { coTeacherId: 'cora' })], [followerOf([{ teacherId: 'cecilia', lessons: 1, minutes: 40 }])])).toMatchObject({
        code: BLOCK_SAME_TIMES_SPLIT_LESSONS,
      });
    });

    it('refuses an extra teacher who leads another lesson of the leader post: the engine refuses a co-teacher who is in the list', () => {
      // Anna leads the leader's 90 only; the follower has her on the 40 too.
      expect(refusal([leaderOf()], [followerOf([], { teacherId: 'anna' })])).toMatchObject({
        code: BLOCK_SAME_TIMES_SPLIT_LESSONS,
      });
      // The same with the lessons swapped between the teachers: Bo has the 90 and Anna the 40.
      expect(
        refusal([leaderOf()], [followerOf([{ teacherId: 'anna', lessons: 1, minutes: 40 }], { teacherId: 'bo' })]),
      ).toMatchObject({ code: BLOCK_SAME_TIMES_SPLIT_LESSONS });
    });

    it('refuses an extra teacher who leads a lesson of a shared sibling post: the engine refuses a block whose members share a teacher', () => {
      const bild = (id: string, term: 'HT' | 'VT', lead: string, half: string, shares: SameTimesRow['shares']): SameTimesRow => ({
        ...hk(id, half, term, lead, shares),
        subjectId: 'bild',
      });
      const leaders = [leaderOf(), bild('ht2', 'HT', 'dan', '7.1:2', [{ teacherId: 'eva', lessons: 1, minutes: 40 }])];
      // Eva has a 40 of the sibling's: at that slot only. The follower has her on the other post's 40.
      const followers = [
        followerOf([{ teacherId: 'eva', lessons: 1, minutes: 40 }]),
        bild('vt2', 'VT', 'dan', '7.1:1', []),
      ];
      expect(refusal(leaders, followers)).toMatchObject({ code: BLOCK_SAME_TIMES_SPLIT_LESSONS });
    });

    it('refuses lessons that cannot be paired by length, by the follower post, when either post is shared', () => {
      expect(refusal([leaderOf()], [followerOf(BO_40, { lessonLengths: [90, 45] })])).toEqual({
        ok: false,
        code: BLOCK_SAME_TIMES_SPLIT_LESSONS,
        requirementId: 'vt',
      });
      expect(refusal([leaderOf()], [followerOf(BO_40, { lessonsPerWeek: 3, lessonLengths: [90, 40, 40] })])).toMatchObject({
        code: BLOCK_SAME_TIMES_SPLIT_LESSONS,
      });
      // Neither shared: still the plain refusal, as before.
      expect(refusal([leaderOf([])], [followerOf([], { lessonLengths: [90, 45] })])).toEqual({
        ok: false,
        code: BLOCK_SAME_TIMES_DIFFER,
      });
    });

    it('still names the structure first: another subject or weeks that meet are no shares’ fault', () => {
      expect(refusal([leaderOf()], [followerOf(BO_40, { subjectId: 'bild' })])).toEqual({ ok: false, code: BLOCK_SAME_TIMES_DIFFER });
      expect(refusal([leaderOf()], [followerOf(BO_40, { startDate: null, endDate: null })])).toEqual({
        ok: false,
        code: BLOCK_SAME_TIMES_DIFFER,
      });
    });

    it('refuses the follower’s teacher on two of its posts, share teachers included, as the engine refuses a block', () => {
      const bild = (id: string, shares: SameTimesRow['shares']): SameTimesRow => ({
        ...hk(id, '7.1:1', 'VT', 'dan', shares),
        subjectId: 'bild',
      });
      const leaders = [leaderOf(), { ...bild('ht2', []), startDate: null, endDate: FIRST_END, studentGroupId: '7.1:2' }];
      // Bo has a 40 of the follower's hemkunskap and one of its bild.
      const followers = [
        followerOf(BO_40),
        { ...bild('vt2', [{ teacherId: 'bo', lessons: 1, minutes: 40 }]), studentGroupId: '7.1:1' },
      ];
      expect(refusal(leaders, followers)).toMatchObject({ code: BLOCK_MEMBERS_SHARE_TEACHER });
    });
  });
});

describe('pairLessons', () => {
  const row = (teacherId: string | null, shares: SameTimesRow['shares'], lessonLengths: number[]) => ({
    teacherId,
    coTeacherId: null,
    lessonsPerWeek: lessonLengths.length,
    minutesPerLesson: Math.max(...lessonLengths),
    lessonLengths,
    ...(shares ? { shares } : {}),
  });

  it('pairs a lesson with one of the same length, a different length never', () => {
    // 90 Anna + 40 Bo against 90 Bo + 40 Anna: the lengths decide, the teachers differ on both.
    const paired = pairLessons(
      row('anna', [{ teacherId: 'bo', lessons: 1, minutes: 40 }], [90, 40]),
      row('bo', [{ teacherId: 'anna', lessons: 1, minutes: 40 }], [90, 40]),
    );
    expect(paired).toEqual([
      { minutes: 90, leader: 'anna', follower: 'bo' },
      { minutes: 40, leader: 'bo', follower: 'anna' },
    ]);
  });

  it('pairs the same teacher first, then fills the rest by length', () => {
    // Three 60: Anna, Anna, Bo against Bo, Anna, Cecilia.
    const paired = pairLessons(
      row('anna', [{ teacherId: 'bo', lessons: 1, minutes: 60 }], [60, 60, 60]),
      row('anna', [{ teacherId: 'bo', lessons: 1, minutes: 60 }, { teacherId: 'cecilia', lessons: 1, minutes: 60 }], [60, 60, 60]),
    );
    expect(paired).toEqual([
      { minutes: 60, leader: 'anna', follower: 'anna' },
      { minutes: 60, leader: 'anna', follower: 'cecilia' },
      { minutes: 60, leader: 'bo', follower: 'bo' },
    ]);
  });

  it('pairs the same teacher on the same length when the two lists cross: Anna’s 60 with Anna’s, Bo’s with Bo’s', () => {
    // Leader 60: Anna, Bo. Follower 60: Bo (its lead), Anna (a share). Matching by length alone would cross them.
    const paired = pairLessons(
      row('anna', [{ teacherId: 'bo', lessons: 1, minutes: 60 }], [60, 60]),
      row('bo', [{ teacherId: 'anna', lessons: 1, minutes: 60 }], [60, 60]),
    );
    expect(paired).toEqual([
      { minutes: 60, leader: 'anna', follower: 'anna' },
      { minutes: 60, leader: 'bo', follower: 'bo' },
    ]);
  });

  it('is a function of the two rows and nothing else', () => {
    const a = row('anna', [{ teacherId: 'bo', lessons: 1, minutes: 40 }], [90, 40]);
    const b = row('anna', [{ teacherId: 'cecilia', lessons: 1, minutes: 40 }], [90, 40]);
    expect(pairLessons(a, b)).toEqual(pairLessons({ ...a }, { ...b }));
  });
});

describe('mirrorLessons, delade lektioner', () => {
  const lesson = (requirementId: string, dayOfWeek: number, startTime: string, endTime: string, teacherId?: string | null) => ({
    requirementId,
    roomId: 'hemkunskapssal',
    dayOfWeek,
    startTime,
    endTime,
    ...(teacherId !== undefined ? { teacherId } : {}),
  });
  const anna90 = lesson('ht', 1, '09:00', '10:30', 'anna');
  const bo40 = lesson('ht', 3, '10:00', '10:40', 'bo');
  const pairing: Mirror = {
    leaderId: 'ht',
    followerId: 'vt',
    lessons: [
      { minutes: 90, leaderTeacherId: 'anna', followerTeacherId: 'anna' },
      { minutes: 40, leaderTeacherId: 'bo', followerTeacherId: 'cecilia' },
    ],
  };

  it('writes each leader lesson again with the follower’s teacher of the lesson it is paired with', () => {
    const mirrored = mirrorLessons([anna90, bo40], [pairing]);
    expect(mirrored).toEqual([
      anna90,
      bo40,
      { ...anna90, requirementId: 'vt', teacherId: 'anna' },
      { ...bo40, requirementId: 'vt', teacherId: 'cecilia' },
    ]);
  });

  it('writes the same teachers whatever order the engine answered in', () => {
    const forward = mirrorLessons([anna90, bo40], [pairing]).filter((l) => l.requirementId === 'vt');
    const backward = mirrorLessons([bo40, anna90], [pairing]).filter((l) => l.requirementId === 'vt');
    const key = (l: (typeof forward)[number]) => `${l.dayOfWeek}:${l.startTime}:${l.teacherId}`;
    expect(backward.map(key).sort()).toEqual(forward.map(key).sort());
  });

  it('gives lessons of one length and lead the pairing’s teachers in place order, whatever the engine’s', () => {
    // Anna leads two 60s; the follower has Anna on one and Cecilia on the other.
    const early = lesson('ht', 1, '08:00', '09:00', 'anna');
    const late = lesson('ht', 2, '08:00', '09:00', 'anna');
    const mirror: Mirror = {
      leaderId: 'ht',
      followerId: 'vt',
      lessons: [
        { minutes: 60, leaderTeacherId: 'anna', followerTeacherId: 'anna' },
        { minutes: 60, leaderTeacherId: 'anna', followerTeacherId: 'cecilia' },
      ],
    };
    for (const answer of [[early, late], [late, early]]) {
      const copies = mirrorLessons(answer, [mirror]).filter((l) => l.requirementId === 'vt');
      expect(copies.find((l) => l.dayOfWeek === 1)!.teacherId).toBe('anna');
      expect(copies.find((l) => l.dayOfWeek === 2)!.teacherId).toBe('cecilia');
    }
  });

  it('matches a leader lesson to the pairing entry of its own length: Anna’s 40 on Monday is not taken for her 90 on Tuesday', () => {
    // Anna leads a 90 and a 40; the follower has Anna on the 90 and Cecilia on the 40.
    const early40 = lesson('ht', 1, '08:00', '08:40', 'anna');
    const late90 = lesson('ht', 2, '08:00', '09:30', 'anna');
    const mirror: Mirror = {
      leaderId: 'ht',
      followerId: 'vt',
      lessons: [
        { minutes: 90, leaderTeacherId: 'anna', followerTeacherId: 'anna' },
        { minutes: 40, leaderTeacherId: 'anna', followerTeacherId: 'cecilia' },
      ],
    };
    const copies = mirrorLessons([early40, late90], [mirror]).filter((l) => l.requirementId === 'vt');
    expect(copies.map((l) => [l.dayOfWeek, l.teacherId])).toEqual([[1, 'cecilia'], [2, 'anna']]);
  });

  it('does not read the length of a uniform post’s lessons back: nobody ever did, and the demand holds the engine to its count', () => {
    // Two 60s, Anna's and Bo's; the answer says 50 minutes each.
    const a = lesson('ht', 1, '08:00', '08:50', 'anna');
    const b = lesson('ht', 2, '08:00', '08:50', 'bo');
    const mirror: Mirror = {
      leaderId: 'ht',
      followerId: 'vt',
      lessons: [
        { minutes: 60, leaderTeacherId: 'anna', followerTeacherId: 'anna' },
        { minutes: 60, leaderTeacherId: 'bo', followerTeacherId: 'cecilia' },
      ],
    };
    const copies = mirrorLessons([a, b], [mirror]).filter((l) => l.requirementId === 'vt');
    expect(copies.map((l) => [l.dayOfWeek, l.teacherId])).toEqual([[1, 'anna'], [2, 'cecilia']]);
  });

  it('takes the leader’s teacher off a copy whose follower shares nothing: its lessons are its row’s', () => {
    const unsharedFollower: Mirror = {
      leaderId: 'ht',
      followerId: 'vt',
      lessons: [
        { minutes: 90, leaderTeacherId: 'anna' },
        { minutes: 40, leaderTeacherId: 'bo' },
      ],
    };
    const copies = mirrorLessons([anna90, bo40], [unsharedFollower]).filter((l) => l.requirementId === 'vt');
    expect(copies).toHaveLength(2);
    for (const copy of copies) expect(copy).not.toHaveProperty('teacherId');
  });

  it('puts the follower’s teacher on a copy of an unshared leader’s lesson, which has none of its own', () => {
    const leader = [lesson('ht', 1, '09:00', '10:30'), lesson('ht', 3, '10:00', '10:40')];
    const sharedFollower: Mirror = {
      leaderId: 'ht',
      followerId: 'vt',
      lessons: [
        { minutes: 90, followerTeacherId: 'anna' },
        { minutes: 40, followerTeacherId: 'bo' },
      ],
    };
    const copies = mirrorLessons(leader, [sharedFollower]).filter((l) => l.requirementId === 'vt');
    expect(copies.map((l) => [l.dayOfWeek, l.teacherId])).toEqual([[1, 'anna'], [3, 'bo']]);
  });

  it('writes no copy for a leader lesson the pairing has no entry for', () => {
    // The engine placed a 60 the request never asked for: no follower lesson is invented for it.
    const extra = lesson('ht', 5, '12:00', '13:00', 'anna');
    const copies = mirrorLessons([anna90, bo40, extra], [pairing]).filter((l) => l.requirementId === 'vt');
    expect(copies).toHaveLength(2);
  });

  it('writes a mirror without a pairing as it always did, the leader’s teacher key and all', () => {
    const plain = lesson('ht', 1, '09:00', '10:00', 'anna');
    expect(mirrorLessons([plain], [{ leaderId: 'ht', followerId: 'vt' }])).toEqual([plain, { ...plain, requirementId: 'vt' }]);
  });
});
