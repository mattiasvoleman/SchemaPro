import {
  BLOCK_MEMBERS_SHARE_TEACHER,
  BLOCK_SAME_TIMES_DIFFER,
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
