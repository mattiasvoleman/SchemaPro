import { isBlocked, mostHeld, resourceDayConflicts, roomDayConflicts, type DayToCheck, type RoomFacts, type SchoolFacts } from './external-conflicts';
import { minutesOfClock } from './school-time';

const at = (clock: string, date = '2027-02-02') => new Date(`${date}T${clock}:00.000Z`);
const day = (from: string, to: string, date = '2027-02-02', weekday = 2): DayToCheck => ({
  date,
  weekday,
  startsAt: at(from, date),
  endsAt: at(to, date),
  startMinute: minutesOfClock(from),
  endMinute: minutesOfClock(to),
});
const span = (from: string, to: string, label: string, date = '2027-02-02') => ({ start: at(from, date).getTime(), end: at(to, date).getTime(), label });
const nothing: RoomFacts = { lessons: [], bookings: [], closures: [], activities: [] };
const school = (over: Partial<SchoolFacts> = {}): SchoolFacts => ({ frames: [], holidays: new Set(), years: { min: null, max: null }, ...over });
const frames = [{ minGradeLevel: 0, maxGradeLevel: 12, dayOfWeek: null, start: minutesOfClock('08:00'), end: minutesOfClock('16:00') }];

describe('the conflicts of a day of a room', () => {
  it('has none for a free evening in a school with frames', () => {
    expect(roomDayConflicts(day('18:00', '20:00'), nothing, school({ frames }))).toEqual([]);
  });

  it('names the lesson that holds the room and lets one that ends as the booking starts pass', () => {
    const facts = { ...nothing, lessons: [span('17:00', '18:30', 'Idrott 8A'), span('16:00', '18:00', 'Slöjd 9B')] };
    expect(roomDayConflicts(day('18:00', '20:00'), facts, school())).toEqual([{ kind: 'LESSON', severity: 'BLOCK', label: 'Idrott 8A' }]);
  });

  it('names another booking', () => {
    const facts = { ...nothing, bookings: [span('19:00', '21:00', 'Föräldramöte')] };
    expect(roomDayConflicts(day('18:00', '20:00'), facts, school())).toEqual([{ kind: 'BOOKING', severity: 'BLOCK', label: 'Föräldramöte' }]);
  });

  it('refuses a day inside the ramtid and says the window', () => {
    expect(roomDayConflicts(day('15:00', '17:00'), nothing, school({ frames }))).toEqual([{ kind: 'FRAME', severity: 'BLOCK', label: '08:00-16:00' }]);
  });

  it('asks the ramtid only for the years of the room, and not at all of a school with none', () => {
    const lower = [{ minGradeLevel: 0, maxGradeLevel: 3, dayOfWeek: null, start: minutesOfClock('08:00'), end: minutesOfClock('14:00') }];
    expect(roomDayConflicts(day('15:00', '17:00'), nothing, school({ frames: lower, years: { min: 0, max: 3 } }))).toEqual([]);
    expect(roomDayConflicts(day('13:00', '17:00'), nothing, school({ frames: lower, years: { min: 0, max: 3 } }))).toHaveLength(1);
    expect(roomDayConflicts(day('13:00', '17:00'), nothing, school({ frames: lower, years: { min: 7, max: 9 } }))).toEqual([]);
    expect(roomDayConflicts(day('10:00', '12:00'), nothing, school())).toEqual([]);
  });

  it('lets a lov for the whole school take the frame off its date, and a weekend have none', () => {
    expect(roomDayConflicts(day('10:00', '12:00'), nothing, school({ frames, holidays: new Set(['2027-02-02']) }))).toEqual([]);
    expect(roomDayConflicts(day('10:00', '12:00', '2027-02-06', 6), nothing, school({ frames }))).toEqual([]);
  });

  it('reads a closure on the date and one that is weekly, and not on another day', () => {
    const closed = (over: object) => ({ ...nothing, closures: [{ date: null, dayOfWeek: null, start: minutesOfClock('17:00'), end: minutesOfClock('19:00'), reason: 'Golvet slipas', ...over }] });
    expect(roomDayConflicts(day('18:00', '20:00'), closed({ date: '2027-02-02' }), school())).toEqual([{ kind: 'CLOSED', severity: 'BLOCK', label: 'Golvet slipas' }]);
    expect(roomDayConflicts(day('18:00', '20:00'), closed({ dayOfWeek: 2 }), school())).toHaveLength(1);
    expect(roomDayConflicts(day('18:00', '20:00'), closed({ date: '2027-02-09' }), school())).toEqual([]);
    expect(roomDayConflicts(day('18:00', '20:00'), closed({ dayOfWeek: 3 }), school())).toEqual([]);
    expect(roomDayConflicts(day('19:00', '20:00'), closed({ date: '2027-02-02' }), school())).toEqual([]);
  });

  it('carries a loan and only warns about an activity', () => {
    const facts: RoomFacts = { ...nothing, loan: () => 'ROOM_LENT', activities: [span('17:00', '19:00', 'Temadag')] };
    const conflicts = roomDayConflicts(day('18:00', '20:00'), facts, school());
    expect(conflicts).toEqual([
      { kind: 'LOAN', severity: 'BLOCK', label: 'ROOM_LENT' },
      { kind: 'ACTIVITY', severity: 'WARN', label: 'Temadag' },
    ]);
    expect(isBlocked(conflicts)).toBe(true);
    expect(isBlocked([conflicts[1]])).toBe(false);
    expect(roomDayConflicts(day('18:00', '20:00'), { ...nothing, loan: () => null }, school())).toEqual([]);
  });

  it('says a thing once however many rows hold it', () => {
    const facts = { ...nothing, lessons: [span('17:00', '19:00', 'Idrott 8A'), span('18:30', '19:30', 'Idrott 8A')] };
    expect(roomDayConflicts(day('18:00', '20:00'), facts, school())).toHaveLength(1);
  });
});

describe('the conflicts of a day of a resource', () => {
  const book = (from: string, to: string, quantity: number) => ({ start: at(from).getTime(), end: at(to).getTime(), quantity });

  it('finds the most held at one moment, not the sum of the overlapping', () => {
    const list = [book('08:00', '12:00', 10), book('12:00', '16:00', 25), book('10:00', '14:00', 5)];
    expect(mostHeld(list, at('08:00').getTime(), at('16:00').getTime())).toBe(30);
    expect(mostHeld(list, at('08:00').getTime(), at('09:00').getTime())).toBe(10);
    expect(mostHeld([], at('08:00').getTime(), at('09:00').getTime())).toBe(0);
    // Bookings that end as the span starts hold nothing in it.
    expect(mostHeld([book('06:00', '08:00', 40)], at('08:00').getTime(), at('09:00').getTime())).toBe(0);
  });

  it('refuses a day that wants more than is left and names how many are held', () => {
    const facts = { quantity: 30, wanted: 10, bookings: [book('17:00', '19:00', 25)] };
    expect(resourceDayConflicts(day('18:00', '20:00'), facts, school())).toEqual([{ kind: 'BOOKING', severity: 'BLOCK', label: '25 av 30' }]);
    expect(resourceDayConflicts(day('18:00', '20:00'), { ...facts, wanted: 5 }, school())).toEqual([]);
  });

  it('refuses a day in school time, as a room', () => {
    expect(resourceDayConflicts(day('10:00', '12:00'), { quantity: 1, wanted: 1, bookings: [] }, school({ frames }))).toEqual([
      { kind: 'FRAME', severity: 'BLOCK', label: '08:00-16:00' },
    ]);
  });
});
