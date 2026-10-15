import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { absenceSpan, LATE_MINUTES, lessonMinutes, minutesOf } from './attendance';

const at = (instant: string) => new Date(instant);

describe('the minutes of an Attendance', () => {
  it('are the lesson\'s length, rounded, and none for a lesson that does not end after it starts', () => {
    expect(lessonMinutes(at('2026-10-12T06:00:00Z'), at('2026-10-12T07:00:00Z'))).toBe(60);
    expect(lessonMinutes(at('2026-10-12T06:00:00Z'), at('2026-10-12T06:40:29Z'))).toBe(40);
    expect(lessonMinutes(at('2026-10-12T06:00:00Z'), at('2026-10-12T06:40:30Z'))).toBe(41);
    expect(lessonMinutes(at('2026-10-12T06:00:00Z'), at('2026-10-12T06:00:00Z'))).toBe(0);
    expect(lessonMinutes(at('2026-10-12T07:00:00Z'), at('2026-10-12T06:00:00Z'))).toBe(0);
  });

  it('follow the närvarorapport: present, giltig, ogiltig, and LATE as fifteen ogiltig minutes', () => {
    expect(minutesOf('PRESENT', 60)).toEqual({ attendanceMinutes: 60, validAbsenceMinutes: 0, invalidAbsenceMinutes: 0 });
    expect(minutesOf('EXCUSED', 60)).toEqual({ attendanceMinutes: 0, validAbsenceMinutes: 60, invalidAbsenceMinutes: 0 });
    expect(minutesOf('ABSENT', 60)).toEqual({ attendanceMinutes: 0, validAbsenceMinutes: 0, invalidAbsenceMinutes: 60 });
    expect(minutesOf('LATE', 60)).toEqual({ attendanceMinutes: 45, validAbsenceMinutes: 0, invalidAbsenceMinutes: 15 });
    // A lesson shorter than the convention is late all of it, never negative.
    expect(minutesOf('LATE', 10)).toEqual({ attendanceMinutes: 0, validAbsenceMinutes: 0, invalidAbsenceMinutes: 10 });
    // Not reported: no minutes at all.
    expect(minutesOf('UNKNOWN', 60)).toBeNull();
    // Each reported status adds up to the lesson.
    for (const status of ['PRESENT', 'EXCUSED', 'ABSENT', 'LATE'] as const) {
      const minutes = minutesOf(status, 55)!;
      expect(minutes.attendanceMinutes + minutes.validAbsenceMinutes + minutes.invalidAbsenceMinutes).toBe(55);
    }
  });

  it('count LATE as the närvarorapport does, so the two never disagree about a pupil', () => {
    const report = readFileSync(
      join(__dirname, '..', '..', '..', 'web', 'app', '[locale]', '(app)', 'admin', 'reports', 'attendance-report.tsx'),
      'utf8',
    );
    expect(report).toContain(`const LATE_PENALTY_MINUTES = ${LATE_MINUTES};`);
  });
});

describe('the span of an Absence', () => {
  it('is the school\'s local day for a report without both times, midnight to midnight', () => {
    // Summer time in Stockholm: UTC+2.
    expect(absenceSpan({ date: '2026-10-13', startTime: null, endTime: null }, 'Europe/Stockholm')).toEqual({
      startTime: at('2026-10-12T22:00:00Z'),
      endTime: at('2026-10-13T22:00:00Z'),
    });
    // Across the change to winter time the day is 25 hours long.
    expect(absenceSpan({ date: '2026-10-25', startTime: null, endTime: null }, 'Europe/Stockholm')).toEqual({
      startTime: at('2026-10-24T22:00:00Z'),
      endTime: at('2026-10-25T23:00:00Z'),
    });
    // One time without the other is the whole day, as the register reads it.
    expect(absenceSpan({ date: '2026-12-01', startTime: '08:00:00', endTime: null }, 'Europe/Stockholm')).toEqual({
      startTime: at('2026-11-30T23:00:00Z'),
      endTime: at('2026-12-01T23:00:00Z'),
    });
  });

  it('is the whole day for an older report whose span does not end after it starts', () => {
    for (const [start, end] of [['10:00:00', '08:00:00'], ['08:00:00', '08:00:00']] as const) {
      expect(absenceSpan({ date: '2026-12-01', startTime: start, endTime: end }, 'Europe/Stockholm')).toEqual({
        startTime: at('2026-11-30T23:00:00Z'),
        endTime: at('2026-12-01T23:00:00Z'),
      });
    }
  });

  it('is the reported hours on the day, in the school\'s timezone', () => {
    expect(absenceSpan({ date: '2026-12-01', startTime: '08:00:00', endTime: '10:30:00' }, 'Europe/Stockholm')).toEqual({
      startTime: at('2026-12-01T07:00:00Z'),
      endTime: at('2026-12-01T09:30:00Z'),
    });
  });
});
