import type { UserRole } from "@/lib/types";

/**
 * What the bell says of a notice and where it leads: pure functions of the
 * row, kept out of notification-bell.tsx. The bell is in the same chunk as
 * AppShell on every signed-in route, and that module's part of the chunk sits
 * just under Turbopack's minChunkSize: code added to it splits the chunk in
 * two, +0.7 to 0.9 KB on every route (see the note in app-shell.tsx). The
 * words and the links of the notice types are here, where a new type costs
 * the chunk nothing.
 */

export interface NotificationRow {
  id: string;
  type:
    | "ABSENCE_UNREPORTED"
    | "LEAVE_DECIDED"
    | "LESSON_CANCELLED"
    | "LESSON_SUBSTITUTE"
    | "LESSON_ROOM_CHANGED"
    | "SCHEDULE_CHANGED"
    | "ROOM_BOOKING_DECIDED"
    | "TEACHER_ABSENCE_REPORTED"
    | "LESSON_COVER_WITHDRAWN"
    | "LESSON_REINSTATED"
    | "LESSON_SUPERVISED_STUDY"
    | "CANCELLATION_DIGEST"
    | "LEAVE_REQUESTED"
    | "SUPERVISION_COVER"
    | "SUPERVISION_COVER_WITHDRAWN"
    | "COVER_REQUESTED"
    | "COVER_REQUEST_CLOSED"
    | "COVER_REQUEST_ACCEPTED"
    | "ABSENCE_WATCH_DIGEST"
    | "ACK_REQUESTED"
    | "ACK_REMINDER"
    | "LEAVE_CONSENT_REQUESTED"
    | "LEAVE_CONSENT_REMINDER"
    | "LEAVE_CONSENT_REFUSED"
    | "LESSON_PUPIL_MOVED"
    | "EXTERNAL_BOOKING_CLASH"
    | "CRISIS_ALARM"
    | "CRISIS_ENDED"
    | "CRISIS_GUARDIAN_AFTER"
    | "LESSON_REPORT_REMINDER"
    | "REPORTING_RATE_DIGEST";
  meta: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

/** The half of next-intl's translator the texts need, so a test can pass a stub. */
export type NoticeTranslator = (key: string, values?: Record<string, string | number>) => string;

/**
 * Where a notice leads (Vikariefrågan): the colleague to the question, the
 * administrator to the board (also for a question that ran out unanswered).
 */
const HREF: Partial<Record<NotificationRow["type"], string>> = {
  COVER_REQUESTED: "/teacher/franvaro",
  COVER_REQUEST_CLOSED: "/teacher/franvaro",
  COVER_REQUEST_ACCEPTED: "/admin/cover",
  // Rapporteringsgrad (D2): the teacher to the lessons that stand open, rektor to the week's figures.
  LESSON_REPORT_REMINDER: "/teacher/reporting-rate",
  REPORTING_RATE_DIGEST: "/admin/reporting-rate",
  // Kvittens: the guardian to the message they are asked to confirm.
  // Lokal: the expedition to the list of days that clash with a lesson.
  EXTERNAL_BOOKING_CLASH: "/admin/external-bookings",
  ACK_REQUESTED: "/guardian/acknowledgements",
  ACK_REMINDER: "/guardian/acknowledgements",
  // Ledighetspolicy: the guardian, whom the school asks for consent, to the page that lists the leave requests.
  // The "no" that ends a request goes to whoever filed it, by their role (LEAVE_REFUSED_HREF); "/guardian" is
  // what it says for a reader whose role is not given.
  LEAVE_CONSENT_REQUESTED: "/guardian",
  LEAVE_CONSENT_REMINDER: "/guardian",
  LEAVE_CONSENT_REFUSED: "/guardian",
};

/**
 * Krisläge: an alarm that is going or is over leads to the page where it is
 * read, which is not the same page for a teacher (their groups) and for an
 * administrator (the live view). The notice carries no id of its own that the
 * pages would need: both show the alarm that is open. The guardian's notice
 * (CRISIS_GUARDIAN_AFTER) leads nowhere: it says that something happened and
 * ended, and there is nothing a guardian could open.
 */
const CRISIS_HREF = { SCHOOL_ADMIN: "/admin/crisis", TEACHER: "/teacher/crisis" } as const;

/**
 * Ledighetspolicy: a guardian's "no" ends the request for whoever filed it, and that is a guardian, a pupil or an
 * administrator (family.controller: GUARDIAN, STUDENT, SCHOOL_ADMIN). The guardian and the administrator each
 * read their requests on a page of their own; a pupil has none in the web, so the notice says what happened and
 * leads nowhere rather than to a page that does not show the request. The administrator lands on the tab the ended
 * request is under (GUARDIAN_DECLINED), which the page opens on when the address says so.
 */
const LEAVE_REFUSED_HREF: Partial<Record<UserRole, string>> = {
  GUARDIAN: "/guardian",
  SCHOOL_ADMIN: "/admin/leave?filter=GUARDIAN_DECLINED",
};

/** The notice as one sentence, in the reader's language. */
export function noticeText(entry: NotificationRow, t: NoticeTranslator): string {
  const meta = entry.meta ?? {};
  const str = (key: string) => String(meta[key] ?? "");
  // Most notices name the lesson's time; the ones that do not never read it.
  const when = new Date(str("startsAt")).toLocaleString();
  switch (entry.type) {
    case "ABSENCE_UNREPORTED":
      return t("absenceUnreported", {
        student: str("studentName"),
        subject: str("subjectName"),
        date: str("date"),
      });
    case "LEAVE_DECIDED": {
      // A mentor's decision says so (20261023091000); an older notice has no decidedAs.
      const approved = str("status") === "APPROVED";
      const byMentor = meta.decidedAs === "MENTOR";
      const key = byMentor
        ? approved ? "leaveApprovedByMentor" : "leaveRejectedByMentor"
        : approved ? "leaveApproved" : "leaveRejected";
      return t(key, { student: str("studentName"), from: str("startDate"), to: str("endDate") });
    }
    case "LEAVE_REQUESTED":
      // To the mentor who decides it: the pupil and the days, never the reason.
      return t("leaveRequested", {
        student: str("studentName"),
        from: str("startDate"),
        to: str("endDate"),
        days: Number(meta.schoolDays ?? 0),
      });
    case "ABSENCE_WATCH_DIGEST":
      // Frånvarobevakning: counts and a period, never a pupil, a figure of
      // minutes or a reason (the e-mail says no more). The guardian's
      // counts are their own children.
      return t(meta.group === "GUARDIAN" ? "absenceWatchDigestGuardian" : "absenceWatchDigest", {
        open: Number(meta.open ?? 0),
        crossed: Number(meta.crossed ?? 0),
        from: str("periodStart").slice(0, 10),
        to: str("periodEnd").slice(0, 10),
      });
    case "ACK_REQUESTED":
    case "ACK_REMINDER":
      // Kvittens: the message's title, which is behind the login (the push and the e-mail say
      // only that a message waits), and never the child. One key per type under "ack", for the bundle.
      return t(`ack.${entry.type}`, { title: str("title") });
    case "EXTERNAL_BOOKING_CLASH":
      // Lokal: how many days clash, never the hirer (the list is on the page).
      return t("externalBookingClash", { days: Number(meta.days ?? 0) });
    case "LESSON_PUPIL_MOVED":
      // Elevens lektion för dagen: the lesson the pupil is on now (where they went, or where they are back when
      // the move is undone) and its time, never who moved them or who they are. One sentence for both, because
      // this chunk is in every route's own JavaScript and the admin tier has bytes to spare for no more.
      return t("lessonPupilMoved", { subject: str("subjectName"), when });
    case "LEAVE_CONSENT_REQUESTED":
    case "LEAVE_CONSENT_REMINDER":
    case "LEAVE_CONSENT_REFUSED":
      // Ledighetspolicy: the child and the days, never who applied or who said no (the push and the e-mail say
      // only that a request waits or has ended). One key per type under "leaveConsent", for the bundle.
      return t(`leaveConsent.${entry.type}`, { student: str("studentName"), from: str("startDate"), to: str("endDate") });
    case "LESSON_REPORT_REMINDER":
      // Rapporteringsgrad: how many lessons and the school's limit, never which
      // lesson, its subject, its class or its time (the e-mail says no more).
      return t("lessonReportReminder", { count: Number(meta.count ?? 0), limitDays: Number(meta.limitDays ?? 0) });
    case "REPORTING_RATE_DIGEST":
      // Last week's lessons held and reported for the school as a whole and the
      // week's dates, never a teacher.
      return t("reportingRateDigest", {
        from: str("periodStart").slice(0, 10),
        to: str("periodEnd").slice(0, 10),
        held: Number(meta.held ?? 0),
        reported: Number(meta.reported ?? 0),
      });
    case "LESSON_CANCELLED":
      return t("lessonCancelled", {
        subject: str("subjectName"),
        when,
      });
    case "LESSON_REINSTATED":
      return t("lessonReinstated", {
        subject: str("subjectName"),
        when,
      });
    case "LESSON_SUPERVISED_STUDY":
      return t("lessonSupervisedStudy", {
        subject: str("subjectName"),
        when,
      });
    case "CANCELLATION_DIGEST": {
      // One per person per avbokning: how many of their lessons, and the
      // days; the reversal says they go ahead after all.
      const from = str("startDate");
      const to = str("endDate");
      const values = {
        name: str("name"),
        count: Number(meta.lessonCount ?? 0),
        span: from === to ? from : `${from} – ${to}`,
      };
      return t(meta.reversed === true ? "cancellationDigestReversed" : "cancellationDigest", values);
    }
    case "LESSON_SUBSTITUTE":
    case "LESSON_COVER_WITHDRAWN": {
      // The substitute's own notice (`cover: true`) and its withdrawal name
      // the group and room; neither says whom they replace, or why.
      const own = { subject: str("subjectName"), when, group: str("groupName"), room: str("roomName") };
      if (entry.type === "LESSON_COVER_WITHDRAWN") return t("lessonCoverWithdrawn", own);
      return meta.cover === true ? t("lessonSubstituteCover", own) : t("lessonSubstitute", { subject: own.subject, when });
    }
    case "SUPERVISION_COVER":
    case "SUPERVISION_COVER_WITHDRAWN": {
      // A rastvaktspass the reader takes as vikarie (Rastvakt i vardagen):
      // the place and the time, never whose pass it is or why.
      const clock = { hour: "2-digit", minute: "2-digit" } as const;
      const pass = {
        area: str("areaName"),
        when: new Date(str("startsAt")).toLocaleString([], { dateStyle: "short", timeStyle: "short" }),
        end: new Date(str("endsAt")).toLocaleTimeString([], clock),
      };
      return t(entry.type === "SUPERVISION_COVER" ? "supervisionCover" : "supervisionCoverWithdrawn", pass);
    }
    case "COVER_REQUESTED":
    case "COVER_REQUEST_CLOSED":
    case "COVER_REQUEST_ACCEPTED":
      // Vikariefrågan: when and how many, and the name of whoever said yes; never whose lessons or why.
      return t(`cover.${entry.type}`, {
        when,
        count: Number(meta.lessonCount ?? 0),
        reason: str("reason"),
        name: str("acceptedByName"),
      });
    case "CRISIS_ALARM":
    case "CRISIS_ENDED":
    case "CRISIS_GUARDIAN_AFTER": {
      // Krisläge: that an alarm is going or is over, whether it is an exercise,
      // its kind and when; never a pupil, a group, a room or a teacher. A
      // guardian is told THAT it happened and ended and when, and not what
      // kind of alarm it was (the product's decision): the kind is not even
      // handed to their sentence, whatever the notice's meta carries.
      const at = (key: string) =>
        meta[key] ? new Date(str(key)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
      const times = { when: at("startedAt"), end: at("endedAt") };
      return t(`crisis.${entry.type}`, entry.type === "CRISIS_GUARDIAN_AFTER" ? times : { mode: str("mode"), kind: str("kind"), ...times });
    }
    case "TEACHER_ABSENCE_REPORTED": {
      // Who and when; the reason is never in a notice. Whole days end at
      // the midnight after the last day, which is said as that last day.
      const days = meta.wholeDays === true;
      const at = (iso: string, end: boolean) =>
        days ? new Date(Date.parse(iso) - (end ? 1 : 0)).toLocaleDateString() : new Date(iso).toLocaleString();
      const from = at(str("startsAt"), false);
      const to = at(str("endsAt"), true);
      return t("teacherAbsenceReported", { teacher: str("teacherName") || "—", period: from === to ? from : `${from} – ${to}` });
    }
    case "LESSON_ROOM_CHANGED":
      return t("lessonRoomChanged", {
        subject: str("subjectName"),
        when,
      });
    case "SCHEDULE_CHANGED":
      return t("scheduleChanged", { subject: str("subjectName") });
    case "ROOM_BOOKING_DECIDED":
      return t(
        str("status") === "APPROVED" ? "roomBookingApproved" : "roomBookingRejected",
        { room: str("roomName"), when },
      );
    default:
      // A type added after this build (the gateway's enum grows first): a
      // notice, said as one, rather than an empty line in the list.
      return t("fallback");
  }
}

/**
 * The page a notice leads to, or undefined for one that has none of its own.
 * `role` is the reader's (an alarm leads a teacher and an administrator to
 * different pages).
 */
export function noticeHref(entry: NotificationRow, role?: UserRole): string | undefined {
  if (entry.type === "CRISIS_ALARM" || entry.type === "CRISIS_ENDED") {
    return role === "SCHOOL_ADMIN" ? CRISIS_HREF.SCHOOL_ADMIN : CRISIS_HREF.TEACHER;
  }
  if (entry.type === "LEAVE_CONSENT_REFUSED" && role) return LEAVE_REFUSED_HREF[role];
  return entry.meta?.reason === "UNANSWERED" ? "/admin/cover" : HREF[entry.type];
}
