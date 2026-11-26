import {
  assess,
  GAP_DEFINITIONS,
  INTAKE_AREAS,
  INTAKE_FOUND,
  ITEM_CAP,
  YEAR_BOUND_AREAS,
  type IntakeFacts,
  type IntakeGapCode,
  type IntakeView,
} from './intake';

const none = { count: 0, names: [] as string[] };

/** A school with nothing missing: every gap's count is 0 until a test takes something away. */
function healthy(overrides: Partial<IntakeFacts> = {}): IntakeFacts {
  return {
    year: { id: 'year-1', name: '2026/2027', isActive: true, gradeNumbering: 'NIOARIG' },
    years: 1,
    subjects: 8,
    subjectsWithoutPost: none,
    subjectsNeedingMissingRoomType: none,
    rooms: 7,
    roomTypes: 3,
    frameTimes: [{ minGradeLevel: 7, maxGradeLevel: 9 }],
    rasts: 2,
    breaks: 6,
    lunchOn: true,
    lunchServings: 2,
    supervisionAreas: 3,
    supervisionShifts: 20,
    classes: 3,
    classGrades: [7, 8, 9],
    classesWithoutGrade: none,
    classesWithoutPost: none,
    teachingGroups: 2,
    teachingGroupsWithoutMembers: none,
    teachers: 12,
    students: 80,
    studentsWithoutClass: 0,
    timplanGrades: [
      { gradeLevel: 7, decided: true },
      { gradeLevel: 8, decided: true },
      { gradeLevel: 9, decided: true },
    ],
    requirements: 40,
    unstaffedRequirements: 0,
    unstaffedMode: 'ALLOW',
    posts: 12,
    postsWithoutSignature: 0,
    teachersWithoutPost: 0,
    switches: { absenceWatch: true, ack: true, viewer: true, sickReport: true },
    ...overrides,
  };
}

const gapOf = (view: IntakeView, code: IntakeGapCode) => view.areas.flatMap((area) => area.gaps).find((gap) => gap.code === code)!;
const there = (view: IntakeView) => view.areas.flatMap((area) => area.gaps).filter((gap) => gap.count > 0).map((gap) => gap.code);

describe('the shape of the answer', () => {
  it('is the same areas, found-counts and gaps for every school', () => {
    for (const facts of [healthy(), healthy({ year: null }), healthy({ rooms: 0, subjects: 0, teachers: 0 })]) {
      const view = assess(facts);
      expect(view.areas.map((area) => area.area)).toEqual([...INTAKE_AREAS]);
      for (const area of view.areas) {
        expect(Object.keys(area.found)).toEqual([...INTAKE_FOUND[area.area]]);
        expect(area.gaps.map((gap) => gap.code)).toEqual(GAP_DEFINITIONS.filter((definition) => definition.area === area.area).map((definition) => definition.code));
      }
    }
  });

  it('holds no name of a person: a gap lists names only of what it counts, and a presence gap lists none', () => {
    const view = assess(healthy({ rooms: 0, teachers: 0 }));
    expect(gapOf(view, 'NO_ROOMS')).toEqual({ code: 'NO_ROOMS', level: 'HARD', count: 1, items: [], more: 0 });
    expect(gapOf(view, 'NO_TEACHERS')).toEqual({ code: 'NO_TEACHERS', level: 'HARD', count: 1, items: [], more: 0 });
  });
});

describe('a school with nothing missing', () => {
  it('has no gap at all', () => {
    const view = assess(healthy());
    expect(there(view)).toEqual([]);
    expect(view).toMatchObject({ hard: 0, soft: 0, info: 0, year: { id: 'year-1', name: '2026/2027', isActive: true } });
  });
});

describe('an empty school', () => {
  it('has the one year gap, and what Generera would refuse in turn, and waits with the rest for the year', () => {
    const view = assess(
      healthy({
        year: null,
        years: 0,
        subjects: 0,
        rooms: 0,
        roomTypes: 0,
        frameTimes: [],
        rasts: 0,
        breaks: 0,
        lunchOn: false,
        lunchServings: 0,
        supervisionAreas: 0,
        supervisionShifts: 0,
        switches: { absenceWatch: false, ack: false, viewer: false, sickReport: false },
        classes: 0,
        classGrades: [],
        teachingGroups: 0,
        teachers: 0,
        students: 0,
        requirements: 0,
        timplanGrades: [],
        posts: 0,
      }),
    );
    // The lov and the rastvakt of a year wait with the year; room types, lunch and the four switches are the school's, and are said at once.
    expect(there(view)).toEqual([
      'NO_YEAR',
      'NO_SUBJECTS',
      'NO_ROOMS',
      'NO_ROOM_TYPES',
      'NO_RASTS',
      'LUNCH_OFF',
      'NO_TEACHERS',
      'NO_STUDENTS',
      'ABSENCE_WATCH_OFF',
      'ACK_OFF',
      'VIEWER_OFF',
      'SICK_REPORT_OFF',
    ]);
    expect(view).toMatchObject({ hard: 4, soft: 1, info: 7, year: null });
  });

  it('says the year-bound areas wait for the year, and no other area does', () => {
    const waiting = (view: IntakeView) => view.areas.filter((area) => area.waitsForYear).map((area) => area.area);
    expect(waiting(assess(healthy({ year: null })))).toEqual(['BREAKS', 'SUPERVISION', 'CLASSES', 'TEACHING_GROUPS', 'TIMPLAN', 'REQUIREMENTS', 'STAFFING']);
    expect([...YEAR_BOUND_AREAS]).toEqual(waiting(assess(healthy({ year: null }))));
    // With a year nothing waits, whatever the school holds: an empty year is a gap, not a wait.
    expect(waiting(assess(healthy()))).toEqual([]);
    expect(waiting(assess(healthy({ classes: 0, classGrades: [], requirements: 0 })))).toEqual([]);
  });

  it('counts a year-bound area as nothing found while there is no year to read', () => {
    const view = assess(healthy({ year: null, classes: 3, requirements: 40, posts: 12, teachingGroups: 2 }));
    const found = (area: string) => view.areas.find((entry) => entry.area === area)!.found;
    expect(found('CLASSES')).toEqual({ classes: 0 });
    expect(found('REQUIREMENTS')).toEqual({ requirements: 0 });
    expect(found('STAFFING')).toEqual({ posts: 0 });
    expect(found('TEACHING_GROUPS')).toEqual({ teachingGroups: 0 });
    expect(found('TIMPLAN')).toEqual({ gradesWithTimplan: 0 });
    expect(found('BREAKS')).toEqual({ breaks: 0 });
    expect(found('SUPERVISION')).toEqual({ supervisionAreas: 3, supervisionShifts: 0 });
  });
});

describe('what stops Generera', () => {
  it.each([
    ['NO_YEAR', { year: null }],
    ['NO_SUBJECTS', { subjects: 0 }],
    ['NO_ROOMS', { rooms: 0 }],
    ['NO_TEACHERS', { teachers: 0 }],
    ['NO_REQUIREMENTS', { requirements: 0 }],
    ['ROOM_TYPE_WITHOUT_ROOM', { subjectsNeedingMissingRoomType: { count: 1, names: ['Slöjd'] } }],
  ] as Array<[IntakeGapCode, Partial<IntakeFacts>]>)('is %s, and it is HARD', (code, overrides) => {
    const gap = gapOf(assess(healthy(overrides)), code);
    expect(gap.count).toBeGreaterThan(0);
    expect(gap.level).toBe('HARD');
  });

  it('is no class something that stops Generera: a post belongs to a class or to a teaching group, and the gateway and the engine ask for neither', () => {
    // A school whose posts are all on teaching groups has no class and a week to lay.
    const view = assess(healthy({ classes: 0, classGrades: [], classesWithoutGrade: none, classesWithoutPost: none, teachingGroups: 3 }));
    expect(gapOf(view, 'NO_CLASSES')).toMatchObject({ count: 1, level: 'SOFT' });
    expect(view.hard).toBe(0);
  });

  it('is a post with no teacher only when the school has chosen Vägra', () => {
    const allow = assess(healthy({ unstaffedRequirements: 3, unstaffedMode: 'ALLOW' }));
    const refuse = assess(healthy({ unstaffedRequirements: 3, unstaffedMode: 'REFUSE' }));
    expect(gapOf(allow, 'UNSTAFFED_POSTS')).toMatchObject({ count: 3, level: 'SOFT' });
    expect(gapOf(refuse, 'UNSTAFFED_POSTS')).toMatchObject({ count: 3, level: 'HARD' });
    expect([allow.hard, allow.soft]).toEqual([0, 1]);
    expect([refuse.hard, refuse.soft]).toEqual([1, 0]);
  });

  it('is not a post with no teacher when every post has one, under either choice', () => {
    expect(gapOf(assess(healthy({ unstaffedMode: 'REFUSE' })), 'UNSTAFFED_POSTS')).toMatchObject({ count: 0, level: 'HARD' });
    expect(assess(healthy({ unstaffedMode: 'REFUSE' })).hard).toBe(0);
  });
});

describe('what runs, worse', () => {
  it('is a class with no årskurs, a class with no post, an empty teaching group and no pupils', () => {
    const view = assess(
      healthy({
        classesWithoutGrade: { count: 1, names: ['Förberedelseklassen'] },
        classesWithoutPost: { count: 2, names: ['9B', '9A'] },
        teachingGroupsWithoutMembers: { count: 1, names: ['Ma71'] },
        students: 0,
      }),
    );
    for (const code of ['CLASSES_WITHOUT_GRADE', 'CLASSES_WITHOUT_POSTS', 'TEACHING_GROUPS_WITHOUT_MEMBERS', 'NO_STUDENTS'] as const) {
      expect(gapOf(view, code).level).toBe('SOFT');
      expect(gapOf(view, code).count).toBeGreaterThan(0);
    }
    expect(view).toMatchObject({ hard: 0, soft: 4 });
  });

  it('does not list every class as without a post when the school has no post at all: NO_REQUIREMENTS says it once', () => {
    const view = assess(healthy({ requirements: 0, classesWithoutPost: { count: 3, names: ['7A', '8A', '9A'] } }));
    expect(gapOf(view, 'CLASSES_WITHOUT_POSTS')).toMatchObject({ count: 0, items: [] });
    expect(gapOf(view, 'NO_REQUIREMENTS').count).toBe(1);
  });
});

describe('the frame times', () => {
  it('lists the årskurser with a class that no frame time spans', () => {
    const view = assess(healthy({ frameTimes: [{ minGradeLevel: 7, maxGradeLevel: 8 }] }));
    expect(gapOf(view, 'FRAME_TIMES_MISSING')).toMatchObject({ count: 1, items: ['9'], level: 'SOFT' });
  });

  it('lists every årskurs with a class when there is no frame time', () => {
    const view = assess(healthy({ frameTimes: [] }));
    expect(gapOf(view, 'FRAME_TIMES_MISSING')).toMatchObject({ count: 3, items: ['7', '8', '9'] });
  });

  it('holds the frame against the NIOARIG årskurs of a TIOARIG läsår: its åk 8 is NIOARIG 7', () => {
    const tioarig = { id: 'y', name: '2028/2029', isActive: true, gradeNumbering: 'TIOARIG' as const };
    // Frames are stated in NIOARIG and never move: 7–9 holds TIOARIG 8–10.
    const covered = assess(healthy({ year: tioarig, classGrades: [8, 9, 10], frameTimes: [{ minGradeLevel: 7, maxGradeLevel: 9 }] }));
    expect(gapOf(covered, 'FRAME_TIMES_MISSING').count).toBe(0);
    // The same frame and the same classes read as NIOARIG would leave 10 outside it.
    const nine = assess(healthy({ classGrades: [8, 9, 10], frameTimes: [{ minGradeLevel: 7, maxGradeLevel: 9 }] }));
    expect(gapOf(nine, 'FRAME_TIMES_MISSING')).toMatchObject({ count: 1, items: ['10'] });
    // A frame 8–9 leaves TIOARIG 8 (NIOARIG 7) outside, which a raw comparison would have called covered.
    const short = assess(healthy({ year: tioarig, classGrades: [8, 9, 10], frameTimes: [{ minGradeLevel: 8, maxGradeLevel: 9 }] }));
    expect(gapOf(short, 'FRAME_TIMES_MISSING')).toMatchObject({ count: 1, items: ['8'] });
  });

  it('counts a årskurs once however many classes it has, and ignores a class with none', () => {
    const view = assess(healthy({ frameTimes: [], classGrades: [7, 7, 7, null] }));
    expect(gapOf(view, 'FRAME_TIMES_MISSING')).toMatchObject({ count: 1, items: ['7'] });
  });
});

describe('the lokal timplan', () => {
  it('is missing for an årskurs with a class and no plan, and not decided for one whose plan is a draft', () => {
    const view = assess(
      healthy({
        timplanGrades: [
          { gradeLevel: 7, decided: true },
          { gradeLevel: 8, decided: false },
        ],
      }),
    );
    expect(gapOf(view, 'TIMPLAN_MISSING')).toMatchObject({ count: 1, items: ['9'], level: 'INFO' });
    expect(gapOf(view, 'TIMPLAN_NOT_DECIDED')).toMatchObject({ count: 1, items: ['8'], level: 'INFO' });
    expect(view.areas.find((area) => area.area === 'TIMPLAN')!.found).toEqual({ gradesWithTimplan: 2 });
  });

  it('is never a hard gap: a shortfall is under mål, not a refusal', () => {
    const view = assess(healthy({ timplanGrades: [] }));
    expect(gapOf(view, 'TIMPLAN_MISSING').level).toBe('INFO');
    expect(view.hard).toBe(0);
  });

  it('does not count a plan for an årskurs the school has no class in', () => {
    const view = assess(healthy({ timplanGrades: [{ gradeLevel: 1, decided: false }] }));
    expect(gapOf(view, 'TIMPLAN_NOT_DECIDED').count).toBe(0);
    expect(view.areas.find((area) => area.area === 'TIMPLAN')!.found).toEqual({ gradesWithTimplan: 0 });
  });
});

describe('the names a gap lists', () => {
  it('are sorted as a Swede reads classes (7A, 7B, 8A, 10A last), cut at the cap, and say how many were left out', () => {
    const names = ['10A', '8A', '7B', '7A', '9A', '9B', '8B', '9C', '6A', '5A', '4A'];
    const gap = gapOf(assess(healthy({ classesWithoutGrade: { count: names.length, names } })), 'CLASSES_WITHOUT_GRADE');
    expect(gap.items).toHaveLength(ITEM_CAP);
    expect(gap.items).toEqual(['4A', '5A', '6A', '7A', '7B', '8A', '8B', '9A']);
    expect(gap.more).toBe(names.length - ITEM_CAP);
    expect(gap.count).toBe(names.length);
  });

  it('say nothing was left out when the count is the list', () => {
    const gap = gapOf(assess(healthy({ classesWithoutGrade: { count: 2, names: ['B', 'A'] } })), 'CLASSES_WITHOUT_GRADE');
    expect(gap).toMatchObject({ items: ['A', 'B'], more: 0 });
  });

  it('count more than the list holds when the service read only the first names', () => {
    const gap = gapOf(assess(healthy({ classesWithoutGrade: { count: 20, names: ['A', 'B', 'C'] } })), 'CLASSES_WITHOUT_GRADE');
    expect(gap).toMatchObject({ count: 20, items: ['A', 'B', 'C'], more: 17 });
  });
});

describe('what the school has not set up or turned on (P5, Förvalen en ny skola möter)', () => {
  it.each([
    ['NO_ROOM_TYPES', { roomTypes: 0 }],
    ['NO_BREAKS', { breaks: 0 }],
    ['LUNCH_OFF', { lunchOn: false }],
    ['NO_SUPERVISION', { supervisionShifts: 0 }],
    ['ABSENCE_WATCH_OFF', { switches: { absenceWatch: false, ack: true, viewer: true, sickReport: true } }],
    ['ACK_OFF', { switches: { absenceWatch: true, ack: false, viewer: true, sickReport: true } }],
    ['VIEWER_OFF', { switches: { absenceWatch: true, ack: true, viewer: false, sickReport: true } }],
    ['SICK_REPORT_OFF', { switches: { absenceWatch: true, ack: true, viewer: true, sickReport: false } }],
  ] as Array<[IntakeGapCode, Partial<IntakeFacts>]>)('is %s, one gap, INFO, and no other', (code, overrides) => {
    const view = assess(healthy(overrides));
    expect(there(view)).toEqual([code]);
    expect(gapOf(view, code)).toEqual({ code, level: 'INFO', count: 1, items: [], more: 0 });
    // Nothing a school has not turned on stops Generera, makes its timetable worse or is anything but a row that says it is off.
    expect(view).toMatchObject({ hard: 0, soft: 0, info: 1 });
  });

  it('is none of them when the school has set everything up', () => {
    expect(there(assess(healthy()))).toEqual([]);
  });

  it('says the four switches each, and counts how many are on', () => {
    const view = assess(healthy({ switches: { absenceWatch: false, ack: true, viewer: false, sickReport: true } }));
    expect(there(view)).toEqual(['ABSENCE_WATCH_OFF', 'VIEWER_OFF']);
    expect(view.areas.find((area) => area.area === 'SWITCHES')!.found).toEqual({ switchesOn: 2 });
  });

  it('counts the room types beside the rooms, the serving rows beside lunch and the areas and passes of rastvakt', () => {
    const found = (area: string) => assess(healthy()).areas.find((entry) => entry.area === area)!.found;
    expect(found('ROOMS')).toEqual({ rooms: 7, roomTypes: 3 });
    expect(found('LUNCH')).toEqual({ lunchServings: 2 });
    expect(found('SUPERVISION')).toEqual({ supervisionAreas: 3, supervisionShifts: 20 });
    expect(found('BREAKS')).toEqual({ breaks: 6 });
  });

  it('does not say the year has no lov or no rastvakt while there is no year to read: the area waits', () => {
    const view = assess(healthy({ year: null, breaks: 0, supervisionShifts: 0 }));
    expect(gapOf(view, 'NO_BREAKS').count).toBe(0);
    expect(gapOf(view, 'NO_SUPERVISION').count).toBe(0);
    expect(view.areas.filter((area) => area.waitsForYear).map((area) => area.area)).toEqual(expect.arrayContaining(['BREAKS', 'SUPERVISION']));
  });

  it('is a presence gap that lists no name', () => {
    const view = assess(healthy({ roomTypes: 0, lunchOn: false, switches: { absenceWatch: false, ack: false, viewer: false, sickReport: false } }));
    for (const gap of view.areas.flatMap((area) => area.gaps).filter((entry) => entry.count > 0)) expect(gap).toMatchObject({ items: [], more: 0 });
  });
});

describe('what only another step reads', () => {
  it('is a teacher with no post, a post with no signature, a pupil with no class, a subject with no post and no rast', () => {
    const view = assess(
      healthy({
        teachersWithoutPost: 2,
        postsWithoutSignature: 5,
        studentsWithoutClass: 3,
        subjectsWithoutPost: { count: 1, names: ['Teknik'] },
        rasts: 0,
      }),
    );
    for (const code of ['TEACHERS_WITHOUT_POST', 'POSTS_WITHOUT_SIGNATURE', 'STUDENTS_WITHOUT_CLASS', 'SUBJECTS_WITHOUT_POSTS', 'NO_RASTS'] as const) {
      expect(gapOf(view, code).level).toBe('INFO');
      expect(gapOf(view, code).count).toBeGreaterThan(0);
    }
    expect(gapOf(view, 'SUBJECTS_WITHOUT_POSTS').items).toEqual(['Teknik']);
    expect(view).toMatchObject({ hard: 0, soft: 0, info: 5 });
  });
});
