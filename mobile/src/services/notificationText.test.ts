import { translatorFor } from '../i18n';
import { notificationText } from './notificationText';
import type { NotificationRow, NotificationType } from '../types';

/**
 * Every type the gateway writes, worded in both languages. The app used to
 * know five types and show "Notification" for the rest. Under TZ=UTC, so the
 * instants read as written.
 */

const row = (type: NotificationType, meta: Record<string, unknown> | null): NotificationRow => ({
  id: 'n-1',
  type,
  meta,
  readAt: null,
  createdAt: '2026-10-13T07:00:00.000Z',
});

const at = '2026-10-13T08:00:00.000Z';

const CASES: Array<[string, NotificationRow, string, string]> = [
  [
    'ABSENCE_UNREPORTED',
    row('ABSENCE_UNREPORTED', { studentName: 'Alva Elev', subjectName: 'Matematik', date: '2026-10-13' }),
    'Alva Elev markerades frånvarande från Matematik den 2026-10-13 utan föranmälan.',
    'Alva Elev was marked absent from Matematik on 2026-10-13 without a prior report.',
  ],
  [
    'LEAVE_DECIDED approved',
    row('LEAVE_DECIDED', { studentName: 'Alva Elev', startDate: '2026-11-02', endDate: '2026-11-06', status: 'APPROVED' }),
    'Ledighet för Alva Elev (2026-11-02 – 2026-11-06) beviljades.',
    'Leave for Alva Elev (2026-11-02 – 2026-11-06) was approved.',
  ],
  [
    'LEAVE_DECIDED rejected',
    row('LEAVE_DECIDED', { studentName: 'Alva Elev', startDate: '2026-11-02', endDate: '2026-11-06', status: 'REJECTED' }),
    'Ledighet för Alva Elev (2026-11-02 – 2026-11-06) avslogs.',
    'Leave for Alva Elev (2026-11-02 – 2026-11-06) was rejected.',
  ],
  [
    'LESSON_CANCELLED',
    row('LESSON_CANCELLED', { subjectName: 'Matematik', startsAt: at }),
    'Matematik (tis 13 okt 08:00) ställdes in.',
    'Matematik (Tue 13 Oct 08:00) was cancelled.',
  ],
  [
    'LESSON_SUBSTITUTE for the class',
    row('LESSON_SUBSTITUTE', { subjectName: 'Matematik', startsAt: at, groupName: '7A', roomName: 'B204' }),
    'Matematik (tis 13 okt 08:00) har en vikarie.',
    'Matematik (Tue 13 Oct 08:00) has a substitute teacher.',
  ],
  [
    'LESSON_SUBSTITUTE cover:true',
    row('LESSON_SUBSTITUTE', { subjectName: 'Matematik', startsAt: at, groupName: '7A', roomName: 'B204', cover: true }),
    'Du vikarierar: Matematik (tis 13 okt 08:00), 7A, B204.',
    'You are covering: Matematik (Tue 13 Oct 08:00), 7A, B204.',
  ],
  [
    'LESSON_COVER_WITHDRAWN',
    row('LESSON_COVER_WITHDRAWN', { subjectName: 'Matematik', startsAt: at, groupName: '7A', roomName: 'B204' }),
    'Vikariepasset är avbokat: Matematik (tis 13 okt 08:00), 7A, B204. Du behöver inte komma.',
    'The cover lesson is withdrawn: Matematik (Tue 13 Oct 08:00), 7A, B204. You do not need to come.',
  ],
  [
    'LESSON_ROOM_CHANGED',
    row('LESSON_ROOM_CHANGED', { subjectName: 'Matematik', startsAt: at }),
    'Matematik (tis 13 okt 08:00) har flyttat till en annan sal.',
    'Matematik (Tue 13 Oct 08:00) has moved to another room.',
  ],
  [
    'SCHEDULE_CHANGED',
    row('SCHEDULE_CHANGED', { subjectName: 'Matematik' }),
    'Veckoschemat för Matematik har ändrats.',
    'The weekly schedule for Matematik was changed.',
  ],
  [
    'ROOM_BOOKING_DECIDED approved',
    row('ROOM_BOOKING_DECIDED', { roomName: 'Aulan', startsAt: at, status: 'APPROVED' }),
    'Din bokning av Aulan (tis 13 okt 08:00) godkändes.',
    'Your booking of Aulan (Tue 13 Oct 08:00) was approved.',
  ],
  [
    'ROOM_BOOKING_DECIDED rejected',
    row('ROOM_BOOKING_DECIDED', { roomName: 'Aulan', startsAt: at, status: 'REJECTED' }),
    'Din bokning av Aulan (tis 13 okt 08:00) avslogs.',
    'Your booking of Aulan (Tue 13 Oct 08:00) was rejected.',
  ],
  [
    'TEACHER_ABSENCE_REPORTED whole days',
    row('TEACHER_ABSENCE_REPORTED', {
      teacherName: 'Anna Lind',
      startsAt: '2026-10-13T00:00:00.000Z',
      endsAt: '2026-10-15T00:00:00.000Z',
      wholeDays: true,
    }),
    'Anna Lind har anmält frånvaro tis 13 okt – ons 14 okt. Se Lärarfrånvaro på webben.',
    'Anna Lind has reported absence Tue 13 Oct – Wed 14 Oct. See Teacher absence on the web.',
  ],
  [
    'TEACHER_ABSENCE_REPORTED one day',
    row('TEACHER_ABSENCE_REPORTED', {
      teacherName: 'Anna Lind',
      startsAt: '2026-10-13T00:00:00.000Z',
      endsAt: '2026-10-14T00:00:00.000Z',
      wholeDays: true,
    }),
    'Anna Lind har anmält frånvaro tis 13 okt. Se Lärarfrånvaro på webben.',
    'Anna Lind has reported absence Tue 13 Oct. See Teacher absence on the web.',
  ],
];

describe('notificationText', () => {
  it.each(CASES)('%s', (_name, entry, svText, enText) => {
    expect(notificationText(entry, translatorFor('sv'), 'sv')).toBe(svText);
    expect(notificationText(entry, translatorFor('en'), 'en')).toBe(enText);
  });

  it('covers all nine types the gateway writes', () => {
    const types = new Set(CASES.map(([, entry]) => entry.type));
    expect(types.size).toBe(9);
  });

  it('never names whom a substitute replaces, nor a reason, whatever the meta carries', () => {
    const text = notificationText(
      row('LESSON_SUBSTITUTE', { subjectName: 'Matematik', startsAt: at, absentTeacherName: 'Anna Lind', reason: 'Sjuk' }),
      translatorFor('sv'),
      'sv',
    );
    expect(text).not.toContain('Anna');
    expect(text).not.toContain('Sjuk');
  });

  it('survives a null meta and an unknown type', () => {
    expect(notificationText(row('SCHEDULE_CHANGED', null), translatorFor('sv'), 'sv')).toBe('Veckoschemat för  har ändrats.');
    expect(notificationText(row('UNKNOWN' as NotificationType, {}), translatorFor('en'), 'en')).toBe('Notification');
    expect(notificationText(row('TEACHER_ABSENCE_REPORTED', {}), translatorFor('sv'), 'sv')).toBe(
      '— har anmält frånvaro . Se Lärarfrånvaro på webben.',
    );
  });
});
