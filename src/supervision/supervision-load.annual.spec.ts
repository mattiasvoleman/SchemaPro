import { buildTeacherLoadReport, DEFAULT_LOAD_POLICY, type LoadInput } from '../staffing/teacher-load';
import { supervisionOfTeachers, withSupervision, type LoadShift } from './supervision-load';

/**
 * The card states the rota's hours as a part of the report's uppdrag ("Därav rastvakt enligt rastvaktsschemat" under "Uppdrag per läsår"),
 * and a pass IS an uppdrag in the report (withSupervision), so the two must count a pass the same way: a part is never more than the whole
 * (granskningen av #400). The report counts school days as fifths of a week since L-5; a pass sits on one weekday its dates fall on, so a
 * dated one holds once in every week it touches, and 15.2 weeks of days would drop 0.8 of a week from every dated pass.
 */

const ANNA = 'anna';
const clock = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
const pass = (from: string, to: string, rest: Partial<LoadShift> = {}): LoadShift => ({
  userId: ANNA,
  start: clock(from),
  end: clock(to),
  validFrom: null,
  validTo: null,
  countsAsTeaching: false,
  ...rest,
});

const states = (year: { startDate: string; endDate: string }, shifts: LoadShift[], closures: LoadInput['closures'] = []) => {
  const input: LoadInput = {
    year,
    policy: { ...DEFAULT_LOAD_POLICY, fullTimeTeachingMinutesPerWeek: 1080 },
    employments: [],
    requirements: [],
    qualifications: [],
    closures,
    duties: withSupervision([], shifts, year),
  };
  const report = buildTeacherLoadReport(input);
  return {
    duty: report.teachers.find((teacher) => teacher.userId === ANNA)!.annual.dutyHoursPerYear,
    rota: supervisionOfTeachers([], shifts, year, closures)[0]!.hoursPerYear,
  };
};

describe('the rota\'s hours are a part of the report\'s uppdrag hours', () => {
  const YEARS = [
    { startDate: '2026-08-17', endDate: '2027-06-11' }, // Monday to Friday
    { startDate: '2026-08-18', endDate: '2027-06-10' }, // the production year: Tuesday to Thursday
    { startDate: '2026-08-15', endDate: '2027-06-11' }, // Saturday to Friday
    { startDate: '2026-08-21', endDate: '2027-06-14' }, // Friday to Monday
  ];
  const LOV = [
    { startDate: '2026-10-26', endDate: '2026-10-30' },
    { startDate: '2026-12-21', endDate: '2027-01-08' },
  ];
  // A Wednesday pass all year, a Wednesday pass for the autumn term (2 September to 16 December, both Wednesdays), and one single Monday.
  const shifts = [
    pass('08:00', '09:00'),
    pass('12:00', '12:30', { validFrom: '2026-09-02', validTo: '2026-12-16' }),
    pass('10:00', '10:20', { validFrom: '2026-09-21', validTo: '2026-09-21' }),
  ];

  it.each(YEARS.flatMap((year) => [[year, []], [year, LOV]] as const))('%j with lov %j: the rota states exactly the hours the report counts for the passes', (year, closures) => {
    const { duty, rota } = states(year, shifts, [...closures]);
    expect(rota).toBe(duty);
  });

  it('counts a dated pass once in every week it touches: 16 Wednesdays of 30 minutes are 8 h, and a single Monday of 20 minutes is a third of an hour', () => {
    const year = YEARS[1]!;
    const term = states(year, [shifts[1]!]);
    expect(term).toEqual({ duty: 8, rota: 8 });
    const once = states(year, [shifts[2]!]);
    expect(once).toEqual({ duty: 0.3, rota: 0.3 });
  });

  it('counts a pass that runs all year in school days, as every undated uppdrag: 60 minutes over the 42.6 weeks of the production year', () => {
    expect(states(YEARS[1]!, [shifts[0]!])).toEqual({ duty: 42.6, rota: 42.6 });
  });
});
