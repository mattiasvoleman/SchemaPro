import { apiRequest } from './api';
import {
  canStep,
  familyDays,
  fetchFamilySchedule,
  lessonState,
  weekNumber,
  type FamilyLesson,
  type FamilySchedule,
} from './familySchedule';

jest.mock('./api', () => ({ apiRequest: jest.fn(), ApiError: class extends Error {} }));

const lesson = (id: string, date: string, start: string, over: Partial<FamilyLesson> = {}): FamilyLesson => ({
  id,
  date,
  start,
  end: '23:59',
  subject: 'Matematik',
  subjectColor: null,
  room: 'B204',
  teachers: [],
  status: 'SCHEDULED',
  substitute: false,
  ...over,
});

const schedule = (over: Partial<FamilySchedule> = {}): FamilySchedule => ({
  student: { id: 'c-1', firstName: 'Alva' },
  week: { from: '2026-10-19', to: '2026-10-25', isoWeek: '2026-W43' },
  today: '2026-10-21',
  bounds: { earliest: '2026-10-12', latest: '2027-06-07' },
  timezone: 'Europe/Stockholm',
  lessons: [],
  lunches: [],
  rasts: [],
  ...over,
});

describe('fetchFamilySchedule', () => {
  it('asks the gateway for one child, at the school’s week unless a day is named', async () => {
    (apiRequest as jest.Mock).mockResolvedValue(schedule());
    await fetchFamilySchedule('00000000-0000-4000-8000-0000000000a1', null);
    await fetchFamilySchedule('00000000-0000-4000-8000-0000000000a1', '2026-10-12');
    expect((apiRequest as jest.Mock).mock.calls.map((call) => call[0])).toEqual([
      '/api/v1/family/schedule?studentId=00000000-0000-4000-8000-0000000000a1',
      '/api/v1/family/schedule?studentId=00000000-0000-4000-8000-0000000000a1&week=2026-10-12',
    ]);
  });
});

describe('familyDays', () => {
  it('has Monday to Friday always, and the weekend only when something is on it', () => {
    expect(familyDays(schedule()).map((day) => day.date)).toEqual([
      '2026-10-19',
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
    ]);
    expect(familyDays(schedule({ lessons: [lesson('l', '2026-10-24', '09:00')] })).map((day) => day.date)).toContain('2026-10-24');
  });

  it('crosses the October clock change by date, not by hours', () => {
    const days = familyDays(schedule({ lessons: [lesson('sun', '2026-10-25', '10:00')] }));
    expect(days.at(-1)).toMatchObject({ date: '2026-10-25' });
  });

  it('orders a day by the school’s HH:MM, lesson before rast before lunch', () => {
    const [monday] = familyDays(
      schedule({
        lessons: [lesson('b', '2026-10-19', '11:20'), lesson('a', '2026-10-19', '08:05')],
        rasts: [{ id: 'r', date: '2026-10-19', start: '11:20', end: '11:40', name: 'Lunchrast' }],
        lunches: [{ id: 'm', date: '2026-10-19', start: '11:20', end: '11:50' }],
      }),
    );
    expect(monday!.entries.map((entry) => entry.key)).toEqual(['L:a', 'L:b', 'R:r', 'M:m']);
    expect(monday!.entries[0]).toMatchObject({ start: '08:05' });
  });
});

describe('lessonState, canStep, weekNumber', () => {
  it('says cancelled before substitute', () => {
    expect(lessonState(lesson('x', '2026-10-19', '08:00', { status: 'CANCELLED', substitute: true }))).toBe('cancelled');
    expect(lessonState(lesson('x', '2026-10-19', '08:00', { substitute: true }))).toBe('substitute');
    expect(lessonState(lesson('x', '2026-10-19', '08:00'))).toBe('scheduled');
  });

  it('stops at the gateway’s first and last week', () => {
    expect(canStep(schedule(), -1)).toBe(true);
    expect(canStep(schedule({ week: { from: '2026-10-12', to: '2026-10-18', isoWeek: '2026-W42' } }), -1)).toBe(false);
    expect(canStep(schedule({ week: { from: '2027-06-07', to: '2027-06-13', isoWeek: '2027-W23' } }), 1)).toBe(false);
    expect(canStep(schedule({ bounds: { earliest: '2026-10-12', latest: null } }), 1)).toBe(true);
  });

  it('reads the week number', () => {
    expect(weekNumber('2026-W43')).toBe(43);
  });
});
