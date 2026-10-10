import { formatDateTime, formatDayOfInstant } from '../i18n/format';
import type { Locale, Translate } from '../i18n';
import type { NotificationRow } from '../types';

/**
 * One inbox row as a sentence in the reader's language — all nine types the
 * gateway writes, as the web's bell words them. The app used to know five and
 * show "Notification" for the rest, so a teacher's cover booking (which the
 * inbox is the only record of on the phone) read as nothing at all.
 *
 * The words come from the notice's own meta, which is what the in-app row
 * has always shown behind login: never an absence reason (no notice carries
 * one), and a colleague's absence only to the admins it was written for.
 * Instants are the device's clock in the reader's format (format.ts).
 */
export function notificationText(entry: NotificationRow, t: Translate, locale: Locale): string {
  const meta = entry.meta ?? {};
  const str = (key: string): string => {
    const value = meta[key];
    return value === null || value === undefined ? '' : String(value);
  };
  const when = (key: string): string => formatDateTime(str(key), locale);

  switch (entry.type) {
    case 'ABSENCE_UNREPORTED':
      return t('notifications.text.absenceUnreported', {
        student: str('studentName'),
        subject: str('subjectName'),
        date: str('date'),
      });
    case 'LEAVE_DECIDED':
      return t(str('status') === 'APPROVED' ? 'notifications.text.leaveApproved' : 'notifications.text.leaveRejected', {
        student: str('studentName'),
        from: str('startDate'),
        to: str('endDate'),
      });
    case 'LESSON_CANCELLED':
      return t('notifications.text.lessonCancelled', { subject: str('subjectName'), when: when('startsAt') });
    case 'LESSON_SUBSTITUTE':
    case 'LESSON_COVER_WITHDRAWN': {
      // The substitute's own booking (cover: true) and its withdrawal name the
      // group and the room; neither says whom they replace, or why.
      const own = { subject: str('subjectName'), when: when('startsAt'), group: str('groupName'), room: str('roomName') };
      if (entry.type === 'LESSON_COVER_WITHDRAWN') return t('notifications.text.lessonCoverWithdrawn', own);
      return meta['cover'] === true
        ? t('notifications.text.lessonSubstituteCover', own)
        : t('notifications.text.lessonSubstitute', { subject: own.subject, when: own.when });
    }
    case 'LESSON_ROOM_CHANGED':
      return t('notifications.text.lessonRoomChanged', { subject: str('subjectName'), when: when('startsAt') });
    case 'SCHEDULE_CHANGED':
      return t('notifications.text.scheduleChanged', { subject: str('subjectName') });
    case 'ROOM_BOOKING_DECIDED':
      return t(
        str('status') === 'APPROVED' ? 'notifications.text.roomBookingApproved' : 'notifications.text.roomBookingRejected',
        { room: str('roomName'), when: when('startsAt') },
      );
    case 'TEACHER_ABSENCE_REPORTED': {
      // Who and when; the reason is never in a notice. Whole days end at the
      // midnight after the last day, which is said as that last day.
      const days = meta['wholeDays'] === true;
      const at = (iso: string, end: boolean): string => {
        const ms = Date.parse(iso);
        if (Number.isNaN(ms)) return '';
        return days ? formatDayOfInstant(new Date(ms - (end ? 1 : 0)).toISOString(), locale) : formatDateTime(iso, locale);
      };
      const from = at(str('startsAt'), false);
      const to = at(str('endsAt'), true);
      return t('notifications.text.teacherAbsenceReported', {
        teacher: str('teacherName') || t('common.noValue'),
        period: from === to ? from : `${from} – ${to}`,
      });
    }
    default:
      return t('notifications.text.fallback');
  }
}
