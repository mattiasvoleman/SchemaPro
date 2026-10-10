import { selectLessons, selectionDigest, type SelectionCandidate, type SelectionRule } from './cancellation-selection';

const NOW = new Date('2026-10-12T08:00:00.000Z'); // Monday 10:00 in Stockholm

const lesson = (id: string, overrides: Partial<SelectionCandidate> = {}): SelectionCandidate => ({
  id,
  date: '2026-10-14',
  startsAt: new Date('2026-10-14T07:00:00.000Z'), // Wednesday 09:00
  endsAt: new Date('2026-10-14T08:00:00.000Z'),
  status: 'SCHEDULED',
  attendance: 0,
  studentGroupId: '9a',
  gradeLevel: 9,
  groupName: '9A',
  subjectName: 'Matematik',
  extraGroups: [],
  note: null,
  ...overrides,
});

const rule = (overrides: Partial<SelectionRule> = {}): SelectionRule => ({
  scope: 'SCHOOL',
  minGradeLevel: null,
  maxGradeLevel: null,
  groupIds: [],
  startTime: null,
  endTime: null,
  timezone: 'Europe/Stockholm',
  now: NOW,
  ...overrides,
});

describe('which lessons a bulk avbokning takes', () => {
  it('never a lesson that has begun, been changed or carries attendance, and says why', () => {
    const outcome = selectLessons(
      [
        lesson('ahead'),
        lesson('begun', { date: '2026-10-12', startsAt: new Date('2026-10-12T07:30:00.000Z'), endsAt: new Date('2026-10-12T08:30:00.000Z') }),
        lesson('cancelled', { status: 'CANCELLED' }),
        lesson('registered', { attendance: 3 }),
      ],
      rule(),
    );
    expect(outcome.matched.map((row) => row.id)).toEqual(['ahead']);
    expect(outcome.excluded).toEqual({ started: 1, notScheduled: 1, attendance: 1 });
  });

  it('takes a span of years through any class on the lesson, and names the groups with no year', () => {
    const outcome = selectLessons(
      [
        lesson('9a'),
        lesson('8a', { studentGroupId: '8a', gradeLevel: 8, groupName: '8A' }),
        lesson('8a-with-9b', { studentGroupId: '8a', gradeLevel: 8, extraGroups: [{ studentGroupId: '9b', gradeLevel: 9 }] }),
        lesson('spanska', { studentGroupId: 'sp', gradeLevel: null, groupName: 'Spanska 7–9' }),
      ],
      rule({ scope: 'GRADES', minGradeLevel: 9, maxGradeLevel: 9 }),
    );
    expect(outcome.matched.map((row) => row.id)).toEqual(['9a', '8a-with-9b']);
    expect(outcome.ungradedGroups).toEqual(['Spanska 7–9']);
  });

  it('takes named groups as the lesson\'s own group or an extra one', () => {
    const outcome = selectLessons(
      [lesson('own'), lesson('extra', { studentGroupId: 'x', extraGroups: [{ studentGroupId: '9a', gradeLevel: 9 }] }), lesson('other', { studentGroupId: '7c' })],
      rule({ scope: 'GROUPS', groupIds: ['9a'] }),
    );
    expect(outcome.matched.map((row) => row.id)).toEqual(['own', 'extra']);
  });

  it('narrows to a time of day on the school\'s clock', () => {
    const afternoon = lesson('afternoon', { startsAt: new Date('2026-10-14T12:00:00.000Z'), endsAt: new Date('2026-10-14T13:00:00.000Z') });
    const outcome = selectLessons([lesson('morning'), afternoon], rule({ startTime: '12:00', endTime: '16:00' }));
    expect(outcome.matched.map((row) => row.id)).toEqual(['afternoon']);
  });

  it('digests the selection and exactly the rows it took, whatever their order', () => {
    const selection = { fromDate: '2026-10-14', toDate: '2026-10-14', cause: 'EVENT', name: 'Prao', ...rule() };
    const one = selectionDigest(selection, [lesson('a'), lesson('b')]);
    expect(selectionDigest(selection, [lesson('b'), lesson('a')])).toBe(one);
    expect(selectionDigest(selection, [lesson('a')])).not.toBe(one);
    expect(selectionDigest({ ...selection, name: 'Friluftsdag' }, [lesson('a'), lesson('b')])).not.toBe(one);
  });
});
