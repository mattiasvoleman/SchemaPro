import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTxMock } from '../../test/utils/prisma-mock';
import {
  gradeOn,
  isSchoolDay,
  readSchoolDayBasis,
  schoolDaysOf,
  type SchoolDayBasis,
  type SchoolDayBreak,
  type SchoolDayEnrollment,
  type SchoolDayYear,
} from './school-days';

interface Case {
  name: string;
  years: SchoolDayYear[];
  breaks: SchoolDayBreak[];
  enrollments: SchoolDayEnrollment[];
  from: string;
  to: string;
  days: string[];
}

const CASES = (JSON.parse(readFileSync(join(__dirname, 'school-days.cases.json'), 'utf8')) as { cases: Case[] }).cases;
const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

describe('skoldagar: the table app.leave_school_days is held to as well', () => {
  it('has the cases the rule turns on', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(13);
    expect(new Set(CASES.map((entry) => entry.name)).size).toBe(CASES.length);
  });

  it.each(CASES.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
    const basis: SchoolDayBasis = { years: entry.years, breaks: entry.breaks, enrollments: entry.enrollments };
    expect(schoolDaysOf(basis, entry.from, entry.to)).toEqual(entry.days);
  });
});

describe('skoldagar, the parts', () => {
  const year = { startDate: '2026-08-17', endDate: '2027-06-11' };

  it('reads the årskurs of the segment holding the day, validTo exclusive, and none outside every segment', () => {
    const segments = [
      { validFrom: '2026-08-17', validTo: '2027-03-17', gradeLevel: 8 },
      { validFrom: '2027-03-17', validTo: null, gradeLevel: 9 },
    ];
    expect(gradeOn(segments, '2027-03-16')).toBe(8);
    expect(gradeOn(segments, '2027-03-17')).toBe(9);
    expect(gradeOn(segments, '2028-01-10')).toBe(9);
    expect(gradeOn(segments, '2026-08-16')).toBeNull();
    // validTo is the first day OUTSIDE the class: a pupil who left on it has none that day.
    expect(gradeOn([{ validFrom: '2026-08-17', validTo: '2027-01-07', gradeLevel: 7 }], '2027-01-07')).toBeNull();
    expect(gradeOn([{ validFrom: '2026-08-17', validTo: '2027-01-07', gradeLevel: 7 }], '2027-01-06')).toBe(7);
  });

  it('takes the later segment where two years overlap, as the SQL orders by Från', () => {
    const segments = [
      { validFrom: '2026-08-17', validTo: null, gradeLevel: 8 },
      { validFrom: '2027-08-16', validTo: null, gradeLevel: 9 },
    ];
    expect(gradeOn(segments, '2027-09-01')).toBe(9);
  });

  it('a Sunday is never a skoldag, whatever else holds', () => {
    expect(isSchoolDay({ years: [year], breaks: [], enrollments: [] }, '2027-02-07')).toBe(false);
  });

  it('a lov that does not cover the pupil leaves the day a skoldag', () => {
    const prao = { startDate: '2027-03-15', endDate: '2027-03-19', minGradeLevel: 9, maxGradeLevel: 9 };
    const enrollments = [{ validFrom: '2026-08-17', validTo: null, gradeLevel: 7 }];
    expect(isSchoolDay({ years: [year], breaks: [prao], enrollments }, '2027-03-15')).toBe(true);
  });
});

describe('readSchoolDayBasis', () => {
  const SCHOOL = '5c5c5c5c-5c5c-45c5-85c5-5c5c5c5c5c5c';
  const PUPIL = 'e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1';

  it('asks the school’s every läsår, the breaks over the period and the pupil’s segments over it, and reads them as days', async () => {
    const tx = createTxMock();
    tx.academicYear.findMany.mockResolvedValue([{ startDate: day('2026-08-17'), endDate: day('2027-06-11') }]);
    tx.schoolBreak.findMany.mockResolvedValue([
      { startDate: day('2027-02-22'), endDate: day('2027-02-26'), minGradeLevel: null, maxGradeLevel: null },
    ]);
    tx.studentEnrollment.findMany.mockResolvedValue([
      { validFrom: day('2026-08-17'), validTo: null, gradeLevel: 8 },
      { validFrom: day('2026-08-17'), validTo: day('2027-01-07'), gradeLevel: 7 },
    ]);

    const basis = await readSchoolDayBasis(tx as never, SCHOOL, PUPIL, '2027-02-18', '2027-03-02');

    expect(tx.academicYear.findMany).toHaveBeenCalledWith({ where: { schoolId: SCHOOL }, select: { startDate: true, endDate: true } });
    expect(tx.schoolBreak.findMany).toHaveBeenCalledWith({
      where: { schoolId: SCHOOL, startDate: { lte: day('2027-03-02') }, endDate: { gte: day('2027-02-18') } },
      select: { startDate: true, endDate: true, minGradeLevel: true, maxGradeLevel: true },
    });
    expect(tx.studentEnrollment.findMany).toHaveBeenCalledWith({
      where: {
        schoolId: SCHOOL,
        studentId: PUPIL,
        validFrom: { lte: day('2027-03-02') },
        OR: [{ validTo: null }, { validTo: { gt: day('2027-02-18') } }],
      },
      select: { validFrom: true, validTo: true, gradeLevel: true },
    });
    expect(basis).toEqual({
      years: [{ startDate: '2026-08-17', endDate: '2027-06-11' }],
      breaks: [{ startDate: '2027-02-22', endDate: '2027-02-26', minGradeLevel: null, maxGradeLevel: null }],
      enrollments: [
        { validFrom: '2026-08-17', validTo: null, gradeLevel: 8 },
        { validFrom: '2026-08-17', validTo: '2027-01-07', gradeLevel: 7 },
      ],
    });
    expect(schoolDaysOf(basis, '2027-02-18', '2027-03-02')).toEqual(['2027-02-18', '2027-02-19', '2027-03-01', '2027-03-02']);
  });
});
