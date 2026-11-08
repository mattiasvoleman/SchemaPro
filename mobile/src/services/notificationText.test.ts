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
    'LESSON_PUPIL_MOVED, the two subjects and the time, never the pupil or who moved them',
    row('LESSON_PUPIL_MOVED', { fromSubjectName: 'Svenska', toSubjectName: 'Engelska', startsAt: at, studentName: 'Alva Andersson', movedByName: 'Rektor Rask' }),
    'En elev byter lektion (tis 13 okt 08:00): Engelska i stället för Svenska.',
    'A pupil changes lesson (Tue 13 Oct 08:00): Engelska instead of Svenska.',
  ],
  [
    'LESSON_PUPIL_MOVED, undone',
    row('LESSON_PUPIL_MOVED', { fromSubjectName: 'Svenska', toSubjectName: 'Engelska', startsAt: at, undone: true }),
    'Bytet av lektion (tis 13 okt 08:00) är ångrat: det är Svenska som gäller.',
    'The change of lesson (Tue 13 Oct 08:00) is undone: Svenska stands.',
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
    'COVER_REQUESTED, one lesson, with the time to answer by (no subject, group or room)',
    row('COVER_REQUESTED', {
      requestId: 'r-1',
      startsAt: at,
      lessonCount: 1,
      expiresAt: '2026-10-13T07:30:00.000Z',
      lessons: [{ lessonId: 'l-1', startsAt: at }],
    }),
    'Kan du vikariera en lektion från tis 13 okt 08:00? Svara senast tis 13 okt 07:30.',
    'Can you cover a lesson from Tue 13 Oct 08:00? Answer by Tue 13 Oct 07:30.',
  ],
  [
    'COVER_REQUESTED, a notice written before the lessons were left out of it',
    row('COVER_REQUESTED', {
      requestId: 'r-1',
      startsAt: at,
      lessonCount: 1,
      expiresAt: '2026-10-13T07:30:00.000Z',
      lessons: [{ lessonId: 'l-1', startsAt: at, subjectName: 'Matematik', groupName: '7A', roomName: '—' }],
    }),
    'Kan du vikariera en lektion från tis 13 okt 08:00? Svara senast tis 13 okt 07:30.',
    'Can you cover a lesson from Tue 13 Oct 08:00? Answer by Tue 13 Oct 07:30.',
  ],
  [
    'COVER_REQUESTED, several lessons',
    row('COVER_REQUESTED', {
      requestId: 'r-1',
      startsAt: at,
      lessonCount: 3,
      expiresAt: '2026-10-13T07:30:00.000Z',
      lessons: [{ lessonId: 'l-1', startsAt: at }],
    }),
    'Kan du vikariera 3 lektioner från tis 13 okt 08:00? Svara senast tis 13 okt 07:30.',
    'Can you cover 3 lessons from Tue 13 Oct 08:00? Answer by Tue 13 Oct 07:30.',
  ],
  [
    'COVER_REQUEST_CLOSED, taken by a colleague',
    row('COVER_REQUEST_CLOSED', { requestId: 'r-1', startsAt: at, lessonCount: 1, reason: 'TAKEN', lessons: [] }),
    'Vikariepasset tis 13 okt 08:00 är redan tillsatt av en kollega.',
    'The cover lesson Tue 13 Oct 08:00 is already filled by a colleague.',
  ],
  [
    'COVER_REQUEST_CLOSED, taken, several lessons',
    row('COVER_REQUEST_CLOSED', { requestId: 'r-1', startsAt: at, lessonCount: 2, reason: 'TAKEN', lessons: [] }),
    '2 vikariepass från tis 13 okt 08:00 är redan tillsatta av en kollega.',
    '2 cover lessons from Tue 13 Oct 08:00 are already filled by a colleague.',
  ],
  [
    'COVER_REQUEST_CLOSED, withdrawn',
    row('COVER_REQUEST_CLOSED', { requestId: 'r-1', startsAt: at, lessonCount: 1, reason: 'WITHDRAWN', lessons: [] }),
    'Förfrågan om vikariepasset tis 13 okt 08:00 är återkallad.',
    'The request about the cover lesson Tue 13 Oct 08:00 is withdrawn.',
  ],
  [
    'COVER_REQUEST_CLOSED, withdrawn, several lessons',
    row('COVER_REQUEST_CLOSED', { requestId: 'r-1', startsAt: at, lessonCount: 4, reason: 'WITHDRAWN', lessons: [] }),
    'Förfrågan om 4 vikariepass från tis 13 okt 08:00 är återkallad.',
    'The request about 4 cover lessons from Tue 13 Oct 08:00 is withdrawn.',
  ],
  [
    'COVER_REQUEST_CLOSED, no longer needed',
    row('COVER_REQUEST_CLOSED', { requestId: 'r-1', startsAt: at, lessonCount: 1, reason: 'NOT_NEEDED', lessons: [] }),
    'Förfrågan om vikariepasset tis 13 okt 08:00 behövs inte längre.',
    'The request about the cover lesson Tue 13 Oct 08:00 is no longer needed.',
  ],
  [
    'COVER_REQUEST_CLOSED, no longer needed, several lessons',
    row('COVER_REQUEST_CLOSED', { requestId: 'r-1', startsAt: at, lessonCount: 2, reason: 'NOT_NEEDED', lessons: [] }),
    'Förfrågan om 2 vikariepass från tis 13 okt 08:00 behövs inte längre.',
    'The request about 2 cover lessons from Tue 13 Oct 08:00 is no longer needed.',
  ],
  [
    'COVER_REQUEST_CLOSED, nobody said yes (to the administrator who asked)',
    row('COVER_REQUEST_CLOSED', { requestId: 'r-1', startsAt: at, lessonCount: 1, reason: 'UNANSWERED', lessons: [] }),
    'Ingen har tackat ja till vikariepasset tis 13 okt 08:00. Det behöver fortfarande en vikarie.',
    'Nobody said yes to the cover lesson Tue 13 Oct 08:00. It still needs a substitute.',
  ],
  [
    'COVER_REQUEST_CLOSED, nobody said yes, several lessons',
    row('COVER_REQUEST_CLOSED', { requestId: 'r-1', startsAt: at, lessonCount: 3, reason: 'UNANSWERED', lessons: [] }),
    'Ingen har tackat ja till de 3 vikariepassen från tis 13 okt 08:00. De behöver fortfarande en vikarie.',
    'Nobody said yes to the 3 cover lessons from Tue 13 Oct 08:00. They still need a substitute.',
  ],
  [
    'COVER_REQUEST_ACCEPTED, to the administrator who asked',
    row('COVER_REQUEST_ACCEPTED', { requestId: 'r-1', startsAt: at, lessonCount: 1, acceptedByName: 'Anna Lind' }),
    'Anna Lind har tackat ja till vikariepasset tis 13 okt 08:00.',
    'Anna Lind has said yes to the cover lesson Tue 13 Oct 08:00.',
  ],
  [
    'COVER_REQUEST_ACCEPTED, several lessons',
    row('COVER_REQUEST_ACCEPTED', { requestId: 'r-1', startsAt: at, lessonCount: 3, acceptedByName: 'Anna Lind' }),
    'Anna Lind har tackat ja till 3 vikariepass från tis 13 okt 08:00.',
    'Anna Lind has said yes to 3 cover lessons from Tue 13 Oct 08:00.',
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
  [
    'CRISIS_ALARM, a real one: that it began, not what or where',
    row('CRISIS_ALARM', { alarmId: 'a-1', kind: 'EVACUATION', mode: 'LIVE', startedAt: at }),
    'Ett larm startade tis 13 okt 08:00. Öppna fliken Larm och räkna din grupp.',
    'An alarm started Tue 13 Oct 08:00. Open the Alarm tab and count your group.',
  ],
  [
    'CRISIS_ALARM, a drill, which says so',
    row('CRISIS_ALARM', { alarmId: 'a-1', kind: 'LOCKDOWN', mode: 'DRILL', startedAt: at }),
    'En övning startade tis 13 okt 08:00. Öppna fliken Larm och räkna din grupp.',
    'A drill started Tue 13 Oct 08:00. Open the Alarm tab and count your group.',
  ],
  [
    'CRISIS_ENDED',
    row('CRISIS_ENDED', { alarmId: 'a-1', kind: 'EVACUATION', mode: 'LIVE', startedAt: at, endedAt: '2026-10-13T08:20:00.000Z' }),
    'Larmet som startade tis 13 okt 08:00 är avslutat.',
    'The alarm that started Tue 13 Oct 08:00 has ended.',
  ],
  [
    'CRISIS_ENDED, a drill',
    row('CRISIS_ENDED', { alarmId: 'a-1', kind: 'EVACUATION', mode: 'DRILL', startedAt: at, endedAt: '2026-10-13T08:20:00.000Z' }),
    'Övningen som startade tis 13 okt 08:00 är avslutad.',
    'The drill that started Tue 13 Oct 08:00 has ended.',
  ],
  [
    'CRISIS_GUARDIAN_AFTER, to a guardian: that the school had an alarm and it is over',
    row('CRISIS_GUARDIAN_AFTER', { kind: 'EVACUATION', startedAt: at, endedAt: '2026-10-13T08:20:00.000Z' }),
    'Skolan har haft ett larm tis 13 okt 08:00. Det är avslutat.',
    'The school had an alarm Tue 13 Oct 08:00. It has ended.',
  ],
  [
    'LESSON_REPORT_REMINDER, several lessons: the count is the teacher’s own',
    row('LESSON_REPORT_REMINDER', { count: 3, limitDays: 2 }),
    '3 nya lektioner hölls för minst 2 dagar sedan och saknar sparat register. Äldre öppna lektioner kan finnas kvar. Spara närvaron under Närvaro.',
    '3 new lessons were held at least 2 days ago and have no saved register. Older open lessons may remain. Save the attendance under Attendance.',
  ],
  [
    'LESSON_REPORT_REMINDER, one lesson and a limit of one day',
    row('LESSON_REPORT_REMINDER', { count: 1, limitDays: 1 }),
    'En ny lektion hölls för minst en dag sedan och saknar sparat register. Äldre öppna lektioner kan finnas kvar. Spara närvaron under Närvaro.',
    'One new lesson was held at least one day ago and has no saved register. Older open lessons may remain. Save the attendance under Attendance.',
  ],
  [
    'REPORTING_RATE_DIGEST, the week only: no count, no share',
    row('REPORTING_RATE_DIGEST', { periodStart: '2026-11-02', periodEnd: '2026-11-08', held: 120, reported: 96, teachers: 14 }),
    'Rapporteringsgrad 2 nov – 8 nov: veckans sammanställning för skolan finns i Rastra Schema på webben.',
    "Reporting rate 2 Nov – 8 Nov: the week's summary for the school is in Rastra timetable on the web.",
  ],
  [
    'ACK_REQUESTED, the title of the message (behind the login), not the text, the sender or the child',
    row('ACK_REQUESTED', { requestId: 'r-1', title: 'Utflykten är på torsdag' }),
    'Skolan ber dig bekräfta: Utflykten är på torsdag',
    'The school asks you to confirm: Utflykten är på torsdag',
  ],
  [
    'ACK_REMINDER, once, with the same title',
    row('ACK_REMINDER', { requestId: 'r-1', title: 'Utflykten är på torsdag' }),
    'Påminnelse: skolan väntar på din bekräftelse av Utflykten är på torsdag',
    'Reminder: the school is waiting for your confirmation of Utflykten är på torsdag',
  ],
  [
    'LEAVE_CONSENT_REQUESTED, the child and the days, never who applied',
    row('LEAVE_CONSENT_REQUESTED', { leaveRequestId: 'l-1', studentName: 'Alva Elev', startDate: '2026-11-02', endDate: '2026-11-06' }),
    'Ledighetsansökan för Alva Elev (2026-11-02 – 2026-11-06) väntar på ditt samtycke.',
    'A leave request for Alva Elev (2026-11-02 – 2026-11-06) is waiting for your consent.',
  ],
  [
    'LEAVE_CONSENT_REMINDER, once, with the same child and days',
    row('LEAVE_CONSENT_REMINDER', { leaveRequestId: 'l-1', studentName: 'Alva Elev', startDate: '2026-11-02', endDate: '2026-11-06' }),
    'Påminnelse: ledighetsansökan för Alva Elev (2026-11-02 – 2026-11-06) väntar fortfarande på ditt samtycke.',
    'Reminder: a leave request for Alva Elev (2026-11-02 – 2026-11-06) is still waiting for your consent.',
  ],
  [
    'LEAVE_CONSENT_REFUSED, to whoever applied: that a guardian did not consent, never which',
    row('LEAVE_CONSENT_REFUSED', { leaveRequestId: 'l-1', studentName: 'Alva Elev', startDate: '2026-11-02', endDate: '2026-11-06' }),
    'Ledighetsansökan för Alva Elev (2026-11-02 – 2026-11-06) har avslutats, eftersom en vårdnadshavare inte samtyckte.',
    'The leave request for Alva Elev (2026-11-02 – 2026-11-06) has ended, because a guardian did not consent.',
  ],
];

describe('notificationText', () => {
  it.each(CASES)('%s', (_name, entry, svText, enText) => {
    expect(notificationText(entry, translatorFor('sv'), 'sv')).toBe(svText);
    expect(notificationText(entry, translatorFor('en'), 'en')).toBe(enText);
  });

  it('covers all thirty types the gateway writes', () => {
    const types = new Set(CASES.map(([, entry]) => entry.type));
    expect(types.size).toBe(30);
  });

  describe('the three notices of Ledighetspolicy', () => {
    const TYPES = ['LEAVE_CONSENT_REQUESTED', 'LEAVE_CONSENT_REMINDER', 'LEAVE_CONSENT_REFUSED'] as const;
    const WORDS = ['ansökan', 'request'];

    it.each(TYPES)('%s says nothing the meta carries beyond the child and the days', (type) => {
      // Whatever a gateway put in the meta, the sentence is the child and the days: not who applied, who refused or why.
      const meta = {
        leaveRequestId: 'l-1',
        studentName: 'Alva Elev',
        startDate: '2026-11-02',
        endDate: '2026-11-06',
        requestedByName: 'Anna Lind',
        refusedByName: 'Bertil Lind',
        guardianName: 'Cecilia Lind',
        reason: 'Hemlig anledning',
        contact: { name: 'Doris Lind', phone: '070-123 45 67' },
      };
      for (const [locale, say] of [['sv', translatorFor('sv')], ['en', translatorFor('en')]] as const) {
        const text = notificationText(row(type, meta), say, locale);
        for (const secret of ['Anna', 'Bertil', 'Cecilia', 'Doris', 'Hemlig', '070-123']) expect(text).not.toContain(secret);
        expect(text).toContain('Alva Elev');
        expect(text).toContain('2026-11-02 – 2026-11-06');
        expect(WORDS.some((word) => text.toLowerCase().includes(word))).toBe(true);
      }
    });

    it.each(TYPES)('words %s without a name as “your child”, and without days leaves the brackets out', (type) => {
      for (const meta of [null, {}, { studentName: '   ' }, { studentName: null }]) {
        const sv = notificationText(row(type, meta), translatorFor('sv'), 'sv');
        const en = notificationText(row(type, meta), translatorFor('en'), 'en');
        expect(sv).toContain('ditt barn');
        expect(en).toContain('your child');
        for (const text of [sv, en]) {
          expect(text).not.toContain('( – )');
          expect(text).not.toContain('()');
          expect(text).not.toContain('{');
          expect(text).not.toContain('undefined');
        }
      }
    });

    it('leaves the days out when only one of them came', () => {
      const text = notificationText(row('LEAVE_CONSENT_REQUESTED', { studentName: 'Alva Elev', startDate: '2026-11-02' }), translatorFor('sv'), 'sv');
      expect(text).toBe('Ledighetsansökan för Alva Elev väntar på ditt samtycke.');
    });
  });

  it.each([
    ['no meta at all', null],
    ['meta without a title', { requestId: 'r-1' }],
    ['a title that is not a string', { requestId: 'r-1', title: { text: 'x' } }],
    ['a title of only spaces', { requestId: 'r-1', title: '   ' }],
  ])('words a Kvittens notice with %s as a message, not as a sentence that ends on a colon', (_name, meta) => {
    const sv = translatorFor('sv');
    const en = translatorFor('en');
    expect(notificationText(row('ACK_REQUESTED', meta), sv, 'sv')).toBe('Skolan ber dig bekräfta ett meddelande.');
    expect(notificationText(row('ACK_REQUESTED', meta), en, 'en')).toBe('The school asks you to confirm a message.');
    expect(notificationText(row('ACK_REMINDER', meta), sv, 'sv')).toBe('Påminnelse: skolan väntar på din bekräftelse av ett meddelande.');
    expect(notificationText(row('ACK_REMINDER', meta), en, 'en')).toBe('Reminder: the school is waiting for your confirmation of a message.');
  });

  it('trims the title of a Kvittens notice and says nothing else the meta carries', () => {
    const text = notificationText(
      row('ACK_REQUESTED', { title: '  Beslutet om ledighet ', body: 'Hemlig text', authorName: 'Anna Lind', studentName: 'Alva Elev' }),
      translatorFor('sv'),
      'sv',
    );
    expect(text).toBe('Skolan ber dig bekräfta: Beslutet om ledighet');
  });

  it('words an alarm notice written without its time by the time it was written', () => {
    // row() writes createdAt 07:00.
    expect(notificationText(row('CRISIS_ALARM', null), translatorFor('sv'), 'sv')).toBe(
      'Ett larm startade tis 13 okt 07:00. Öppna fliken Larm och räkna din grupp.',
    );
    expect(notificationText(row('CRISIS_GUARDIAN_AFTER', {}), translatorFor('en'), 'en')).toBe(
      'The school had an alarm Tue 13 Oct 07:00. It has ended.',
    );
  });

  it('never names a pupil, a group, a room, a teacher or even the kind of alarm, whatever the meta carries', () => {
    for (const type of ['CRISIS_ALARM', 'CRISIS_ENDED', 'CRISIS_GUARDIAN_AFTER'] as const) {
      for (const language of ['sv', 'en'] as const) {
        const text = notificationText(
          row(type, {
            kind: 'LOCKDOWN',
            mode: 'LIVE',
            startedAt: at,
            endedAt: at,
            studentName: 'Alva Elev',
            groupName: '7A',
            roomName: 'B204',
            teacherName: 'Anna Lind',
          }),
          translatorFor(language),
          language,
        );
        for (const secret of ['Alva', '7A', 'B204', 'Anna', 'Inrymning', 'Lockdown', 'LOCKDOWN', 'EVACUATION']) expect(text).not.toContain(secret);
      }
    }
  });

  it('words a cover notice from a gateway that said no count, no lessons and no name', () => {
    expect(notificationText(row('COVER_REQUESTED', { startsAt: at, expiresAt: '2026-10-13T07:30:00.000Z' }), translatorFor('sv'), 'sv')).toBe(
      'Kan du vikariera en lektion från tis 13 okt 08:00? Svara senast tis 13 okt 07:30.',
    );
    expect(notificationText(row('COVER_REQUEST_CLOSED', { startsAt: at }), translatorFor('en'), 'en')).toBe(
      'The cover lesson Tue 13 Oct 08:00 is already filled by a colleague.',
    );
    expect(notificationText(row('COVER_REQUEST_ACCEPTED', { startsAt: at }), translatorFor('sv'), 'sv')).toBe(
      '— har tackat ja till vikariepasset tis 13 okt 08:00.',
    );
  });

  it('never names whom a cover request replaces, nor a reason, whatever the meta carries', () => {
    for (const type of ['COVER_REQUESTED', 'COVER_REQUEST_CLOSED', 'COVER_REQUEST_ACCEPTED'] as const) {
      const text = notificationText(
        row(type, {
          startsAt: at,
          lessonCount: 1,
          reason: 'TAKEN',
          absentTeacherName: 'Berit Frånvarande',
          absenceReason: 'Sjuk',
          lessons: [{ lessonId: 'l-1', startsAt: at, subjectName: 'Matematik', groupName: '7A', roomName: 'B204' }],
        }),
        translatorFor('sv'),
        'sv',
      );
      expect(text).not.toContain('Berit');
      expect(text).not.toContain('Sjuk');
      // Nor which lesson: the inbox is read on a lock screen as a push is.
      expect(text).not.toContain('Matematik');
      expect(text).not.toContain('7A');
      expect(text).not.toContain('B204');
    }
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

  it('says the rektor’s weekly note without a figure of the school’s, whatever the meta holds', () => {
    const meta = { periodStart: '2026-11-02', periodEnd: '2026-11-08', held: 1234, reported: 987, teachers: 41, teacherName: 'Anna Lind' };
    for (const locale of ['sv', 'en'] as const) {
      const text = notificationText(row('REPORTING_RATE_DIGEST', meta), translatorFor(locale), locale);
      expect(text).not.toMatch(/1234|987|41|Anna|Lind|%/);
    }
  });

  it('says a reminder without the subject, the class, the time or the teacher, whatever the meta holds', () => {
    const text = notificationText(
      row('LESSON_REPORT_REMINDER', { count: 2, limitDays: 3, subjectName: 'Matematik', groupName: '7A', startsAt: at, teacherName: 'Anna Lind' }),
      translatorFor('sv'),
      'sv',
    );
    expect(text).toBe('2 nya lektioner hölls för minst 3 dagar sedan och saknar sparat register. Äldre öppna lektioner kan finnas kvar. Spara närvaron under Närvaro.');
    expect(text).not.toMatch(/Matematik|7A|Anna|08:00/);
  });

  it('survives a reminder and a weekly note with no meta', () => {
    for (const type of ['LESSON_REPORT_REMINDER', 'REPORTING_RATE_DIGEST'] as const) {
      for (const locale of ['sv', 'en'] as const) {
        const text = notificationText(row(type, null), translatorFor(locale), locale);
        expect(text).not.toMatch(/undefined|NaN|\{/);
        expect(text.length).toBeGreaterThan(10);
      }
    }
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
