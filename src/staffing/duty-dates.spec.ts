import { createTxMock } from '../../test/utils/prisma-mock';
import { dayOf, dutiesRunningDuring, dutyRunsDuring, dutyRunsOn, mentorsOf } from './duty-dates';
import { slotsOfLinks, slotsOverlap, sortSlots } from './duty-slot';

const day = (value: string) => new Date(`${value}T00:00:00.000Z`);

describe('when an uppdrag runs (Från and Till, 20261017090000)', () => {
  const undated = { validFrom: null, validTo: null };
  const untilJul = { validFrom: null, validTo: '2026-12-18' };
  const fromJanuary = { validFrom: '2027-01-07', validTo: null };
  const march = { validFrom: '2027-03-01', validTo: '2027-03-31' };

  it('an undated uppdrag runs every day: null is the year’s own bound', () => {
    expect(['2026-08-17', '2026-12-24', '2027-06-11'].every((value) => dutyRunsOn(undated, value))).toBe(true);
  });

  it('both bounds are inclusive', () => {
    expect(dutyRunsOn(untilJul, '2026-12-18')).toBe(true);
    expect(dutyRunsOn(untilJul, '2026-12-19')).toBe(false);
    expect(dutyRunsOn(fromJanuary, '2027-01-06')).toBe(false);
    expect(dutyRunsOn(fromJanuary, '2027-01-07')).toBe(true);
    expect(dutyRunsOn(march, '2027-03-01')).toBe(true);
    expect(dutyRunsOn(march, '2027-03-31')).toBe(true);
    expect(dutyRunsOn(march, '2027-04-01')).toBe(false);
  });

  it('runs during a period when the two share a day, edges included', () => {
    expect(dutyRunsDuring(untilJul, '2026-12-18', '2027-01-10')).toBe(true);
    expect(dutyRunsDuring(untilJul, '2026-12-19', '2027-01-10')).toBe(false);
    expect(dutyRunsDuring(fromJanuary, '2026-12-20', '2027-01-07')).toBe(true);
    expect(dutyRunsDuring(fromJanuary, '2026-12-20', '2027-01-06')).toBe(false);
    expect(dutyRunsDuring(march, '2027-02-01', '2027-04-30')).toBe(true);
    expect(dutyRunsDuring(undated, '2027-02-01', '2027-02-01')).toBe(true);
  });

  it('reads a @db.Date back as its day, and null as null', () => {
    expect(dayOf(day('2027-01-07'))).toBe('2027-01-07');
    expect(dayOf(null)).toBeNull();
  });

  it('asks Prisma the same overlap, and the läsår’s, so an undated uppdrag of another year does not answer', () => {
    expect(dutiesRunningDuring(day('2027-02-01'), day('2027-02-05'))).toEqual({
      AND: [
        { OR: [{ validFrom: null }, { validFrom: { lte: day('2027-02-05') } }] },
        { OR: [{ validTo: null }, { validTo: { gte: day('2027-02-01') } }] },
        { academicYear: { is: { startDate: { lte: day('2027-02-05') }, endDate: { gte: day('2027-02-01') } } } },
      ],
    });
  });
});

describe('mentorsOf: who holds MENTORSKAP for a class on these dates', () => {
  const GROUP = '7b7b7b7b-7b7b-47b7-87b7-7b7b7b7b7b7b';
  const ANNA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const BERTIL = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('asks for the class’s mentorships running in the period, and answers them undated first, then by Från, then by teacher', async () => {
    const tx = createTxMock();
    tx.teacherDuty.findMany.mockResolvedValue([
      { id: 'd-bertil', userId: BERTIL, validFrom: day('2027-01-07'), validTo: null },
      { id: 'd-co', userId: BERTIL, validFrom: null, validTo: null },
      { id: 'd-anna', userId: ANNA, validFrom: null, validTo: day('2026-12-18') },
    ]);

    const mentors = await mentorsOf(tx as never, GROUP, day('2026-12-14'), day('2027-01-15'));

    expect(tx.teacherDuty.findMany).toHaveBeenCalledWith({
      where: { studentGroupId: GROUP, kind: 'MENTORSKAP', ...dutiesRunningDuring(day('2026-12-14'), day('2027-01-15')) },
      select: { id: true, userId: true, validFrom: true, validTo: true },
    });
    // A leave request across the jullov: both mentors, Anna's ending, Bertil's starting.
    expect(mentors).toEqual([
      { dutyId: 'd-anna', userId: ANNA, validFrom: null, validTo: '2026-12-18' },
      { dutyId: 'd-co', userId: BERTIL, validFrom: null, validTo: null },
      { dutyId: 'd-bertil', userId: BERTIL, validFrom: '2027-01-07', validTo: null },
    ]);
  });

  it('answers nobody for a class without a mentor', async () => {
    const tx = createTxMock();
    tx.teacherDuty.findMany.mockResolvedValue([]);
    expect(await mentorsOf(tx as never, GROUP, day('2027-03-01'), day('2027-03-01'))).toEqual([]);
  });
});

describe('an uppdrag’s several times', () => {
  const time = (dayOfWeek: number, startTime: string, endTime: string) => ({ dayOfWeek, startTime, endTime });

  it('overlap only when they share a minute on the same weekday', () => {
    expect(slotsOverlap(time(1, '10:00', '10:30'), time(1, '10:29', '11:00'))).toBe(true);
    expect(slotsOverlap(time(1, '10:00', '10:30'), time(1, '10:30', '11:00'))).toBe(false);
    expect(slotsOverlap(time(1, '10:00', '10:30'), time(2, '10:00', '10:30'))).toBe(false);
    expect(slotsOverlap(time(3, '08:00', '12:00'), time(3, '09:00', '09:10'))).toBe(true);
  });

  it('are listed Monday first, then by start and end', () => {
    expect(sortSlots([time(5, '10:00', '10:20'), time(1, '12:00', '12:20'), time(1, '10:00', '10:30'), time(1, '10:00', '10:20')])).toEqual([
      time(1, '10:00', '10:20'),
      time(1, '10:00', '10:30'),
      time(1, '12:00', '12:20'),
      time(5, '10:00', '10:20'),
    ]);
  });

  it('are read back from their links as clocks, a weekday-less constraint as no time', () => {
    const clock = (value: string) => new Date(`1970-01-01T${value}:00.000Z`);
    expect(
      slotsOfLinks([
        { availabilityConstraint: { dayOfWeek: 3, startTime: clock('10:00'), endTime: clock('10:20') } },
        { availabilityConstraint: { dayOfWeek: null, startTime: clock('08:00'), endTime: clock('09:00') } },
        { availabilityConstraint: null },
        { availabilityConstraint: { dayOfWeek: 1, startTime: clock('10:00'), endTime: clock('10:20') } },
      ]),
    ).toEqual([time(1, '10:00', '10:20'), time(3, '10:00', '10:20')]);
  });
});
