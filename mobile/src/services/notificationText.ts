import { formatDateTime, formatDayOfInstant, formatShortDate, formatTime } from '../i18n/format';
import type { Locale, Translate } from '../i18n';
import type { NotificationRow } from '../types';

/**
 * One inbox row as a sentence in the reader's language — every type the
 * gateway writes, as the web's bell words them. The app used to know five and
 * show "Notification" for the rest, so a teacher's cover booking (which the
 * inbox is the only record of on the phone) read as nothing at all.
 *
 * The words come from the notice's own meta, which is what the in-app row
 * has always shown behind login: never an absence reason (no notice carries
 * one), and a colleague's absence only to the admins it was written for.
 * Instants are the device's clock in the reader's format (format.ts).
 *
 * The three cover-request types (Vikariefrågan) are worded from their meta in
 * the catalogue's own block, coverRequests.notice; the three of Krisläge in
 * crisis.notice. The two of Kvittens (a request to confirm a message, and its
 * one reminder) in acks.notice. The three of Ledighetspolicy (a request for a
 * guardian's consent to a leave request, its one reminder, and the end of a
 * request a guardian did not consent to) in notifications.text.leaveConsent*.
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
    case 'LEAVE_DECIDED': {
      // A mentor's decision says so; an older notice has no decidedAs.
      const approved = str('status') === 'APPROVED';
      const key =
        meta['decidedAs'] === 'MENTOR'
          ? approved ? 'notifications.text.leaveApprovedByMentor' : 'notifications.text.leaveRejectedByMentor'
          : approved ? 'notifications.text.leaveApproved' : 'notifications.text.leaveRejected';
      return t(key, { student: str('studentName'), from: str('startDate'), to: str('endDate') });
    }
    case 'LEAVE_REQUESTED':
      // To the mentor who decides it: the pupil and the days, never the reason.
      return t('notifications.text.leaveRequested', {
        student: str('studentName'),
        from: str('startDate'),
        to: str('endDate'),
        count: Number(meta['schoolDays'] ?? 0),
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
    case 'SUPERVISION_COVER':
    case 'SUPERVISION_COVER_WITHDRAWN': {
      // A rastvaktspass the reader takes as vikarie (Rastvakt i vardagen): the
      // place and the time, never whose pass it is or why.
      const pass = { area: str('areaName'), when: when('startsAt'), end: str('endsAt') ? formatTime(str('endsAt')) : '' };
      return entry.type === 'SUPERVISION_COVER'
        ? t('notifications.text.supervisionCover', pass)
        : t('notifications.text.supervisionCoverWithdrawn', pass);
    }
    case 'LESSON_REINSTATED':
      return t('notifications.text.lessonReinstated', { subject: str('subjectName'), when: when('startsAt') });
    case 'LESSON_SUPERVISED_STUDY':
      return t('notifications.text.lessonSupervisedStudy', { subject: str('subjectName'), when: when('startsAt') });
    case 'CANCELLATION_DIGEST': {
      // One per person per avbokning: how many of their lessons and the days
      // (calendar dates, read as such); the reversal says they go ahead.
      const day = (key: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(str(key)) ? formatShortDate(str(key), locale) : str(key));
      const from = day('startDate');
      const to = day('endDate');
      const count = Number(meta['lessonCount'] ?? 0);
      return t(meta['reversed'] === true ? 'notifications.text.cancellationDigestReversed' : 'notifications.text.cancellationDigest', {
        name: str('name'),
        count,
        span: from === to ? from : `${from} – ${to}`,
      });
    }
    case 'ABSENCE_WATCH_DIGEST': {
      // Frånvarobevakning: counts and a period, never a pupil, a figure of
      // minutes or a reason; who the pupils are is read on the web, behind the
      // login. The guardian's counts are their own children.
      const open = Number(meta['open'] ?? 0);
      const crossed = Number(meta['crossed'] ?? 0);
      const day = (key: string): string => (/^\d{4}-\d{2}-\d{2}/.test(str(key)) ? formatShortDate(str(key).slice(0, 10), locale) : str(key));
      const span = `${day('periodStart')} – ${day('periodEnd')}`;
      if (meta['group'] === 'GUARDIAN') {
        return open > 0
          ? t('notifications.text.absenceWatchDigestGuardian', { span, count: open })
          : t('notifications.text.absenceWatchDigestGuardianBack', { span, count: crossed });
      }
      return open > 0
        ? t('notifications.text.absenceWatchDigestOpen', { span, count: open, crossed })
        : t('notifications.text.absenceWatchDigestBack', { span, count: crossed });
    }
    case 'LESSON_PUPIL_MOVED':
      // Elevens lektion för dagen: the two subjects and the time, never who moved the pupil and never the
      // pupil: a teacher finds them in the register, a guardian is told of their own child.
      return t(meta['undone'] === true ? 'notifications.text.lessonPupilMovedUndone' : 'notifications.text.lessonPupilMoved', {
        from: str('fromSubjectName'),
        to: str('toSubjectName'),
        when: when('startsAt'),
      });
    case 'EXTERNAL_BOOKING_CLASH':
      // Lokal: that days clash, never the hirer (who is not a user) or which room; the list is on the web.
      return t('notifications.text.externalBookingClash');
    case 'LESSON_REPORT_REMINDER': {
      // Rapporteringsgrad: how many lessons stand open and the school's limit,
      // never which lesson, its subject, its class or its time. The count is
      // the teacher's own and is of the lessons that crossed the limit since
      // the last notice ("new": older ones may remain), so it may be said;
      // where to save the register is the attendance tab.
      const count = Math.max(0, Math.trunc(Number(meta['count'])) || 0);
      const limitDays = Math.max(0, Math.trunc(Number(meta['limitDays'])) || 0);
      return t('notifications.text.lessonReportReminder', {
        count,
        limit: t('notifications.text.lessonReportLimit', { count: limitDays }),
      });
    }
    case 'REPORTING_RATE_DIGEST': {
      // The rektor's weekly note: the week it concerns and nothing else. The
      // share, the lessons and the teachers are read on the web, behind the
      // login; a lock screen shows no figure of the school's.
      const day = (key: string): string => (/^\d{4}-\d{2}-\d{2}/.test(str(key)) ? formatShortDate(str(key).slice(0, 10), locale) : str(key));
      return t('notifications.text.reportingRateDigest', { span: `${day('periodStart')} – ${day('periodEnd')}` });
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
    case 'COVER_REQUESTED':
    case 'COVER_REQUEST_ACCEPTED':
    case 'COVER_REQUEST_CLOSED': {
      // Vikariefrågan: how many lessons and from when, never which lesson
      // (the inbox is read on a lock screen as a push is), who is away or
      // why (no cover notice carries either). The count is the request's
      // lessons; a notice from a gateway that did not say counts one.
      const count = Math.max(1, Math.trunc(Number(meta['lessonCount'])) || 1);
      if (entry.type === 'COVER_REQUEST_ACCEPTED') {
        return t('coverRequests.notice.accepted', { name: str('acceptedByName') || t('common.noValue'), when: when('startsAt'), count });
      }
      if (entry.type === 'COVER_REQUEST_CLOSED') {
        const reason = meta['reason'];
        const key =
          reason === 'WITHDRAWN'
            ? 'coverRequests.notice.closedWithdrawn'
            : reason === 'NOT_NEEDED'
              ? 'coverRequests.notice.closedNotNeeded'
              : reason === 'UNANSWERED'
                ? 'coverRequests.notice.closedUnanswered'
                : 'coverRequests.notice.closedTaken';
        return t(key, { when: when('startsAt'), count });
      }
      // How many and from when, as the push and the web's bell say it: the
      // lesson itself (subject, group, room) is on the card behind the login.
      return t('coverRequests.notice.requested', { when: when('startsAt'), until: when('expiresAt'), count });
    }
    case 'CRISIS_ALARM':
    case 'CRISIS_ENDED':
    case 'CRISIS_GUARDIAN_AFTER': {
      // Krisläge: that an alarm (or a drill) began, that it ended, or, to a
      // guardian after a real one, that the school had one and it is over.
      // Never the kind, a group, a pupil or a place: the inbox is read on a
      // lock screen as a push is, and what a teacher has to do is read behind
      // the login, in their own groups. The time is when it began; a notice
      // written without it is worded by the time it was written.
      const began = str('startedAt') || entry.createdAt;
      const params = { when: formatDateTime(began, locale) };
      if (entry.type === 'CRISIS_GUARDIAN_AFTER') return t('crisis.notice.guardianAfter', params);
      const drill = meta['mode'] === 'DRILL';
      if (entry.type === 'CRISIS_ALARM') return t(drill ? 'crisis.notice.alarmDrill' : 'crisis.notice.alarm', params);
      return t(drill ? 'crisis.notice.endedDrill' : 'crisis.notice.ended', params);
    }
    case 'ACK_REQUESTED':
    case 'ACK_REMINDER': {
      // Kvittens: the message's title, which is behind the login as the
      // inbox is (the push says only that a message waits). Never the text,
      // the sender or the child. A title that is missing or not a string is
      // left out, and the sentence says "a message" instead of ending on a
      // colon.
      const title = typeof meta['title'] === 'string' ? meta['title'].trim() : '';
      if (entry.type === 'ACK_REQUESTED') {
        return title ? t('acks.notice.requested', { title }) : t('acks.notice.requestedNoTitle');
      }
      return title ? t('acks.notice.reminder', { title }) : t('acks.notice.reminderNoTitle');
    }
    case 'LEAVE_CONSENT_REQUESTED':
    case 'LEAVE_CONSENT_REMINDER':
    case 'LEAVE_CONSENT_REFUSED': {
      // Ledighetspolicy: the child and the days, which are behind the login as
      // the inbox is (the push says only that a request waits or ended).
      // NEVER who applied, and never who did not consent: separated
      // guardians may hide from one another, and the meta carries neither.
      // A missing name is "your child", and missing days leave the brackets
      // out rather than print an empty "( – )".
      const from = str('startDate');
      const to = str('endDate');
      const params = {
        student: str('studentName').trim() || t('notifications.text.leaveConsentYourChild'),
        range: from && to ? ` (${from} – ${to})` : '',
      };
      if (entry.type === 'LEAVE_CONSENT_REQUESTED') return t('notifications.text.leaveConsentRequested', params);
      if (entry.type === 'LEAVE_CONSENT_REMINDER') return t('notifications.text.leaveConsentReminder', params);
      return t('notifications.text.leaveConsentRefused', params);
    }
    default:
      return t('notifications.text.fallback');
  }
}
