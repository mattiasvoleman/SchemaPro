import {
  BLOCK_MEMBERS_SHARE_TEACHER,
  BLOCK_SAME_TIMES_DIFFER,
  BLOCK_SAME_TIMES_SPLIT_LESSONS,
  BLOCK_SAME_TIMES_TEACHERS,
  mirrorLessons,
  planMirror,
  sameTimesLinks,
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

  it('refuses, by the post, a link either of whose blocks holds a post split between teachers', () => {
    // A leader post has one place for a teacher of all its lessons; a spring
    // post whose lessons are two teachers' cannot be held there.
    expect(planMirror(autumn, [spring[0]!, { ...spring[1]!, shared: true }])).toEqual({
      ok: false,
      code: BLOCK_SAME_TIMES_SPLIT_LESSONS,
      requirementId: 's2',
    });
    expect(planMirror([{ ...autumn[0]!, shared: true }, autumn[1]!], spring)).toEqual({
      ok: false,
      code: BLOCK_SAME_TIMES_SPLIT_LESSONS,
      requirementId: 'a1',
    });
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
