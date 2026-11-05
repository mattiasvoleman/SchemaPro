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
    'LEAVE_DECIDED by the mentor',
    row('LEAVE_DECIDED', { studentName: 'Alva Elev', startDate: '2026-11-02', endDate: '2026-11-03', status: 'APPROVED', decidedAs: 'MENTOR' }),
    'Ledighet för Alva Elev (2026-11-02 – 2026-11-03) beviljades av mentorn.',
    'Leave for Alva Elev (2026-11-02 – 2026-11-03) was approved by the mentor.',
  ],
  [
    'LEAVE_DECIDED rejected by the mentor',
    row('LEAVE_DECIDED', { studentName: 'Alva Elev', startDate: '2026-11-02', endDate: '2026-11-03', status: 'REJECTED', decidedAs: 'MENTOR' }),
    'Ledighet för Alva Elev (2026-11-02 – 2026-11-03) avslogs av mentorn.',
    'Leave for Alva Elev (2026-11-02 – 2026-11-03) was rejected by the mentor.',
  ],
  [
    'LEAVE_REQUESTED, to the mentor, never the reason',
    row('LEAVE_REQUESTED', { leaveRequestId: 'l-1', studentName: 'Alva Elev', startDate: '2026-11-02', endDate: '2026-11-04', schoolDays: 3 }),
    'Ny ledighetsansökan för Alva Elev (2026-11-02 – 2026-11-04, 3 skoldagar) väntar på ditt beslut.',
    'A new leave request for Alva Elev (2026-11-02 – 2026-11-04, 3 school days) is waiting for your decision.',
  ],
  [
    'LEAVE_REQUESTED of one skoldag',
    row('LEAVE_REQUESTED', { leaveRequestId: 'l-1', studentName: 'Alva Elev', startDate: '2026-11-02', endDate: '2026-11-02', schoolDays: 1 }),
    'Ny ledighetsansökan för Alva Elev (2026-11-02 – 2026-11-02, en skoldag) väntar på ditt beslut.',
    'A new leave request for Alva Elev (2026-11-02 – 2026-11-02, one school day) is waiting for your decision.',
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
    'SUPERVISION_COVER',
    row('SUPERVISION_COVER', { areaName: 'Skolgården', startsAt: at, endsAt: '2026-10-13T08:20:00.000Z' }),
    'Du är inbokad som rastvakt: Skolgården (tis 13 okt 08:00–08:20).',
    'You have break duty: Skolgården (Tue 13 Oct 08:00–08:20).',
  ],
  [
    'SUPERVISION_COVER_WITHDRAWN',
    row('SUPERVISION_COVER_WITHDRAWN', { areaName: 'Matsalen', startsAt: at, endsAt: '2026-10-13T08:20:00.000Z' }),
    'Rastvaktspasset är avbokat: Matsalen (tis 13 okt 08:00–08:20). Du behöver inte ta det.',
    'The break duty is withdrawn: Matsalen (Tue 13 Oct 08:00–08:20). You do not need to take it.',
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
  [
    'LESSON_REINSTATED',
    row('LESSON_REINSTATED', { subjectName: 'Matematik', startsAt: at }),
    'Matematik (tis 13 okt 08:00) blir av som planerat.',
    'Matematik (Tue 13 Oct 08:00) goes ahead as planned.',
  ],
  [
    'LESSON_SUPERVISED_STUDY',
    row('LESSON_SUPERVISED_STUDY', { subjectName: 'Matematik', startsAt: at }),
    'Matematik (tis 13 okt 08:00) blir självstudier under tillsyn.',
    'Matematik (Tue 13 Oct 08:00) becomes supervised self-study.',
  ],
  [
    'CANCELLATION_DIGEST',
    row('CANCELLATION_DIGEST', { name: 'Prao åk 9', lessonCount: 12, startDate: '2026-10-19', endDate: '2026-10-23', reversed: false }),
    'Prao åk 9: 12 lektioner är inställda (19 okt – 23 okt).',
    'Prao åk 9: 12 lessons are cancelled (19 Oct – 23 Oct).',
  ],
  [
    'CANCELLATION_DIGEST one lesson, one day',
    row('CANCELLATION_DIGEST', { name: 'Friluftsdag', lessonCount: 1, startDate: '2026-10-20', endDate: '2026-10-20', reversed: false }),
    'Friluftsdag: en lektion är inställd (20 okt).',
    'Friluftsdag: one lesson is cancelled (20 Oct).',
  ],
  [
    'CANCELLATION_DIGEST reversed',
    row('CANCELLATION_DIGEST', { name: 'Prao åk 9', lessonCount: 12, startDate: '2026-10-19', endDate: '2026-10-23', reversed: true }),
    'Prao åk 9 är ångrad: 12 lektioner blir av som planerat (19 okt – 23 okt).',
    'Prao åk 9 is undone: 12 lessons go ahead as planned (19 Oct – 23 Oct).',
  ],
  [
    'ABSENCE_WATCH_DIGEST for staff with pupils over a limit, counts only',
    row('ABSENCE_WATCH_DIGEST', { group: 'MENTOR', periodStart: '2026-11-02', periodEnd: '2026-11-08', open: 3, crossed: 1 }),
    'Frånvarosammanställning 2 nov – 8 nov: 3 elever är över en av skolans gränser. Passerade en gräns under perioden: 1. Se vilka i Rastra Schema på webben.',
    'Absence summary 2 Nov – 8 Nov: 3 pupils are over a limit the school has set. Passed a limit in the period: 1. See who in Rastra timetable on the web.',
  ],
  [
    'ABSENCE_WATCH_DIGEST for staff, one pupil',
    row('ABSENCE_WATCH_DIGEST', { group: 'REKTOR', periodStart: '2026-11-02', periodEnd: '2026-11-08', open: 1, crossed: 0 }),
    'Frånvarosammanställning 2 nov – 8 nov: 1 elev är över en av skolans gränser. Passerade en gräns under perioden: 0. Se vilka i Rastra Schema på webben.',
    'Absence summary 2 Nov – 8 Nov: 1 pupil is over a limit the school has set. Passed a limit in the period: 0. See who in Rastra timetable on the web.',
  ],
  [
    'ABSENCE_WATCH_DIGEST for staff when everyone is back under',
    row('ABSENCE_WATCH_DIGEST', { group: 'KANSLI', periodStart: '2026-11-02', periodEnd: '2026-11-08', open: 0, crossed: 2 }),
    'Frånvarosammanställning 2 nov – 8 nov: 2 elever passerade en gräns och är under den igen. Se mer i Rastra Schema på webben.',
    'Absence summary 2 Nov – 8 Nov: 2 pupils passed a limit and are under it again. See more in Rastra timetable on the web.',
  ],
  [
    'ABSENCE_WATCH_DIGEST for a guardian, one child',
    row('ABSENCE_WATCH_DIGEST', { group: 'GUARDIAN', periodStart: '2026-10-05', periodEnd: '2026-11-01', open: 1, crossed: 1 }),
    'Frånvarosammanställning 5 okt – 1 nov: ett av dina barn har frånvaro över en gräns som skolan har satt. Se mer i Rastra Schema på webben.',
    'Absence summary 5 Oct – 1 Nov: one of your children has absence over a limit the school has set. See more in Rastra timetable on the web.',
  ],
  [
    'ABSENCE_WATCH_DIGEST for a guardian, several children',
    row('ABSENCE_WATCH_DIGEST', { group: 'GUARDIAN', periodStart: '2026-10-05', periodEnd: '2026-11-01', open: 2, crossed: 2 }),
    'Frånvarosammanställning 5 okt – 1 nov: 2 av dina barn har frånvaro över en gräns som skolan har satt. Se mer i Rastra Schema på webben.',
    'Absence summary 5 Oct – 1 Nov: 2 of your children have absence over a limit the school has set. See more in Rastra timetable on the web.',
  ],
  [
    'ABSENCE_WATCH_DIGEST for a guardian whose child is back under',
    row('ABSENCE_WATCH_DIGEST', { group: 'GUARDIAN', periodStart: '2026-10-05', periodEnd: '2026-11-01', open: 0, crossed: 1 }),
    'Frånvarosammanställning 5 okt – 1 nov: ett av dina barn har kommit under en gräns för frånvaro igen. Se mer i Rastra Schema på webben.',
    'Absence summary 5 Oct – 1 Nov: one of your children is under an absence limit again. See more in Rastra timetable on the web.',
  ],
  [
    'ABSENCE_WATCH_DIGEST for a guardian whose children are back under',
    row('ABSENCE_WATCH_DIGEST', { group: 'GUARDIAN', periodStart: '2026-10-05', periodEnd: '2026-11-01', open: 0, crossed: 2 }),
    'Frånvarosammanställning 5 okt – 1 nov: 2 av dina barn har kommit under en gräns för frånvaro igen. Se mer i Rastra Schema på webben.',
    'Absence summary 5 Oct – 1 Nov: 2 of your children are under an absence limit again. See more in Rastra timetable on the web.',
  ],
];

describe('notificationText', () => {
  it.each(CASES)('%s', (_name, entry, svText, enText) => {
    expect(notificationText(entry, translatorFor('sv'), 'sv')).toBe(svText);
    expect(notificationText(entry, translatorFor('en'), 'en')).toBe(enText);
  });

  it('covers all sixteen types the gateway writes', () => {
    const types = new Set(CASES.map(([, entry]) => entry.type));
    expect(types.size).toBe(16);
  });

  it('says a summary of absence in counts and dates only, whatever else the meta holds', () => {
    const text = notificationText(
      row('ABSENCE_WATCH_DIGEST', {
        group: 'MENTOR',
        periodStart: '2026-11-02',
        periodEnd: '2026-11-08',
        open: 2,
        crossed: 1,
        studentName: 'Alva Elev',
        reason: 'Sjuk',
      }),
      translatorFor('sv'),
      'sv',
    );
    expect(text).not.toContain('Alva');
    expect(text).not.toContain('Sjuk');
  });

  it('survives a summary with no meta', () => {
    const text = notificationText(row('ABSENCE_WATCH_DIGEST', null), translatorFor('en'), 'en');
    expect(text).toContain('0 pupils');
    expect(text).not.toMatch(/undefined|NaN|\{/);
  });

  it('never carries a leave request’s reason to the mentor, whatever the meta holds', () => {
    const text = notificationText(
      row('LEAVE_REQUESTED', { studentName: 'Alva Elev', startDate: '2026-11-02', endDate: '2026-11-03', schoolDays: 2, reason: 'Begravning' }),
      translatorFor('sv'),
      'sv',
    );
    expect(text).not.toContain('Begravning');
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
