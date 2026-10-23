import { randomUUID } from 'node:crypto';
import {
  BASIS_PARTS,
  basisInputsOf,
  basisOf,
  basisPartsOf,
  canonicalJson,
  changedParts,
  preservedPartOf,
  sha256Hex,
  type BasisParts,
  type BasisPayload,
  type BasisSource,
  type DraftContent,
} from './candidate-basis';
import type { ScheduleRules } from './interfaces/ai-engine-payload.interface';

/*
 * The basis holds a candidate to the draft it was solved from. Two promises
 * are pinned here: two reads of an unchanged school agree although every
 * anonymous id and every row order differs, and each part moves with its own
 * inputs and with nothing else's — the part names are what a stale apply tells
 * the school changed.
 */

/** A school in REAL ids, shaped as the payload is. */
interface School {
  payload: BasisPayload;
  storedRules: ScheduleRules | null;
  draftLessons: DraftContent[];
}

const school = (): School => ({
  payload: {
    requirements: [
      {
        id: 'req-ma-7a',
        subjectId: 'sub-ma',
        studentGroupId: 'grp-7a',
        teacherId: 't-anna',
        coTeacherId: null,
        lessonsPerWeek: 3,
        minutesPerLesson: 60,
        minutesBefore: 0,
        minutesAfter: 0,
        studentGroupSize: 24,
        minGradeLevel: 7,
        maxGradeLevel: 7,
        requiredRoomType: null,
      },
      {
        id: 'req-id-7b',
        subjectId: 'sub-id',
        studentGroupId: 'grp-7b',
        teacherId: 't-bo',
        coTeacherId: 't-anna',
        lessonsPerWeek: 2,
        minutesPerLesson: 80,
        lessonLengths: [80, 40],
        minutesBefore: 10,
        minutesAfter: 15,
        maxLessonsPerDay: 1,
        lockedDays: [1, 3],
        blockId: 'block-val',
        studentGroupSize: 22,
        minGradeLevel: 7,
        maxGradeLevel: 7,
        requiredRoomType: 'type-hall',
      },
    ],
    rooms: [
      { id: 'room-a1', capacity: 30, type: null, minGradeLevel: null, maxGradeLevel: null },
      { id: 'room-hall', capacity: 60, type: 'type-hall', minGradeLevel: 4, maxGradeLevel: 9 },
    ],
    constraints: [
      {
        id: 'c-anna-mon',
        resourceKind: 'TEACHER',
        resourceId: 't-anna',
        dayOfWeek: 1,
        date: null,
        startTime: '08:00:00',
        endTime: '10:00:00',
        kind: 'UNAVAILABLE',
      },
      {
        id: 'c-stage',
        resourceKind: 'GRADE_LEVEL',
        minGradeLevel: 7,
        maxGradeLevel: 9,
        dayOfWeek: 5,
        date: null,
        startTime: '13:00:00',
        endTime: '15:00:00',
        kind: 'PREFERRED_FREE',
      },
    ],
    frameTimes: [
      { minGradeLevel: 7, maxGradeLevel: 9, dayOfWeek: null, startTime: '08:00:00', endTime: '16:00:00', changeoverMinutes: 5 },
      { minGradeLevel: 4, maxGradeLevel: 6, dayOfWeek: null, startTime: '08:00:00', endTime: '14:00:00', changeoverMinutes: 0 },
    ],
    lunchServings: [
      { minGradeLevel: 7, maxGradeLevel: 9, dayOfWeek: null, startTime: '11:30:00', endTime: '12:30:00', seats: null },
    ],
    lunchPlacements: [{ studentGroupId: 'grp-7a', dayOfWeek: 2, startTime: '11:30:00' }],
    rasts: [
      { minGradeLevel: 7, maxGradeLevel: 9, dayOfWeek: null, startTime: '09:40:00', endTime: '10:00:00', requiresLessonBefore: true },
    ],
    roomPreferences: [
      {
        id: 'pref-id',
        subjectId: 'sub-id',
        kind: 'WISH',
        minGradeLevel: null,
        maxGradeLevel: null,
        roomType: null,
        roomIds: ['room-hall', 'room-a1'],
        weight: 5,
      },
    ],
    teacherWorkRules: [
      {
        id: 'wr-bo',
        teacherId: 't-bo',
        lunchMinutes: 30,
        lunchStartTime: '11:00:00',
        lunchEndTime: '13:00:00',
        minDailyRestMinutes: null,
      },
    ],
    fixedLessons: [
      {
        id: 'never-mapped',
        teacherId: 't-anna',
        coTeacherId: null,
        studentGroupId: 'grp-7a',
        extraGroupIds: ['grp-7b', 'grp-ma7'],
        roomId: 'room-a1',
        dayOfWeek: 2,
        startTime: '08:00:00',
        endTime: '09:00:00',
      },
    ],
    groups: [
      { id: 'grp-7a', lunchHeadcount: 24, minGradeLevel: 7, maxGradeLevel: 7 },
      { id: 'grp-7b', lunchHeadcount: 22, minGradeLevel: 7, maxGradeLevel: 7 },
    ],
    previousLessons: [
      { requirementId: 'req-ma-7a', dayOfWeek: 3, startTime: '10:00:00' },
      { requirementId: 'req-ma-7a', dayOfWeek: 4, startTime: '08:00:00' },
    ],
    groupConflicts: [
      ['grp-7a', 'grp-ma7'],
      ['grp-7b', 'grp-ma7'],
    ],
  },
  storedRules: { lunchStartTime: '11:00:00', lunchEndTime: '13:00:00', lunchMinutes: 30 },
  draftLessons: [
    {
      subjectId: 'sub-ma',
      studentGroupId: 'grp-7a',
      teacherId: 't-anna',
      coTeacherId: null,
      roomId: 'room-a1',
      dayOfWeek: 3,
      startTime: '10:00',
      endTime: '11:00',
      recurrence: 'ALL_WEEKS',
      startDate: null,
      endDate: null,
    },
    {
      subjectId: 'sub-ma',
      studentGroupId: 'grp-7a',
      teacherId: 't-anna',
      coTeacherId: null,
      roomId: null,
      dayOfWeek: 4,
      startTime: '08:00',
      endTime: '09:00',
      recurrence: 'ODD_WEEKS',
      startDate: '2026-08-17',
      endDate: '2026-12-18',
    },
  ],
});

/** A deterministic shuffle: the rows a second read may come back in. */
const shuffled = <T>(rows: readonly T[], turn: number): T[] => {
  const out = [...rows];
  for (let i = out.length - 1; i > 0; i--) {
    const j = (i * 7 + turn * 3) % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return turn % 2 === 1 ? out.reverse() : out;
};

/**
 * The payload as the gateway would send it for this school: every id through a
 * fresh per-request map, a fixed lesson under a fresh id mapped nowhere, and
 * every list in whatever order `turn` says.
 */
const anonymised = (real: School, turn = 0): BasisSource => {
  const maps = {
    requirement: new Map<string, string>(),
    subject: new Map<string, string>(),
    group: new Map<string, string>(),
    teacher: new Map<string, string>(),
    room: new Map<string, string>(),
    roomType: new Map<string, string>(),
    constraint: new Map<string, string>(),
    workRule: new Map<string, string>(),
    block: new Map<string, string>(),
    dayLimit: new Map<string, string>(),
  };
  const anon = (map: Map<string, string>, id: string): string => {
    const known = map.get(id);
    if (known) return known;
    const fresh = randomUUID();
    map.set(id, fresh);
    return fresh;
  };
  const orNull = (map: Map<string, string>, id: string | null) => (id === null ? null : anon(map, id));
  const p = real.payload;
  const resourceMap = (kind: string) =>
    kind === 'TEACHER' ? maps.teacher : kind === 'ROOM' ? maps.room : maps.group;
  const payload: BasisPayload = {
    requirements: shuffled(
      p.requirements.map((r) => ({
        ...r,
        id: anon(maps.requirement, r.id),
        subjectId: anon(maps.subject, r.subjectId),
        studentGroupId: anon(maps.group, r.studentGroupId),
        teacherId: orNull(maps.teacher, r.teacherId),
        coTeacherId: orNull(maps.teacher, r.coTeacherId),
        requiredRoomType: orNull(maps.roomType, r.requiredRoomType),
        ...(r.lessonLengths ? { lessonLengths: shuffled(r.lessonLengths, turn) } : {}),
        ...(r.lockedDays ? { lockedDays: shuffled(r.lockedDays, turn) } : {}),
        ...(r.blockId ? { blockId: anon(maps.block, r.blockId) } : {}),
      })),
      turn,
    ),
    rooms: shuffled(
      p.rooms.map((room) => ({ ...room, id: anon(maps.room, room.id), type: orNull(maps.roomType, room.type) })),
      turn,
    ),
    constraints: shuffled(
      p.constraints.map((c) => ({
        ...c,
        id: anon(maps.constraint, c.id),
        ...(c.resourceId !== undefined ? { resourceId: anon(resourceMap(c.resourceKind), c.resourceId) } : {}),
      })),
      turn,
    ),
    frameTimes: shuffled(p.frameTimes, turn),
    lunchServings: shuffled(p.lunchServings, turn),
    lunchPlacements: shuffled(
      p.lunchPlacements.map((placement) => ({ ...placement, studentGroupId: anon(maps.group, placement.studentGroupId) })),
      turn,
    ),
    rasts: shuffled(p.rasts, turn),
    roomPreferences: shuffled(
      p.roomPreferences.map((rule) => ({
        ...rule,
        // The gateway files a preference's id under the requirement map.
        id: anon(maps.requirement, rule.id),
        subjectId: anon(maps.subject, rule.subjectId),
        roomType: orNull(maps.roomType, rule.roomType),
        roomIds: shuffled(rule.roomIds.map((id) => anon(maps.room, id)), turn),
      })),
      turn,
    ),
    teacherWorkRules: shuffled(
      p.teacherWorkRules.map((rule) => ({
        ...rule,
        id: anon(maps.workRule, rule.id),
        teacherId: anon(maps.teacher, rule.teacherId),
      })),
      turn,
    ),
    // Sent only when a post sets a limit: absent here unless a test adds one.
    ...(p.teacherDayLimits !== undefined
      ? {
          teacherDayLimits: shuffled(
            p.teacherDayLimits.map((limit) => ({
              ...limit,
              id: anon(maps.dayLimit, limit.id),
              teacherId: anon(maps.teacher, limit.teacherId),
              lockedWeekdays: shuffled(limit.lockedWeekdays.map((set) => shuffled(set, turn)), turn),
            })),
            turn,
          ),
        }
      : {}),
    fixedLessons: shuffled(
      p.fixedLessons.map((lesson) => ({
        ...lesson,
        id: randomUUID(),
        teacherId: orNull(maps.teacher, lesson.teacherId),
        coTeacherId: orNull(maps.teacher, lesson.coTeacherId),
        studentGroupId: anon(maps.group, lesson.studentGroupId),
        extraGroupIds: shuffled((lesson.extraGroupIds ?? []).map((id) => anon(maps.group, id)), turn),
        roomId: orNull(maps.room, lesson.roomId),
      })),
      turn,
    ),
    groups: shuffled(p.groups.map((group) => ({ ...group, id: anon(maps.group, group.id) })), turn),
    previousLessons: shuffled(
      p.previousLessons.map((lesson) => ({ ...lesson, requirementId: anon(maps.requirement, lesson.requirementId) })),
      turn,
    ),
    // A pair comes back in either order, as a pupil's groups happen to sort.
    groupConflicts: shuffled(
      p.groupConflicts.map(([a, b]) =>
        (turn % 2 === 0 ? [anon(maps.group, a), anon(maps.group, b)] : [anon(maps.group, b), anon(maps.group, a)]) as [
          string,
          string,
        ],
      ),
      turn,
    ),
  };
  return {
    payload,
    maps: Object.values(maps),
    storedRules: real.storedRules,
    draftLessons: shuffled(real.draftLessons, turn),
  };
};

const partsOf = (real: School, turn = 0): BasisParts => basisPartsOf(basisInputsOf(anonymised(real, turn)));

describe('canonicalJson', () => {
  it('sorts keys at every depth and every array by its elements', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1, 2], c: 'x' } })).toBe('{"a":{"c":"x","d":[1,2,3]},"b":1}');
    expect(canonicalJson([{ k: 2 }, { k: 1 }])).toBe(canonicalJson([{ k: 1 }, { k: 2 }]));
  });

  it('leaves an undefined key out as JSON does, and keeps a null', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('writes a date as its instant', () => {
    expect(canonicalJson(new Date('2026-08-17T00:00:00.000Z'))).toBe('"2026-08-17T00:00:00.000Z"');
  });

  it('refuses a Map and a Set, which would otherwise hash as empty whatever they held', () => {
    expect(() => canonicalJson(new Map([['a', 1]]))).toThrow(TypeError);
    expect(() => canonicalJson({ nested: new Set([1]) })).toThrow(TypeError);
  });

  it('refuses a number JSON cannot spell', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
  });
});

describe('the candidate basis', () => {
  it('agrees across two reads of an unchanged school: fresh anonymous ids, rows in another order', () => {
    const first = anonymised(school(), 0);
    const second = anonymised(school(), 1);
    // The payloads themselves share no id at all…
    expect(first.payload.requirements.map((r) => r.id)).not.toEqual(
      expect.arrayContaining(second.payload.requirements.map((r) => r.id)),
    );

    // …and the basis is one.
    const a = basisPartsOf(basisInputsOf(first));
    const b = basisPartsOf(basisInputsOf(second));
    expect(b).toEqual(a);
    expect(basisOf(b)).toBe(basisOf(a));
  });

  it('is one sha256 over the version and the six parts', () => {
    const parts = partsOf(school());
    expect(Object.keys(parts).sort()).toEqual([...BASIS_PARTS].sort());
    for (const digest of Object.values(parts)) expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(basisOf(parts)).toBe(sha256Hex(canonicalJson({ v: 1, parts })));
  });

  it('takes a fixed lesson by what it is, never by the id it was sent under', () => {
    const source = anonymised(school());
    const again = {
      ...source,
      payload: {
        ...source.payload,
        fixedLessons: source.payload.fixedLessons.map((lesson) => ({ ...lesson, id: randomUUID() })),
      },
    };
    expect(basisPartsOf(basisInputsOf(again))).toEqual(basisPartsOf(basisInputsOf(source)));
  });

  it('reads nothing a request adds on top of the fetch: its id, weights, rules or search', () => {
    const source = anonymised(school());
    const asSent = {
      ...source,
      payload: {
        ...source.payload,
        requestId: randomUUID(),
        weights: { disruption: 0 },
        rules: { lunchMinutes: 45 },
        search: { seed: 3, maxSeconds: 30 },
      } as BasisPayload,
    };
    expect(basisPartsOf(basisInputsOf(asSent))).toEqual(basisPartsOf(basisInputsOf(source)));
  });

  /*
   * Each part moves with its own inputs and nothing else's. The left column
   * is the edit a school makes; the right is the one part a stale apply then
   * names. None is the edits that change nothing a candidate depends on.
   */
  it.each<[string, (real: School) => void, string[]]>([
    ['a timplanspost asks for a lesson fewer', (s) => void (s.payload.requirements[0]!.lessonsPerWeek = 2), ['requirements']],
    ['a timplanspost changes teacher', (s) => void (s.payload.requirements[0]!.teacherId = 't-bo'), ['requirements']],
    ['a block loses a member', (s) => void delete s.payload.requirements[1]!.blockId, ['requirements']],
    ['a locked lesson changes room', (s) => void (s.payload.fixedLessons[0]!.roomId = 'room-hall'), ['preserved']],
    ['a locked lesson loses its second class', (s) => void s.payload.fixedLessons[0]!.extraGroupIds!.pop(), ['preserved']],
    ['a draft lesson is moved by hand', (s) => void (s.draftLessons[0]!.dayOfWeek = 5), ['draft']],
    ['a hint the engine is given moves', (s) => void (s.payload.previousLessons[0]!.startTime = '13:00:00'), ['draft']],
    ['a draft lesson gets a term', (s) => void (s.draftLessons[0]!.endDate = '2026-12-18'), ['draft']],
    ['a room gets smaller', (s) => void (s.payload.rooms[0]!.capacity = 20), ['rooms']],
    ['a room wish weighs more', (s) => void (s.payload.roomPreferences[0]!.weight = 9), ['rooms']],
    ['a reservation moves', (s) => void (s.payload.constraints[0]!.endTime = '11:00:00'), ['rules']],
    ['a ramtid ends later', (s) => void (s.payload.frameTimes[0]!.endTime = '16:30:00'), ['rules']],
    ['a rast moves', (s) => void (s.payload.rasts[0]!.startTime = '09:50:00'), ['rules']],
    ['a sitting gets chairs', (s) => void (s.payload.lunchServings[0]!.seats = 120), ['rules']],
    ['a meal is placed by hand elsewhere', (s) => void (s.payload.lunchPlacements[0]!.dayOfWeek = 3), ['rules']],
    ['a teacher’s lunch rule changes', (s) => void (s.payload.teacherWorkRules[0]!.lunchMinutes = 40), ['rules']],
    // Lärarens dag: the cap and the wish ride on the work rule, the days on the post.
    ['a teacher gets a daily cap', (s) => void (s.payload.teacherWorkRules[0]!.maxTeachingMinutesPerDay = 300), ['rules']],
    ['a teacher wishes Friday free', (s) => void (s.payload.teacherWorkRules[0]!.preferredFreeDay = 5), ['rules']],
    [
      'a post comes to limit its teacher’s days',
      (s) => void (s.payload.teacherDayLimits = [{ id: 'post-bo', teacherId: 't-bo', maxTeachingDaysPerWeek: 3, lockedWeekdays: [[]] }]),
      ['rules'],
    ],
    ['the school’s lunch is longer', (s) => void (s.storedRules = { ...s.storedRules, lunchMinutes: 40 }), ['rules']],
    ['a class gets a pupil', (s) => void (s.payload.groups[0]!.lunchHeadcount = 25), ['rosters']],
    ['two groups come to share a pupil', (s) => void s.payload.groupConflicts.push(['grp-7a', 'grp-7b']), ['rosters']],
    ['two rows swap places', (s) => void s.payload.rooms.reverse(), []],
  ])('%s: %j', (_edit, edit, expected) => {
    const before = partsOf(school());
    const changed = school();
    edit(changed);

    expect(changedParts(before, partsOf(changed, 1))).toEqual(expected);
  });

  it('reads a post’s day limit in real ids, whatever its anonymous id, and moves with its days and its locked weekdays', () => {
    const limited = (days: number, locked: number[][]) => {
      const real = school();
      real.payload.teacherDayLimits = [{ id: 'post-bo', teacherId: 't-bo', maxTeachingDaysPerWeek: days, lockedWeekdays: locked as never }];
      return real;
    };
    expect(partsOf(limited(3, [[1, 2], [3]]), 1)).toEqual(partsOf(limited(3, [[1, 2], [3]])));
    expect(changedParts(partsOf(limited(3, [[1]])), partsOf(limited(2, [[1]]), 1))).toEqual(['rules']);
    // A lesson's weeks reach the basis through the weekdays it holds week by
    // week, which a fixed lesson by itself does not carry.
    expect(changedParts(partsOf(limited(3, [[1]])), partsOf(limited(3, [[1], [2]]), 1))).toEqual(['rules']);
  });

  it('reads a conflict pair either way round as one pair', () => {
    const forward = school();
    const backward = school();
    backward.payload.groupConflicts = backward.payload.groupConflicts.map(([a, b]) => [b, a]);
    expect(partsOf(backward)).toEqual(partsOf(forward));
  });

  it('digests the preserved lessons the same from the database as from the payload', () => {
    // The apply's last check re-reads the rows after its write; it must land
    // on the digest the fixed lessons gave at the fetch.
    const parts = partsOf(school());
    const row = {
      studentGroupId: 'grp-7a',
      teacherId: 't-anna',
      coTeacherId: null,
      roomId: 'room-a1',
      dayOfWeek: 2,
      startTime: new Date('1970-01-01T08:00:00.000Z'),
      endTime: new Date('1970-01-01T09:00:00.000Z'),
      extraGroups: [{ studentGroupId: 'grp-ma7' }, { studentGroupId: 'grp-7b' }],
    };
    expect(preservedPartOf([row])).toBe(parts.preserved);
    expect(preservedPartOf([{ ...row, roomId: 'room-hall' }])).not.toBe(parts.preserved);
  });

  it('refuses an anonymous id no map knows, rather than hashing a random one', () => {
    const source = anonymised(school());
    source.payload.requirements[0] = { ...source.payload.requirements[0]!, teacherId: randomUUID() };
    expect(() => basisInputsOf(source)).toThrow('no real counterpart');
  });

  it('reads the posts written at a sent post’s times into the requirements part, and a school with none as before', () => {
    const source = anonymised(school());
    const before = basisPartsOf(basisInputsOf(source));
    // No block on another's times: the part a release before them hashed.
    expect(basisPartsOf(basisInputsOf({ ...source, mirrors: [] }))).toEqual(before);

    const spring = {
      id: 'spring-post',
      mirrorOf: 'autumn-post',
      subjectId: 'textil',
      studentGroupId: '7A:2',
      teacherId: 'tove',
      coTeacherId: null,
    };
    const mirrored = basisPartsOf(basisInputsOf({ ...source, mirrors: [spring] }));
    expect(changedParts(before, mirrored)).toEqual(['requirements']);
    // Its teacher, which the payload need not carry, is part of it.
    const otherTeacher = basisPartsOf(basisInputsOf({ ...source, mirrors: [{ ...spring, teacherId: 'tea' }] }));
    expect(changedParts(mirrored, otherTeacher)).toEqual(['requirements']);
  });

  it('names every part changed against a stored value that is not a parts object', () => {
    const current = partsOf(school());
    expect(changedParts(null, current)).toEqual([...BASIS_PARTS]);
    expect(changedParts('a-string', current)).toEqual([...BASIS_PARTS]);
    expect(changedParts({ ...current }, current)).toEqual([]);
  });
});
