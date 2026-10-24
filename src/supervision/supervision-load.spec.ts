import { buildTeacherLoadReport, type LoadInput } from '../staffing/teacher-load';
import { supervisionOfTeachers, withSupervision, type KindedDuty, type LoadShift } from './supervision-load';

/**
 * Rastvakt in the load (Rastvaktsschema, 20261202090000). The year is the
 * four weeks from Monday 7 September 2026 to Sunday 4 October. Anna has an
 * uppdrag "Rastvakt 60 min/vecka" and a mentorskap of 90; Bo a Rastvakt of
 * 40 and no pass.
 */

const YEAR = { startDate: '2026-09-07', endDate: '2026-10-04' };
const clock = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));

const duty = (userId: string, kind: KindedDuty['kind'], minutesPerWeek: number, rest: Partial<KindedDuty> = {}): KindedDuty => ({
  userId,
  kind,
  minutesPerWeek,
  countsAsTeaching: false,
  ...rest,
});
const shift = (userId: string, from: string, to: string, rest: Partial<LoadShift> = {}): LoadShift => ({
  userId,
  start: clock(from),
  end: clock(to),
  validFrom: null,
  validTo: null,
  countsAsTeaching: false,
  ...rest,
});

const DUTIES = [duty('anna', 'RASTVAKT', 60), duty('anna', 'MENTORSKAP', 90), duty('bo', 'RASTVAKT', 40)];
/** Monday on the yard, Wednesday's rastaktivitet, which the school counts as undervisning. */
const ANNA = [shift('anna', '10:00', '10:20'), shift('anna', '12:00', '12:30', { countsAsTeaching: true })];

const input = (duties: LoadInput['duties'], closures: LoadInput['closures'] = []): LoadInput => ({
  year: YEAR,
  policy: null,
  employments: [],
  requirements: [],
  qualifications: [],
  closures,
  duties,
});

describe('withSupervision', () => {
  it('hands every uppdrag back as it came when the year has no pass', () => {
    expect(withSupervision(DUTIES, [], YEAR)).toEqual([
      { userId: 'anna', minutesPerWeek: 60, countsAsTeaching: false },
      { userId: 'anna', minutesPerWeek: 90, countsAsTeaching: false },
      { userId: 'bo', minutesPerWeek: 40, countsAsTeaching: false },
    ]);
  });

  it('charges each pass as an uppdrag, and drops the RASTVAKT uppdrag of the teacher it covers all year', () => {
    expect(withSupervision(DUTIES, ANNA, YEAR)).toEqual([
      { userId: 'anna', minutesPerWeek: 90, countsAsTeaching: false },
      { userId: 'bo', minutesPerWeek: 40, countsAsTeaching: false },
      { userId: 'anna', minutesPerWeek: 20, countsAsTeaching: false },
      { userId: 'anna', minutesPerWeek: 30, countsAsTeaching: true },
    ]);
  });

  it('keeps the RASTVAKT uppdrag in the weeks no pass of the teacher runs', () => {
    const fromWeek3 = ANNA.map((row) => ({ ...row, validFrom: '2026-09-21' }));
    const until = [shift('anna', '10:00', '10:20', { validTo: '2026-09-13' }), shift('anna', '12:00', '12:30', { validFrom: '2026-09-28' })];
    expect(withSupervision([DUTIES[0]!], fromWeek3, YEAR).slice(0, 1)).toEqual([
      { userId: 'anna', minutesPerWeek: 60, countsAsTeaching: false, validFrom: '2026-09-07', validTo: '2026-09-20' },
    ]);
    // A hole between two passes' dates: the uppdrag runs in it, and only there.
    expect(withSupervision([DUTIES[0]!], until, YEAR).slice(0, 1)).toEqual([
      { userId: 'anna', minutesPerWeek: 60, countsAsTeaching: false, validFrom: '2026-09-14', validTo: '2026-09-27' },
    ]);
    // A dated uppdrag inside the passes' weeks is gone; one reaching past them
    // keeps its tail from the Monday after the last pass's week.
    expect(
      withSupervision(
        [duty('anna', 'RASTVAKT', 60, { validFrom: '2026-09-14', validTo: '2026-10-02' })],
        [shift('anna', '10:00', '10:20', { validTo: '2026-09-25' })],
        YEAR,
      ).slice(0, 1),
    ).toEqual([{ userId: 'anna', minutesPerWeek: 60, countsAsTeaching: false, validFrom: '2026-09-28', validTo: '2026-10-02' }]);
  });

  it('never charges a week both the ram and a pass: a Friday Till or a one-day pass takes its whole week', () => {
    const year = { startDate: '2026-08-17', endDate: '2027-06-11' };
    const ram = [duty('anna', 'RASTVAKT', 60)];
    const charged = (shifts: LoadShift[]) =>
      buildTeacherLoadReport({ ...input(withSupervision(ram, shifts, year)), year }).teachers.find((row) => row.userId === 'anna')!;
    // Autumn passes until the last day before jullov, a Friday: the ram runs from the Monday after.
    const autumn = charged([shift('anna', '10:00', '11:00', { validTo: '2026-12-18' })]);
    expect(autumn.dutyMinutesPerWeek).toBe(60);
    expect(autumn.dutyPeakMinutesPerWeek).toBe(60);
    // One Wednesday: that week is the pass's, every other the ram's.
    const once = charged([shift('anna', '10:00', '10:20', { validFrom: '2026-09-02', validTo: '2026-09-02' })]);
    expect(once.dutyPeakMinutesPerWeek).toBe(60);
    expect(once.dutyMinutesPerWeek).toBeLessThanOrEqual(60);
    const [line] = supervisionOfTeachers(ram, [shift('anna', '10:00', '10:20', { validFrom: '2026-09-02', validTo: '2026-09-02' })], year, []);
    expect(line!.ramCountedMinutesPerWeek).toBeLessThanOrEqual(line!.ramMinutesPerWeek!);
  });

  it('feeds the report: the passes are uppdrag, and only the counted area meets the target', () => {
    const report = buildTeacherLoadReport(input(withSupervision(DUTIES, ANNA, YEAR)));
    const anna = report.teachers.find((row) => row.userId === 'anna')!;
    const bo = report.teachers.find((row) => row.userId === 'bo')!;
    expect(anna.dutyMinutesPerWeek).toBe(90 + 20 + 30);
    expect(anna.countedDutyMinutesPerWeek).toBe(30);
    expect(bo.dutyMinutesPerWeek).toBe(40);
  });
});

describe('supervisionOfTeachers', () => {
  it('states nothing for a year without a pass', () => {
    expect(supervisionOfTeachers(DUTIES, [], YEAR, [])).toEqual([]);
  });

  it('states the passes, the counted part, the toppvecka and the ram', () => {
    expect(supervisionOfTeachers(DUTIES, ANNA, YEAR, [])).toEqual([
      {
        userId: 'anna',
        shiftCount: 2,
        minutesPerWeek: 50,
        countedMinutesPerWeek: 30,
        peakMinutesPerWeek: 50,
        // 50 minutes over four weeks.
        hoursPerYear: 3.3,
        ramMinutesPerWeek: 60,
        ramCountedMinutesPerWeek: 0,
      },
    ]);
  });

  it('weighs dated passes and the ram they leave by the weeks each runs', () => {
    const fromWeek3 = ANNA.map((row) => ({ ...row, validFrom: '2026-09-21' }));
    expect(supervisionOfTeachers(DUTIES, fromWeek3, YEAR, [])).toEqual([
      expect.objectContaining({ minutesPerWeek: 25, countedMinutesPerWeek: 15, peakMinutesPerWeek: 50, hoursPerYear: 1.7, ramMinutesPerWeek: 60, ramCountedMinutesPerWeek: 30 }),
    ]);
  });

  it('takes a school-wide lov out of the weeks, as an uppdrag’s, and no ram without a RASTVAKT uppdrag', () => {
    const lov = [{ startDate: '2026-09-28', endDate: '2026-10-02' }];
    const [row] = supervisionOfTeachers([], [shift('cecilia', '10:00', '10:20', { validFrom: '2026-09-21' })], YEAR, lov);
    // Two weeks of four, one of them a lov: one taught week of the year's three.
    expect(row).toEqual(expect.objectContaining({ minutesPerWeek: 7, peakMinutesPerWeek: 20, hoursPerYear: 0.3, ramMinutesPerWeek: null }));
  });
});
