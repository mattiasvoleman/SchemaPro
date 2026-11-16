import { randomUUID } from 'node:crypto';
import {
  BASIS_PARTS,
  basisInputsOf,
  basisOf,
  basisPartsOf,
  canonicalJson,
  changedParts,
  changedPartsForWrite,
  preservedPartOf,
  sha256Hex,
  type BasisParts,
  type BasisPayload,
  type BasisSource,
  type DraftContent,
  WRITE_BASIS_PARTS,
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
    site: new Map<string, string>(),
    // Placeringsregler: a building is a token minted per request.
    building: new Map<string, string>(),
    // A lock's own id, mapped only where the pupils' cohorts name it.
    fixed: new Map<string, string>(),
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
        // Shuffled as any list, except beside a list of teachers aligned with it.
        ...(r.lessonLengths ? { lessonLengths: r.lessonTeacherIds ? r.lessonLengths : shuffled(r.lessonLengths, turn) } : {}),
        ...(r.lockedDays ? { lockedDays: shuffled(r.lockedDays, turn) } : {}),
        ...(r.blockId ? { blockId: anon(maps.block, r.blockId) } : {}),
        // Aligned with the lessons, so never shuffled apart from them.
        ...(r.lessonTeacherIds ? { lessonTeacherIds: r.lessonTeacherIds.map((id) => orNull(maps.teacher, id)) } : {}),
      })),
      turn,
    ),
    rooms: shuffled(
      p.rooms.map((room) => ({
        ...room,
        id: anon(maps.room, room.id),
        type: orNull(maps.roomType, room.type),
        ...(room.siteId !== undefined ? { siteId: anon(maps.site, room.siteId) } : {}),
        ...(room.building !== undefined ? { building: anon(maps.building, room.building) } : {}),
      })),
      turn,
    ),
    // Sent only when the school keeps the walk and has a figure.
    ...(p.siteTravelTimes !== undefined
      ? {
          siteTravelTimes: shuffled(
            p.siteTravelTimes.map((row) => ({
              ...row,
              siteAId: anon(maps.site, row.siteAId),
              siteBId: anon(maps.site, row.siteBId),
            })),
            turn,
          ),
        }
      : {}),
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
        id: p.pupilGaps !== undefined ? anon(maps.fixed, lesson.id) : randomUUID(),
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
    // Placeringsregler: sent only when the school turned a rule on.
    ...(p.placementRules !== undefined
      ? {
          placementRules: {
            ...p.placementRules,
            ...(p.placementRules.subjectEdges !== undefined
              ? {
                  subjectEdges: {
                    ...p.placementRules.subjectEdges,
                    subjects: shuffled(
                      p.placementRules.subjectEdges.subjects.map((row) => ({ ...row, subjectId: anon(maps.subject, row.subjectId) })),
                      turn,
                    ),
                  },
                }
              : {}),
          },
        }
      : {}),
    // Terminer: sent only when a post or a lock is dated.
    ...(p.periodWeeks !== undefined ? { periodWeeks: p.periodWeeks } : {}),
    ...(p.periodOddWeeks !== undefined ? { periodOddWeeks: p.periodOddWeeks } : {}),
    // Klassens måltid per del av läsåret: sent beside the periods when the school has a lunch rule.
    ...(p.lunchPerPeriod !== undefined ? { lunchPerPeriod: p.lunchPerPeriod } : {}),
    // Elevernas håltimmar: sent only when the school turned it on.
    ...(p.pupilGaps !== undefined
      ? {
          pupilGaps: {
            cohorts: shuffled(
              p.pupilGaps.cohorts.map((cohort) => ({
                ...cohort,
                groupIds: shuffled(cohort.groupIds.map((id) => anon(maps.group, id)), turn),
                fixedLessonIds: cohort.fixedLessonIds.map((id) => anon(maps.fixed, id)),
                ...(cohort.homeGroupId !== undefined ? { homeGroupId: anon(maps.group, cohort.homeGroupId) } : {}),
              })),
              turn,
            ),
            ...(p.pupilGaps.fixedMargins !== undefined
              ? {
                  fixedMargins: p.pupilGaps.fixedMargins.map((margin) => ({
                    ...margin,
                    fixedLessonId: anon(maps.fixed, margin.fixedLessonId),
                  })),
                }
              : {}),
          },
        }
      : {}),
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
    ['a locked lesson moves to even weeks', (s) => void (s.payload.fixedLessons[0]!.recurrence = 'EVEN_WEEKS'), ['preserved']],
    ['a post moves to odd weeks', (s) => void (s.payload.requirements[0]!.recurrence = 'ODD_WEEKS'), ['requirements']],
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

  it('delade lektioner: reads each lesson’s teacher in real ids, and moves when a share moves to another length', () => {
    // 7B's idrott as 80 + 60 + 40, Bo the lead: Cilla takes the 40, or the 60.
    // The same teachers, the same lead, the same lengths — only which lesson
    // is whose differs, which a digest of the list alone would miss.
    const shared = (teachers: string[]) => {
      const real = school();
      const idrott = real.payload.requirements.find((r) => r.id === 'req-id-7b')!;
      Object.assign(idrott, {
        coTeacherId: null,
        teacherId: 't-bo',
        lessonsPerWeek: 3,
        minutesPerLesson: 80,
        lessonLengths: [80, 60, 40],
        lessonTeacherIds: teachers,
      });
      return real;
    };
    expect(partsOf(shared(['t-bo', 't-bo', 't-cilla']), 1)).toEqual(partsOf(shared(['t-bo', 't-bo', 't-cilla'])));
    expect(
      changedParts(partsOf(shared(['t-bo', 't-bo', 't-cilla'])), partsOf(shared(['t-bo', 't-cilla', 't-bo']), 1)),
    ).toEqual(['requirements']);
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

  it('moves with the periods a post’s locked weekdays are held in, and not with the order they are sent in', () => {
    const held = (monday: boolean[], empty: boolean[], turned = false) => {
      const real = school();
      const entries = [
        { weekdays: [], periods: empty },
        { weekdays: [1], periods: monday },
      ];
      real.payload.teacherDayLimits = [
        {
          id: 'post-bo',
          teacherId: 't-bo',
          maxTeachingDaysPerWeek: 2,
          lockedWeekdays: [[1]] as never,
          lockedWeekdayPeriods: (turned ? [...entries].reverse() : entries) as never,
        },
      ];
      return real;
    };
    const autumn = partsOf(held([true, false], [false, true]));
    expect(partsOf(held([true, false], [false, true], true), 1)).toEqual(autumn);
    // The Monday moved to the spring: the same sets, the same masks as a
    // sorted list, another year.
    expect(changedParts(autumn, partsOf(held([false, true], [true, false]), 1))).toEqual(['rules']);
    // And a limit that stops saying its periods is the reading it was before them.
    const unsaid = school();
    unsaid.payload.teacherDayLimits = [
      { id: 'post-bo', teacherId: 't-bo', maxTeachingDaysPerWeek: 2, lockedWeekdays: [[1]] as never },
    ];
    expect(changedParts(autumn, partsOf(unsaid, 1))).toEqual(['rules']);
  });

  it('moves with the parity a post’s locked weekdays are held in: the odd weeks’ Monday is not the even weeks’', () => {
    const held = (first: 'ODD_WEEKS' | 'EVEN_WEEKS', second: 'ODD_WEEKS' | 'EVEN_WEEKS', turned = false) => {
      const real = school();
      const entries = [
        { weekdays: [1], periods: [true, true], recurrence: first },
        { weekdays: [2], periods: [true, true], recurrence: second },
      ];
      real.payload.teacherDayLimits = [
        {
          id: 'post-bo',
          teacherId: 't-bo',
          maxTeachingDaysPerWeek: 2,
          lockedWeekdays: [[1], [2]] as never,
          lockedWeekdayPeriods: (turned ? [...entries].reverse() : entries) as never,
        },
      ];
      return real;
    };
    const base = partsOf(held('ODD_WEEKS', 'EVEN_WEEKS'));
    // Not by the order they are sent in, but by which parity holds which set.
    expect(partsOf(held('ODD_WEEKS', 'EVEN_WEEKS', true), 1)).toEqual(base);
    expect(changedParts(base, partsOf(held('EVEN_WEEKS', 'ODD_WEEKS'), 1))).toEqual(['rules']);
  });

  it('moves with which periods have an odd week, and a school that does not say it hashes as before', () => {
    const told = (odd?: number[]) => {
      const real = school();
      real.payload.periodWeeks = [1, 43];
      if (odd !== undefined) real.payload.periodOddWeeks = odd;
      return real;
    };
    expect(partsOf(told([1, 22]), 1)).toEqual(partsOf(told([1, 22])));
    // The first period's one week odd, or even: another reading of the year.
    expect(changedParts(partsOf(told([1, 22])), partsOf(told([0, 22]), 1))).toEqual(['requirements']);
    // And a year that says nothing is the reading it was before the field.
    expect(changedParts(partsOf(told([1, 22])), partsOf(told(), 1))).toEqual(['requirements']);
    const unsaid = school();
    unsaid.payload.periodWeeks = [1, 43];
    expect(partsOf(unsaid, 1)).toEqual(partsOf(told(), 1));
  });

  it('reads the walk in real ids, as a change of rooms and rules, and a school without it as before', () => {
    const walked = (minutes: number) => {
      const real = school();
      real.payload.rooms = real.payload.rooms.map((room, index) => ({
        ...room,
        siteId: index === 0 ? 'site-norra' : 'site-sodra',
      }));
      real.payload.siteTravelTimes = [{ siteAId: 'site-norra', siteBId: 'site-sodra', minutes }];
      return real;
    };
    // Whatever the sites' anonymous ids.
    expect(partsOf(walked(10), 1)).toEqual(partsOf(walked(10)));
    // Turned on: the rooms carry their sites and the walks, and the rules
    // say the walk is kept, so a stale schemaförslag names both.
    expect(changedParts(partsOf(school()), partsOf(walked(10), 1))).toEqual(['rooms', 'rules']);
    // A figure is the rooms' part alone.
    expect(changedParts(partsOf(walked(10)), partsOf(walked(15), 1))).toEqual(['rooms']);
  });

  it('reads the pupils’ cohorts in real ids, as a change of rules and rosters, and a school without them as before', () => {
    const counted = (pupils: number) => {
      const real = school();
      real.payload.pupilGaps = {
        cohorts: [
          { groupIds: ['grp-7a', 'grp-ma7'], fixedLessonIds: ['never-mapped'], homeGroupId: 'grp-7a', pupils },
          { groupIds: ['grp-7a'], fixedLessonIds: [], homeGroupId: 'grp-7a', pupils: 10 },
        ],
        fixedMargins: [{ fixedLessonId: 'never-mapped', minutesBefore: 0, minutesAfter: 15 }],
      };
      return real;
    };
    // Whatever the anonymous ids and the order the cohorts come back in.
    expect(partsOf(counted(12), 1)).toEqual(partsOf(counted(12)));
    // Turned on: the rules say it is kept, and the rosters carry the cohorts.
    expect(changedParts(partsOf(school()), partsOf(counted(12), 1))).toEqual(['rules', 'rosters']);
    // A pupil who moves between cohorts is the rosters' part alone.
    expect(changedParts(partsOf(counted(12)), partsOf(counted(11), 1))).toEqual(['rosters']);
  });

  it('reads a meal per period as a change of rules and of nothing else, and a school without it as before', () => {
    // Klassens måltid per del av läsåret (20270209090000): the gateway sends
    // the flag beside periodWeeks when the school has a lunch rule. A schemaförslag
    // solved with one meal all year is not one to apply beside a year that plans
    // one per part: stale once, in the rules it was solved under.
    const planned = (flag: boolean) => {
      const real = school();
      real.payload.periodWeeks = [18, 22];
      if (flag) real.payload.lunchPerPeriod = true;
      return real;
    };
    expect(changedParts(partsOf(planned(false)), partsOf(planned(true), 1))).toEqual(['rules']);
    expect(partsOf(planned(true), 1)).toEqual(partsOf(planned(true)));
    // And the key is read only when it is sent: a school without it hashes what it did.
    expect(partsOf(planned(false), 1)).toEqual(partsOf(planned(false)));
  });

  it('reads the placement rules in real ids, as a change of rules, and a school without them as before', () => {
    const ruled = (mode: 'SOFT' | 'HARD', notLast = false) => {
      const real = school();
      real.payload.placementRules = {
        subjectEdges: { mode, ...(mode === 'SOFT' ? { weight: 250 } : {}), subjects: [{ subjectId: 'sub-id', notFirst: true, notLast }, { subjectId: 'sub-ma', notFirst: false, notLast: true }] },
        places: { mode, maxClassRooms: 2 },
      };
      return real;
    };
    // Whatever the subjects' anonymous ids and the order they come back in.
    expect(partsOf(ruled('HARD'), 1)).toEqual(partsOf(ruled('HARD')));
    // Turned on after a run: the run was solved under other rules, and says so.
    expect(changedParts(partsOf(school()), partsOf(ruled('HARD'), 1))).toEqual(['rules']);
    // A rule that is held another way, or a mark on another end, is the rules' part alone.
    expect(changedParts(partsOf(ruled('HARD')), partsOf(ruled('SOFT'), 1))).toEqual(['rules']);
    expect(changedParts(partsOf(ruled('HARD')), partsOf(ruled('HARD', true), 1))).toEqual(['rules']);
    // A school that has none hashes as it always did.
    expect(partsOf(school(), 1)).toEqual(partsOf(school()));
  });

  it('reads a room’s building by its name and its shared mark, whatever the token it was sent under', () => {
    const housed = (building: string, shareable = false) => {
      const real = school();
      real.payload.rooms = real.payload.rooms.map((room, index) => ({
        ...room,
        ...(index === 0 ? { building } : {}),
        ...(index === 1 && shareable ? { shareable: true as const } : {}),
      }));
      return real;
    };
    // Two reads of an unchanged school mint other tokens and agree.
    expect(partsOf(housed('Hus B'), 1)).toEqual(partsOf(housed('Hus B')));
    // A room moved to another building, or marked shared, is the rooms' part alone.
    expect(changedParts(partsOf(housed('Hus B')), partsOf(housed('Hus C'), 1))).toEqual(['rooms']);
    expect(changedParts(partsOf(housed('Hus B')), partsOf(housed('Hus B', true), 1))).toEqual(['rooms']);
    // And the name is hashed, never held in the payload's token.
    expect(JSON.stringify(basisInputsOf(anonymised(housed('Hus B'))))).toContain('Hus B');
  });

  it('reads how many pupils sit a lock in a shared room, as a change of rosters', () => {
    const counted = (studentCount: number) => {
      const real = school();
      real.payload.fixedLessons = [
        {
          id: 'never-mapped',
          teacherId: 't-anna',
          coTeacherId: null,
          studentGroupId: 'grp-7a',
          roomId: 'room-hall',
          dayOfWeek: 2,
          startTime: '08:00:00',
          endTime: '09:00:00',
          studentCount,
        },
      ];
      return real;
    };
    expect(partsOf(counted(40), 1)).toEqual(partsOf(counted(40)));
    // The lock itself is the preserved part's, and carries no count there.
    expect(changedParts(partsOf(counted(40)), partsOf(counted(41), 1))).toEqual(['rosters']);
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
      recurrence: 'ALL_WEEKS' as const,
    };
    expect(preservedPartOf([row])).toBe(parts.preserved);
    expect(preservedPartOf([{ ...row, roomId: 'room-hall' }])).not.toBe(parts.preserved);
    // A/B-veckor: a lock moved to odd weeks is not the lock the run planned
    // around, and one sent with its parity digests the same from the row.
    expect(preservedPartOf([{ ...row, recurrence: 'ODD_WEEKS' }])).not.toBe(parts.preserved);
    const odd = school();
    odd.payload.fixedLessons[0]!.recurrence = 'ODD_WEEKS';
    expect(preservedPartOf([{ ...row, recurrence: 'ODD_WEEKS' }])).toBe(partsOf(odd).preserved);
  });

  it('terminer: reads a post’s periods in their order and the year’s lengths, and a school without them as before', () => {
    const plain = partsOf(school());
    const cut = (periods: boolean[], periodWeeks: number[]): BasisParts => {
      const real = school();
      real.payload.requirements[0] = { ...real.payload.requirements[0]!, periods };
      real.payload.periodWeeks = periodWeeks;
      return partsOf(real);
    };
    const autumn = cut([true, false], [19, 21]);
    // The autumn's post is not the spring's: a sorted mask would say it was.
    expect(cut([false, true], [19, 21]).requirements).not.toBe(autumn.requirements);
    // Nor is a year cut in another place the same year, mask for mask.
    expect(cut([true, false], [21, 19]).requirements).not.toBe(autumn.requirements);
    expect(cut([true, false], [19, 21])).toEqual(autumn);
    // Only the requirements part reads them, and only when they are sent.
    expect(autumn.requirements).not.toBe(plain.requirements);
    expect({ ...autumn, requirements: plain.requirements }).toEqual(plain);
  });

  it('terminer: reads a lock’s own dates, the same from the database as from the fetch, and an undated lock as before', () => {
    const plain = partsOf(school());
    const dated = (dates: { startDate: string | null; endDate: string | null }): BasisParts => {
      const source = anonymised(school());
      return basisPartsOf(
        basisInputsOf({ ...source, lockDates: new Map([[source.payload.fixedLessons[0]!.id, dates]]) }),
      );
    };
    const row = {
      studentGroupId: 'grp-7a',
      teacherId: 't-anna',
      coTeacherId: null,
      roomId: 'room-a1',
      dayOfWeek: 2,
      startTime: new Date('1970-01-01T08:00:00.000Z'),
      endTime: new Date('1970-01-01T09:00:00.000Z'),
      extraGroups: [{ studentGroupId: 'grp-ma7' }, { studentGroupId: 'grp-7b' }],
      recurrence: 'ALL_WEEKS' as const,
    };
    const autumn = dated({ startDate: null, endDate: '2026-12-18' });
    // A lock that ends in December is not the lock that runs all year, and
    // not the one that starts in January: a term moved makes the run stale.
    expect(autumn.preserved).not.toBe(plain.preserved);
    expect(dated({ startDate: '2027-01-11', endDate: null }).preserved).not.toBe(autumn.preserved);
    expect(dated({ startDate: null, endDate: '2026-12-11' }).preserved).not.toBe(autumn.preserved);
    // The apply's last check reads the row's dates and lands on the same digest.
    expect(preservedPartOf([{ ...row, startDate: null, endDate: new Date('2026-12-18T00:00:00.000Z') }])).toBe(
      autumn.preserved,
    );
    expect(preservedPartOf([{ ...row, startDate: null, endDate: null }])).toBe(plain.preserved);
    // No dates read, no dates hashed: a caller without the map is as before.
    expect(dated({ startDate: null, endDate: null })).toEqual(plain);
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

  it('reads a mirrored post’s shares too: who has which of its lessons is written with it, and a change makes the run stale', () => {
    const source = anonymised(school());
    const spring = {
      id: 'spring-post',
      mirrorOf: 'autumn-post',
      subjectId: 'hemkunskap',
      studentGroupId: '7A:2',
      teacherId: 'anna',
      coTeacherId: null,
    };
    const unshared = basisPartsOf(basisInputsOf({ ...source, mirrors: [spring] }));
    const shared = basisPartsOf(
      basisInputsOf({ ...source, mirrors: [{ ...spring, shares: [{ teacherId: 'bo', lessons: 1, minutes: 40 }] }] }),
    );
    expect(changedParts(unshared, shared)).toEqual(['requirements']);
    // Handed to another teacher, or another length: not the same week written.
    const other = (share: { teacherId: string | null; lessons: number; minutes: number }) =>
      basisPartsOf(basisInputsOf({ ...source, mirrors: [{ ...spring, shares: [share] }] }));
    expect(changedParts(shared, other({ teacherId: 'cecilia', lessons: 1, minutes: 40 }))).toEqual(['requirements']);
    expect(changedParts(shared, other({ teacherId: 'bo', lessons: 1, minutes: 60 }))).toEqual(['requirements']);
  });

  describe('Generera’s write: the parts it holds still', () => {
    it('are all of them but the draft’s, in the parts’ own order', () => {
      expect(WRITE_BASIS_PARTS).toEqual(['requirements', 'preserved', 'rooms', 'rules', 'rosters']);
      expect(WRITE_BASIS_PARTS).toEqual(BASIS_PARTS.filter((part) => part !== 'draft'));
    });

    it.each<[string, (real: School) => void, string[]]>([
      // The draft is what the write replaces: a lesson of it moved by hand, or
      // a hint the engine was given, is no change in what the answer depends on.
      ['a draft lesson is moved by hand', (s) => void (s.draftLessons[0]!.dayOfWeek = 5), []],
      ['a draft lesson gets a term', (s) => void (s.draftLessons[0]!.endDate = '2026-12-18'), []],
      ['a hint the engine is given moves', (s) => void (s.payload.previousLessons[0]!.startTime = '13:00:00'), []],
      // Each of the others is the question the engine was asked.
      ['a locked lesson moves to another weekday', (s) => void (s.payload.fixedLessons[0]!.dayOfWeek = 4), ['preserved']],
      ['a locked lesson is removed', (s) => void s.payload.fixedLessons.pop(), ['preserved']],
      ['a post’s teacher changes', (s) => void (s.payload.requirements[0]!.teacherId = 't-bo'), ['requirements']],
      ['a room gets smaller', (s) => void (s.payload.rooms[0]!.capacity = 20), ['rooms']],
      ['a reservation moves', (s) => void (s.payload.constraints[0]!.endTime = '11:00:00'), ['rules']],
      ['a class gets a pupil', (s) => void (s.payload.groups[0]!.lunchHeadcount = 25), ['rosters']],
    ])('%s: %j', (_edit, edit, expected) => {
      const before = partsOf(school());
      const changed = school();
      edit(changed);

      expect(changedPartsForWrite(before, partsOf(changed, 1))).toEqual(expected);
    });

    it('names a part once however many of its inputs moved, and the parts in the basis’ order', () => {
      const before = partsOf(school());
      const changed = school();
      changed.payload.groups[0]!.lunchHeadcount = 25;
      changed.payload.rooms[0]!.capacity = 20;
      changed.payload.rasts[0]!.startTime = '09:50:00';
      changed.payload.constraints[0]!.endTime = '11:00:00';
      changed.draftLessons[0]!.dayOfWeek = 5;

      expect(changedPartsForWrite(before, partsOf(changed, 1))).toEqual(['rooms', 'rules', 'rosters']);
    });

    it('is the candidate apply’s comparison less the draft’s part, so the two cannot disagree about anything else', () => {
      const before = partsOf(school());
      const changed = school();
      changed.payload.fixedLessons[0]!.roomId = 'room-hall';
      changed.draftLessons[0]!.dayOfWeek = 5;
      const now = partsOf(changed, 1);

      expect(changedParts(before, now)).toEqual(['preserved', 'draft']);
      expect(changedPartsForWrite(before, now)).toEqual(changedParts(before, now).filter((part) => part !== 'draft'));
    });
  });

  it('names every part changed against a stored value that is not a parts object', () => {
    const current = partsOf(school());
    expect(changedParts(null, current)).toEqual([...BASIS_PARTS]);
    expect(changedParts('a-string', current)).toEqual([...BASIS_PARTS]);
    expect(changedParts({ ...current }, current)).toEqual([]);
  });
});
