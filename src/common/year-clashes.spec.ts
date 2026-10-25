import { yearClashes, type YearClashInput, type YearClashLesson } from './year-clashes';

/**
 * Ersättande grupper in the publish check (PUB_CLASHES) and the board: the
 * cases the shared fixture (year-clashes.contract.spec.ts) does not reach.
 * Alva is in 7A; SvA7 replaces Svenska (SV).
 */
const lesson = (id: string, studentGroupId: string, subjectId: string, extra: Partial<YearClashLesson> = {}): YearClashLesson => ({
  id,
  subjectId,
  dayOfWeek: 1,
  startTime: '10:00',
  endTime: '11:00',
  teacherId: `t-${id}`,
  roomId: `r-${id}`,
  studentGroupId,
  ...extra,
});

const base = (overrides: Partial<YearClashInput>): YearClashInput => ({
  lessons: [],
  constraints: [],
  studentGroupOf: [['alva', '7A']],
  memberships: [],
  pupilBuffers: [],
  ...overrides,
});

const groupClash = (input: YearClashInput, id: string) => (yearClashes(input).get(id) ?? []).some((hit) => hit.kind === 'GROUP');

describe('year clashes with replacing groups', () => {
  it('lets no replacing group of another läsår hide a named pupil’s clash, whatever the reader passed', () => {
    // Alva was in last year's SvA6, which replaced Svenska; the rollover kept
    // the membership. She is named on Ma7's lesson at the hour of 7A's svenska.
    const input = base({
      lessons: [lesson('sv', '7A', 'SV'), lesson('named', 'Ma7', 'MA', { studentIds: ['alva'] })],
      memberships: [{ studentId: 'alva', studentGroupId: 'SvA6' }],
      replacing: [{ id: 'SvA6', replacesSubjectId: 'SV', academicYearId: 'y25' }],
      academicYearId: 'y26',
    });
    expect(groupClash(input, 'sv')).toBe(true);
    // This year's SvA7 does take her off 7A's svenska: no clash.
    const thisYear = base({
      ...input,
      memberships: [{ studentId: 'alva', studentGroupId: 'SvA7' }],
      replacing: [{ id: 'SvA7', replacesSubjectId: 'SV', academicYearId: 'y26' }],
    });
    expect(groupClash(thisYear, 'sv')).toBe(false);
  });

  it('keeps a teaching group’s own svenska apart from SvA7 when they share a pupil', () => {
    // Sv7n is Svenska fördjupning, a teaching group and not a half; Alva is
    // in it and in SvA7. Placed in it, she goes there.
    const input = base({
      lessons: [lesson('fd', 'Sv7n', 'SV'), lesson('sva', 'SvA7', 'SVA')],
      memberships: [
        { studentId: 'alva', studentGroupId: 'Sv7n' },
        { studentId: 'alva', studentGroupId: 'SvA7' },
      ],
      replacing: [{ id: 'SvA7', replacesSubjectId: 'SV', academicYearId: 'y26' }],
      academicYearId: 'y26',
      kept: ['Sv7n'],
    });
    expect(groupClash(input, 'fd')).toBe(true);
  });

  it('keeps the lessons of two groups replacing svenska apart when a pupil is in both', () => {
    const input = base({
      lessons: [lesson('a', 'SvA7', 'SV'), lesson('b', 'SvA7s', 'SV')],
      memberships: [
        { studentId: 'alva', studentGroupId: 'SvA7' },
        { studentId: 'alva', studentGroupId: 'SvA7s' },
      ],
      replacing: [
        { id: 'SvA7', replacesSubjectId: 'SV', academicYearId: 'y26' },
        { id: 'SvA7s', replacesSubjectId: 'SV', academicYearId: 'y26' },
      ],
      academicYearId: 'y26',
      kept: ['SvA7', 'SvA7s'],
    });
    expect(groupClash(input, 'a')).toBe(true);
  });

  it('still lets SvA7 sit beside 7A’s svenska', () => {
    const input = base({
      lessons: [lesson('sv', '7A', 'SV'), lesson('sva', 'SvA7', 'SVA')],
      memberships: [{ studentId: 'alva', studentGroupId: 'SvA7' }],
      replacing: [{ id: 'SvA7', replacesSubjectId: 'SV', academicYearId: 'y26' }],
      academicYearId: 'y26',
      kept: ['SvA7'],
    });
    expect(groupClash(input, 'sv')).toBe(false);
  });
});
