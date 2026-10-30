import { busyBlocks, clockOf, minutesOf, type LessonElsewhere } from './other-school-busy';

/**
 * A shared teacher's lessons at another school, as the blocks the generator
 * keeps the teacher out of: widened by the walk, rounded outward to the
 * slot grid, merged where they meet, and only for lessons that meet the
 * year planned.
 */

const ANNA = '10000000-0000-4000-8000-000000000001';
const BO = '20000000-0000-4000-8000-000000000002';
const NORRA = '30000000-0000-4000-8000-000000000003';
const SODRA = '40000000-0000-4000-8000-000000000004';

const lesson = (patch: Partial<LessonElsewhere>): LessonElsewhere => ({
  teacherId: ANNA,
  schoolId: NORRA,
  dayOfWeek: 2,
  startTime: '10:00',
  endTime: '11:00',
  recurrence: 'ALL_WEEKS',
  startDate: '2030-08-15',
  endDate: '2031-06-15',
  travelMinutes: 15,
  ...patch,
});

describe('busyBlocks', () => {
  it('widens a lesson by the walk on both sides', () => {
    expect(busyBlocks([lesson({})], 5, '2030-08-01', '2031-07-31')).toEqual([
      { teacherId: ANNA, dayOfWeek: 2, start: minutesOf('09:45'), end: minutesOf('11:15'), schoolIds: [NORRA] },
    ]);
  });

  it('rounds outward to the slot grid, so no lesson starts inside the walk', () => {
    const [block] = busyBlocks([lesson({ startTime: '10:02', endTime: '10:58', travelMinutes: 7 })], 5, '2030-08-01', '2031-07-31');
    expect(clockOf(block!.start)).toBe('09:55:00');
    expect(clockOf(block!.end)).toBe('11:05:00');
    const [coarse] = busyBlocks([lesson({ travelMinutes: 10 })], 15, '2030-08-01', '2031-07-31');
    expect([clockOf(coarse!.start), clockOf(coarse!.end)]).toEqual(['09:45:00', '11:15:00']);
  });

  it('counts no walk when neither school has said one, and never a negative one', () => {
    const [none] = busyBlocks([lesson({ travelMinutes: null })], 5, '2030-08-01', '2031-07-31');
    expect([clockOf(none!.start), clockOf(none!.end)]).toEqual(['10:00:00', '11:00:00']);
    const [negative] = busyBlocks([lesson({ travelMinutes: -30 })], 5, '2030-08-01', '2031-07-31');
    expect([clockOf(negative!.start), clockOf(negative!.end)]).toEqual(['10:00:00', '11:00:00']);
  });

  it('merges blocks that meet or overlap, per teacher and weekday, and names each school once', () => {
    const blocks = busyBlocks(
      [
        lesson({ startTime: '08:00', endTime: '09:00' }),
        lesson({ startTime: '09:30', endTime: '10:00', schoolId: SODRA }),
        lesson({ startTime: '13:00', endTime: '14:00' }),
        lesson({ dayOfWeek: 3, startTime: '08:00', endTime: '09:00' }),
        lesson({ teacherId: BO, startTime: '08:00', endTime: '09:00' }),
      ],
      5,
      '2030-08-01',
      '2031-07-31',
    );
    expect(blocks.map((b) => [b.teacherId === ANNA ? 'Anna' : 'Bo', b.dayOfWeek, clockOf(b.start), clockOf(b.end), b.schoolIds.length])).toEqual([
      ['Anna', 2, '07:45:00', '10:15:00', 2],
      ['Anna', 2, '12:45:00', '14:15:00', 1],
      ['Anna', 3, '07:45:00', '09:15:00', 1],
      ['Bo', 2, '07:45:00', '09:15:00', 1],
    ]);
  });

  it('holds a lesson of odd weeks or one term every week, the engine having no weeks', () => {
    const blocks = busyBlocks(
      [lesson({ recurrence: 'ODD_WEEKS', startDate: '2030-09-02', endDate: '2030-12-20' })],
      5,
      '2030-08-01',
      '2031-07-31',
    );
    expect(blocks).toHaveLength(1);
  });

  it('leaves out the lessons that do not meet the year planned', () => {
    expect(busyBlocks([lesson({ startDate: '2029-08-15', endDate: '2030-06-15' })], 5, '2030-08-01', '2031-07-31')).toEqual([]);
    expect(busyBlocks([lesson({ startDate: '2031-08-01', endDate: '2032-06-15' })], 5, '2030-08-01', '2031-07-31')).toEqual([]);
    expect(busyBlocks([lesson({ startDate: '2031-07-31', endDate: '2032-06-15' })], 5, '2030-08-01', '2031-07-31')).toHaveLength(1);
  });

  it('sends nothing for a weekend, which the engine does not plan and refuses a reservation on', () => {
    expect(busyBlocks([lesson({ dayOfWeek: 6 }), lesson({ dayOfWeek: 7 })], 5, '2030-08-01', '2031-07-31')).toEqual([]);
  });

  it('keeps a block inside the day', () => {
    const [early] = busyBlocks([lesson({ startTime: '00:05', endTime: '01:00', travelMinutes: 30 })], 5, '2030-08-01', '2031-07-31');
    expect(early!.start).toBe(0);
    const [late] = busyBlocks([lesson({ startTime: '23:00', endTime: '23:50', travelMinutes: 30 })], 5, '2030-08-01', '2031-07-31');
    expect(late!.end).toBe(24 * 60);
  });
});
