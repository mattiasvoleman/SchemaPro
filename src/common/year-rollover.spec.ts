import {
  crossesIsoWeek53,
  dateShiftDays,
  defaultGraduatingGrade,
  easterSunday,
  frameChanges,
  isoWeekOf,
  isoWeeksIn,
  mapPeriod,
  nameCollisions,
  promoteName,
  proposeBreak,
  resolveGroups,
  volumeFindings,
  type RolloverGroupInput,
} from './year-rollover';

const SOURCE = { startDate: '2026-08-17', endDate: '2027-06-11' };
const TARGET = { startDate: '2027-08-16', endDate: '2028-06-09' };
const SHIFT = dateShiftDays(SOURCE.startDate, TARGET.startDate);

const group = (
  id: string,
  name: string,
  gradeLevel: number | null,
  kind: RolloverGroupInput['kind'] = 'CLASS',
): RolloverGroupInput => ({ id, name, gradeLevel, kind });

describe('promoteName', () => {
  it.each([
    ['7A', 7, '8A', 'PROMOTED'],
    ['Klass 7B', 7, 'Klass 8B', 'PROMOTED'],
    ['8-2', 8, '9-2', 'PROMOTED'],
    ['9', 9, '10', 'PROMOTED'],
    ['0A', 0, '1A', 'PROMOTED'],
    ['7A7', 7, '7A7', 'KEPT_AMBIGUOUS'],
    ['Ma71', 7, 'Ma71', 'KEPT_AMBIGUOUS'],
    ['17A', 1, '17A', 'KEPT_AMBIGUOUS'],
    ['Ugglan', 3, 'Ugglan', 'KEPT_NO_GRADE_DIGIT'],
    ['FA', 0, '1A', 'F_KLASS'],
    ['F-B', 0, '1B', 'F_KLASS'],
    ['Fsk C', 0, '1C', 'F_KLASS'],
    ['F-klass D', 0, '1D', 'F_KLASS'],
    ['FA', 1, 'FA', 'KEPT_NO_GRADE_DIGIT'],
    ['Fjärilen', 0, 'Fjärilen', 'KEPT_NO_GRADE_DIGIT'],
    ['Språkval', null, 'Språkval', 'KEPT'],
  ] as const)('%s in åk %s becomes %s (%s)', (name, grade, expected, status) => {
    expect(promoteName(name, grade)).toEqual({ name: expected, status });
  });
});

describe('resolveGroups', () => {
  const groups = [
    group('7a', '7A', 7),
    group('8a', '8A', 8),
    group('9a', '9A', 9),
    group('ugg', 'Ugglan', null),
    group('ma7', 'Ma7 grupp 1', 7, 'TEACHING_GROUP'),
    group('sv9', 'Sv9', 9, 'TEACHING_GROUP'),
  ];
  const byId = (resolved: ReturnType<typeof resolveGroups>) =>
    Object.fromEntries(resolved.map((row) => [row.sourceGroupId, row]));

  it('promotes below G, graduates at G, carries a class with no grade', () => {
    const resolved = byId(resolveGroups(groups, 9, { carryTeachingGroups: true }));
    expect(resolved['7a']).toMatchObject({ outcome: 'PROMOTE', successor: { name: '8A', gradeLevel: 8 } });
    expect(resolved['8a']).toMatchObject({ outcome: 'PROMOTE', successor: { name: '9A', gradeLevel: 9 } });
    expect(resolved['9a']).toMatchObject({ outcome: 'GRADUATE', successor: null });
    expect(resolved['ugg']).toMatchObject({ outcome: 'CARRY', noGrade: true, successor: { name: 'Ugglan', gradeLevel: null } });
    expect(resolved['ma7']).toMatchObject({ outcome: 'PROMOTE', successor: { name: 'Ma8 grupp 1', gradeLevel: 8 } });
    expect(resolved['sv9']).toMatchObject({ outcome: 'GRADUATE', successor: null });
  });

  it('skips teaching groups when they are not carried', () => {
    const resolved = byId(resolveGroups(groups, 9, { carryTeachingGroups: false }));
    expect(resolved['ma7']).toMatchObject({ outcome: 'SKIP', successor: null });
    expect(resolved['7a']).toMatchObject({ outcome: 'PROMOTE' });
  });

  it('refuses PROMOTE on a graduating group and on a group with no grade, keeping the default', () => {
    const resolved = byId(
      resolveGroups(
        groups,
        9,
        { carryTeachingGroups: true },
        new Map([
          ['9a', { outcome: 'PROMOTE' as const }],
          ['ugg', { outcome: 'PROMOTE' as const }],
        ]),
      ),
    );
    expect(resolved['9a']).toMatchObject({ outcome: 'GRADUATE', error: 'PROMOTE_GRADUATING' });
    expect(resolved['ugg']).toMatchObject({ outcome: 'CARRY', error: 'PROMOTE_WITHOUT_GRADE' });
  });

  it('opens an intake twin beside the promoted lowest class, unlinked, and refuses INTAKE elsewhere', () => {
    const resolved = byId(
      resolveGroups(
        groups,
        9,
        { carryTeachingGroups: true },
        new Map([
          ['7a', { outcome: 'INTAKE' as const }],
          ['8a', { outcome: 'INTAKE' as const }],
          ['ma7', { outcome: 'INTAKE' as const }],
        ]),
      ),
    );
    expect(resolved['7a']).toMatchObject({
      outcome: 'INTAKE',
      successor: { name: '8A', gradeLevel: 8 },
      intake: { name: '7A', gradeLevel: 7 },
      error: null,
    });
    expect(resolved['8a']).toMatchObject({ outcome: 'PROMOTE', intake: null, error: 'INTAKE_NOT_LOWEST' });
    expect(resolved['ma7']).toMatchObject({ error: 'INTAKE_NOT_LOWEST' });
  });

  it('takes a typed name for the successor, and SKIP and CARRY on any group', () => {
    const resolved = byId(
      resolveGroups(
        groups,
        9,
        { carryTeachingGroups: true },
        new Map([
          ['8a', { outcome: 'PROMOTE' as const, name: '  9 Gul ' }],
          ['9a', { outcome: 'CARRY' as const }],
          ['7a', { outcome: 'SKIP' as const }],
        ]),
      ),
    );
    expect(resolved['8a']).toMatchObject({ successor: { name: '9 Gul' }, nameStatus: 'OVERRIDDEN' });
    expect(resolved['9a']).toMatchObject({ outcome: 'CARRY', successor: { name: '9A', gradeLevel: 9 } });
    expect(resolved['7a']).toMatchObject({ outcome: 'SKIP', successor: null });
  });
});

describe('nameCollisions', () => {
  it('blocks two successors with one name, and warns on a difference of case', () => {
    const resolved = resolveGroups(
      [group('7a', '7A', 7), group('8a', '8A', 8), group('ka', '8a', null)],
      9,
      { carryTeachingGroups: true },
    );
    expect(nameCollisions(resolved)).toEqual([
      { name: '8A / 8a', sourceGroupIds: ['7a', 'ka'], caseOnly: true },
    ]);
    const exact = resolveGroups(
      [group('7a', '7A', 7), group('x', '8A', null)],
      9,
      { carryTeachingGroups: true },
    );
    expect(nameCollisions(exact)).toEqual([{ name: '8A', sourceGroupIds: ['7a', 'x'], caseOnly: false }]);
  });

  it('counts the intake twin’s name', () => {
    const resolved = resolveGroups(
      [group('6a', '6A', 6), group('x', 'Gamla 7A', null)],
      9,
      { carryTeachingGroups: true },
      new Map([
        ['6a', { outcome: 'INTAKE' as const }],
        ['x', { name: '6A' }],
      ]),
    );
    expect(nameCollisions(resolved)).toEqual([{ name: '6A', sourceGroupIds: ['6a', 'x'], caseOnly: false }]);
  });
});

describe('defaultGraduatingGrade', () => {
  it('takes the newest decided plan per form, falls back to the classes, and asks on a conflict', () => {
    expect(
      defaultGraduatingGrade(
        [
          { schoolForm: 'GRUNDSKOLA', decidedAt: '2025-05-01T00:00:00Z', maxGradeLevel: 6 },
          { schoolForm: 'GRUNDSKOLA', decidedAt: '2026-05-01T00:00:00Z', maxGradeLevel: 9 },
        ],
        [7, 8, 9],
      ),
    ).toEqual({ value: 9, source: 'TIMPLAN', conflict: null });
    expect(defaultGraduatingGrade([], [1, 2, 6])).toEqual({ value: 6, source: 'CLASSES', conflict: null });
    expect(defaultGraduatingGrade([], [])).toEqual({ value: null, source: 'NONE', conflict: null });
    expect(
      defaultGraduatingGrade([{ schoolForm: 'GRUNDSKOLA', decidedAt: '2026', maxGradeLevel: 9 }], [4, 5, 6]),
    ).toEqual({ value: 9, source: 'TIMPLAN', conflict: { timplan: [9], classes: 6 } });
    expect(
      defaultGraduatingGrade(
        [
          { schoolForm: 'GRUNDSKOLA', decidedAt: '2026', maxGradeLevel: 9 },
          { schoolForm: 'SPECIALSKOLA', decidedAt: '2026', maxGradeLevel: 10 },
        ],
        [9, 10],
      ),
    ).toEqual({ value: null, source: 'TIMPLAN', conflict: { timplan: [9, 10], classes: 10 } });
  });
});

describe('dates', () => {
  it('shifts by whole weeks and sees 2026’s week 53', () => {
    expect(SHIFT).toBe(364);
    expect(isoWeeksIn(2026)).toBe(53);
    expect(isoWeeksIn(2027)).toBe(52);
    expect(crossesIsoWeek53(SOURCE.startDate, TARGET.startDate)).toBe(true);
    expect(crossesIsoWeek53('2027-08-16', '2028-08-14')).toBe(false);
    expect(isoWeekOf('2026-12-31')).toEqual({ year: 2026, week: 53, weekday: 4 });
  });

  it('anchors a period at the year’s bounds, shifts the rest, and drops what still falls outside', () => {
    expect(mapPeriod(null, null, SOURCE, TARGET, SHIFT)).toEqual({ startDate: null, endDate: null, status: 'UNCHANGED' });
    expect(mapPeriod('2027-01-11', '2027-06-11', SOURCE, TARGET, SHIFT)).toEqual({
      startDate: '2028-01-10',
      endDate: '2028-06-09',
      status: 'BOUND_ANCHORED',
    });
    expect(mapPeriod('2026-09-01', '2026-12-18', SOURCE, TARGET, SHIFT)).toEqual({
      startDate: '2027-08-31',
      endDate: '2027-12-17',
      status: 'SHIFTED',
    });
    // A target year that ends two days earlier: a date one day before the
    // source end shifts a day past the target end, and is pulled onto it.
    const shorter = { startDate: '2027-08-16', endDate: '2028-06-07' };
    expect(mapPeriod('2027-01-11', '2027-06-10', SOURCE, shorter, SHIFT)).toEqual({
      startDate: '2028-01-10',
      endDate: '2028-06-07',
      status: 'BOUND_ANCHORED',
    });
    // A week or more outside is a period that does not fit: still dropped.
    expect(mapPeriod('2027-01-11', '2027-06-10', SOURCE, { ...shorter, endDate: '2028-06-01' }, SHIFT).status).toBe('DROPPED');
    expect(mapPeriod('2027-01-11', '2027-06-11', SOURCE, shorter, SHIFT)).toMatchObject({
      endDate: '2028-06-07',
      status: 'BOUND_ANCHORED',
    });
  });

  it('pulls a date the whole-week rounding lands just outside the target onto its bound, instead of dropping the row', () => {
    // Monday 2026-08-17 into Wednesday 2027-08-18: 366 days rounds to 364, so
    // a hösttermin from the source's second day lands a day before the target.
    const source = { startDate: '2026-08-17', endDate: '2027-06-11' };
    const target = { startDate: '2027-08-18', endDate: '2028-06-09' };
    const shift = dateShiftDays(source.startDate, target.startDate);
    expect(shift).toBe(364);
    expect(mapPeriod('2026-08-18', '2027-01-15', source, target, shift)).toEqual({
      startDate: '2027-08-18',
      endDate: '2028-01-14',
      status: 'BOUND_ANCHORED',
    });
  });

  it('computes Easter', () => {
    expect([2026, 2027, 2028, 2029].map(easterSunday)).toEqual([
      '2026-04-05',
      '2027-03-28',
      '2028-04-16',
      '2029-04-01',
    ]);
  });

  it('proposes lov dates by jul, påsk and ISO week, and none for a week that does not exist', () => {
    expect(proposeBreak({ startDate: '2026-10-26', endDate: '2026-10-30' }, SOURCE, TARGET)).toEqual({
      proposedStart: '2027-11-01',
      proposedEnd: '2027-11-05',
      anchor: 'ISO_WEEK',
      fits: true,
    });
    expect(proposeBreak({ startDate: '2026-12-21', endDate: '2027-01-06' }, SOURCE, TARGET)).toEqual({
      proposedStart: '2027-12-20',
      proposedEnd: '2028-01-05',
      anchor: 'CHRISTMAS',
      fits: true,
    });
    expect(proposeBreak({ startDate: '2027-03-29', endDate: '2027-04-02' }, SOURCE, TARGET)).toEqual({
      proposedStart: '2028-04-17',
      proposedEnd: '2028-04-21',
      anchor: 'EASTER',
      fits: true,
    });
    expect(proposeBreak({ startDate: '2026-12-28', endDate: '2026-12-30' }, SOURCE, TARGET)).toEqual({
      proposedStart: null,
      proposedEnd: null,
      anchor: 'NONE',
      fits: false,
    });
    // Sportlov v8 stays v8; a lov proposed outside a short target year does not fit.
    expect(proposeBreak({ startDate: '2027-02-22', endDate: '2027-02-26' }, SOURCE, TARGET)).toMatchObject({
      proposedStart: '2028-02-21',
      anchor: 'ISO_WEEK',
      fits: true,
    });
    expect(
      proposeBreak({ startDate: '2027-06-07', endDate: '2027-06-11' }, SOURCE, { ...TARGET, endDate: '2028-06-02' }),
    ).toMatchObject({ fits: false });
  });
});

describe('the jullov proposal', () => {
  it('keeps 24 December inside when the year’s own shift is 371 days across a week 53', () => {
    // A school that starts in ISO week 34 both years: 2026-08-17 → 2027-08-23.
    const source = { startDate: '2026-08-17', endDate: '2027-06-11' };
    const target = { startDate: '2027-08-23', endDate: '2028-06-09' };
    expect(dateShiftDays(source.startDate, target.startDate)).toBe(371);
    expect(proposeBreak({ startDate: '2026-12-21', endDate: '2027-01-08' }, source, target)).toEqual({
      proposedStart: '2027-12-20',
      proposedEnd: '2028-01-07',
      anchor: 'CHRISTMAS',
      fits: true,
    });
  });

  it('takes the next whole week when 364 days would leave 24 December just outside, and 364 when no week keeps it', () => {
    // Thursday 17 to Thursday 24 December 2026; julafton 2027 is a Friday,
    // which 364 days (16–23 December) misses and 371 (23–30 December) keeps.
    expect(proposeBreak({ startDate: '2026-12-17', endDate: '2026-12-24' }, SOURCE, TARGET)).toEqual({
      proposedStart: '2027-12-23',
      proposedEnd: '2027-12-30',
      anchor: 'CHRISTMAS',
      fits: true,
    });
    // Monday to Thursday can hold no Friday at any whole-week move: 364 days.
    expect(proposeBreak({ startDate: '2026-12-21', endDate: '2026-12-24' }, SOURCE, TARGET)).toMatchObject({
      proposedStart: '2027-12-20',
      proposedEnd: '2027-12-23',
    });
  });
});

describe('volumeFindings', () => {
  it('compares the carried minutes, averaged over the year, with the plan per subject', () => {
    const rows = [
      { subjectId: 'ma', lessonsPerWeek: 3, minutesPerLesson: 60, recurrence: 'ALL_WEEKS' as const, startDate: null, endDate: null },
      { subjectId: 'sl', lessonsPerWeek: 1, minutesPerLesson: 60, recurrence: 'ODD_WEEKS' as const, startDate: null, endDate: null },
      { subjectId: 'tk', lessonsPerWeek: 2, minutesPerLesson: 60, recurrence: 'ALL_WEEKS' as const, startDate: '2027-08-16', endDate: '2027-12-31' },
    ];
    const planned = new Map([
      ['ma', 180],
      ['sl', 30],
      ['tk', 120],
      ['en', 0],
      ['bi', 60],
    ]);
    expect(volumeFindings(rows, planned, TARGET)).toEqual([
      { subjectId: 'bi', carried: 0, planned: 60 },
      { subjectId: 'tk', carried: 55, planned: 120 },
    ]);
  });
});

describe('frameChanges', () => {
  it('flags a class rule whose school day differs in the next grade', () => {
    const frames = [
      { minGradeLevel: 1, maxGradeLevel: 3, dayOfWeek: null, startTime: '08:00', endTime: '13:30' },
      { minGradeLevel: 4, maxGradeLevel: 9, dayOfWeek: null, startTime: '08:00', endTime: '15:30' },
    ];
    expect(frameChanges(frames, 3)).toBe(true);
    expect(frameChanges(frames, 7)).toBe(false);
  });
});
