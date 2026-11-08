import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { leaveSqlStateOf, tooLateDaysOf } from './leave-errors';
import { recordRead } from '../access-log/access-log';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Role } from '../auth/enums/role.enum';
import { parseUtcDate, toDateString } from '../calendar/publish-days';
import { requireSchoolId, requireUserId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { LeaveRequestsQueryDto } from './dto/family-reads.dto';
import {
  LEAVE_REQUEST_MAX_DAYS,
  type AnswerLeaveConsentDto,
  type CreateLeaveRequestDto,
  type DecideLeaveRequestDto,
  type RecordLeaveDelegationDto,
  type RecordLeavePolicyDto,
} from './dto/family.dto';
import { assertMayActForStudent, schoolIdOf } from './family-access';
import { deliverConsentNotices, deliverLeaveNotices, tellNewMentors, type ConsentNoticeRow, type LeaveNoticeRow } from './leave-notices';
import { readSchoolDayBasis, schoolDaysOf } from './school-days';

/** What every absence an approved leave writes says (decisions of 20261015090000 and 20261023091000). */
export const APPROVED_LEAVE_NOTE = 'Approved leave';

export const LEAVE_REQUEST_DECIDED = 'LEAVE_REQUEST_DECIDED';
export const LEAVE_REQUEST_TOO_LONG = 'LEAVE_REQUEST_TOO_LONG';
export const LEAVE_REQUEST_ENDS_BEFORE_START = 'LEAVE_REQUEST_ENDS_BEFORE_START';
/** Ledighetspolicy (20270205091000): the school's choices, in the codes the families' pages word. */
export const LEAVE_REQUEST_TOO_LATE = 'LEAVE_REQUEST_TOO_LATE';
export const LEAVE_CONTACT_REQUIRED = 'LEAVE_CONTACT_REQUIRED';
export const LEAVE_CONTACT_INCOMPLETE = 'LEAVE_CONTACT_INCOMPLETE';
/** The request waits for every guardian's consent and cannot be decided yet. */
export const LEAVE_AWAITING_CONSENT = 'LEAVE_AWAITING_CONSENT';
export const LEAVE_CONSENT_NOT_A_GUARDIAN = 'LEAVE_CONSENT_NOT_A_GUARDIAN';
export const LEAVE_CONSENT_NOT_FOUND = 'LEAVE_CONSENT_NOT_FOUND';
/** The request was decided, or ended by a guardian's no, before this answer. */
export const LEAVE_CONSENT_REQUEST_ENDED = 'LEAVE_CONSENT_REQUEST_ENDED';
export const LEAVE_CONSENT_CUSTODY_ENDED = 'LEAVE_CONSENT_CUSTODY_ENDED';
/** The guardian answered the other way before: an answer is final. */
export const LEAVE_CONSENT_ANSWERED = 'LEAVE_CONSENT_ANSWERED';

/** The most requests one list answers with, newest first. */
export const LEAVE_LIST_LIMIT = 200;

/** Rektor's delegation decisions shown in the history. */
const DELEGATION_HISTORY = 20;

/** The school's leave policy (Ledighetspolicy): off, off and none, until an administrator who decides says otherwise. */
export interface LeavePolicyView {
  /** Every guardian with active custody must consent before the request goes to a decision. */
  requireAllGuardians: boolean;
  /** Fewest calendar days from the filing day to the first day of leave; null: none. */
  minDaysAhead: number | null;
  /** What a later request meets: the form refuses it, or the decider is told. */
  shortNotice: 'REFUSE' | 'FLAG';
  /** A temporary contact during the leave: not asked, asked, or required. */
  contact: 'OFF' | 'OPTIONAL' | 'REQUIRED';
}

/** Where a request stands with the guardians' consent (app.leave_consent_facts). */
export interface LeaveConsentView {
  /** The school asked every guardian when the request was filed. */
  required: boolean;
  /** NOT_REQUIRED, WAITING (someone who can still answer has not), GIVEN, or REFUSED (a no ended the request). */
  state: 'NOT_REQUIRED' | 'WAITING' | 'GIVEN' | 'REFUSED';
  /** The calling guardian's own part: NOT_ASKED for anyone else, and for the guardian who applied. */
  mine: 'NOT_ASKED' | 'WAITING' | 'GIVEN' | 'REFUSED' | 'ENDED';
  /** How many guardians were asked, have consented and still wait: for staff who read the request, never who. Null for a family. */
  asked: number | null;
  given: number | null;
  waiting: number | null;
}

/** The temporary contact, as the person who may read the request reads it. */
export interface LeaveContactView {
  name: string;
  phone: string;
  relation: string;
}

/** What a guardian's answer to a request for consent came to. */
export interface LeaveConsentAnswered {
  id: string;
  answer: 'GIVEN' | 'REFUSED';
  /** Where the request stands with the guardians' consent afterwards, as the guardian may know it. */
  state: LeaveConsentView['state'];
}

export interface LeaveDelegationView {
  /** The mentor decides a request of at most this many skoldagar; null is no delegation. */
  mentorMaxSchoolDays: number | null;
  reference: string | null;
  decidedAt: string;
  decidedBy: string | null;
}

/**
 * One request of GET /api/v1/leave-requests. The first fields are the row as
 * the families' clients have read it since the read went through the
 * gateway (Läslogg): /guardian and the app take an array of exactly these,
 * so what this adds is only ever added. Then the names, read as the caller
 * may read them, and the facts rektor and the mentor decide on.
 */
export interface LeaveRequestView {
  id: string;
  studentId: string;
  requestedById: string;
  startDate: string;
  endDate: string;
  /** The family's words. RLS gives them to the family, the admin and the deciding mentor only. */
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'GUARDIAN_DECLINED';
  decidedById: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  /** The role the decision was made in; null before it, and for decisions older than the roles. */
  decidedAs: 'MENTOR' | 'ADMIN' | null;
  student: { id: string; name: string; className: string | null };
  /** Null when row security hides the person from the caller, as for every name below. */
  requestedBy: string | null;
  decidedByName: string | null;
  referral: { by: string | null; at: string } | null;
  /** Filed closer to its first day than the school's minimum (the school chose to let it in and flag it). */
  shortNotice: boolean;
  /** The temporary contact during the leave, if the school asked for one and the family gave it. Read as the request is. */
  contact: LeaveContactView | null;
  consent: LeaveConsentView;
  /** The request's skoldagar (app.leave_request_facts); null in a family's list, which has no facts. */
  schoolDays: number | null;
  /** Who decides it now: the mentors when the delegation covers it, else the admin. Null once decided, and for a family. */
  decides: 'MENTOR' | 'ADMIN' | null;
  /** The pupil's mentors on the request's dates, whoever decides. */
  mentors: Array<{ id: string; name: string }>;
  /** The mentors who may decide it now; empty when the admin does. */
  decidingMentors: Array<{ id: string; name: string }>;
  /**
   * The läsår of its first day and the pupil's other leave in it, for
   * whoever weighs it: rektor on every request, the mentor on a request they
   * are to decide. Null outside every läsår, on a mentor's decided request,
   * and for a family.
   */
  year: {
    name: string;
    startDate: string;
    endDate: string;
    approvedDays: number;
    approvedRequests: number;
    pendingRequests: number;
  } | null;
}

/** A row of app.leave_consent_facts (20270205091000). */
interface ConsentFactRow {
  requestId: string;
  required: boolean;
  state: LeaveConsentView['state'];
  asked: number | null;
  given: number | null;
  waiting: number | null;
  mine: LeaveConsentView['mine'];
}

/** A row of app.leave_request_facts (20261023091000). */
interface FactRow {
  requestId: string;
  schoolDays: number;
  mentorLimit: number | null;
  mentorIds: string[];
  decidingMentorIds: string[];
  yearName: string | null;
  yearStart: Date | null;
  yearEnd: Date | null;
  /** Null, with the läsår, on a request the caller does not weigh (20261101090000). */
  yearApprovedDays: number | null;
  yearApprovedRequests: number | null;
  yearPendingRequests: number | null;
}

const nameOf = (person: { firstName: string; lastName: string } | null | undefined): string | null =>
  person ? `${person.firstName} ${person.lastName}` : null;

/**
 * A request's consent as the view tells it. The facts answer for every row the caller reads; a row
 * without them (decided in between) is told from the row itself, and a request that asked for consent
 * is then told as waiting, which no one acts on.
 */
function consentView(
  row: { consentRequired: boolean; status: string },
  fact: ConsentFactRow | undefined,
): LeaveConsentView {
  if (fact) return { required: fact.required, state: fact.state, mine: fact.mine, asked: fact.asked, given: fact.given, waiting: fact.waiting };
  const state = !row.consentRequired ? 'NOT_REQUIRED' : row.status === 'GUARDIAN_DECLINED' ? 'REFUSED' : 'WAITING';
  return { required: row.consentRequired, state, mine: 'NOT_ASKED', asked: null, given: null, waiting: null };
}

function awaitingConsent(): ConflictException {
  return new ConflictException({ message: 'The leave request waits for every guardian\'s consent.', code: LEAVE_AWAITING_CONSENT });
}

function alreadyDecided(): ConflictException {
  return new ConflictException({ message: 'Leave request is already decided.', code: LEAVE_REQUEST_DECIDED });
}

/** The three contact fields as the database wants them: trimmed, and null for an empty one. */
function contactOf(dto: { contactName?: string; contactPhone?: string; contactRelation?: string }): {
  name: string | null;
  phone: string | null;
  relation: string | null;
} {
  const clean = (value: string | undefined): string | null => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
  };
  return { name: clean(dto.contactName), phone: clean(dto.contactPhone), relation: clean(dto.contactRelation) };
}

/** The 400 a filing is refused with when it breaks the school's policy, by the code app.leave_filing_check gave. */
function filingRefusal(code: string, days: number | null): BadRequestException {
  switch (code) {
    case LEAVE_REQUEST_TOO_LATE:
      return new BadRequestException({
        message: `The school asks for a leave request at least ${days ?? 0} days before the first day.`,
        code,
        params: { days: days ?? 0 },
      });
    case LEAVE_CONTACT_REQUIRED:
      return new BadRequestException({ message: 'The school asks for a temporary contact during the leave.', code });
    default:
      return new BadRequestException({ message: 'A temporary contact needs a name, a telephone number and a relation.', code: LEAVE_CONTACT_INCOMPLETE });
  }
}

/** The same refusal read from the SQLSTATE a trigger raised; null for any other state. */
function refusalOfState(state: string | null, days: number | null): BadRequestException | null {
  switch (state) {
    case 'LV413':
      return filingRefusal(LEAVE_REQUEST_TOO_LATE, days);
    case 'LV414':
      return filingRefusal(LEAVE_CONTACT_REQUIRED, null);
    case 'LV415':
      return filingRefusal(LEAVE_CONTACT_INCOMPLETE, null);
    default:
      return null;
  }
}

const DAY_MS = 86_400_000;

/** Days from `from` to `to`, both yyyy-mm-dd. */
const daysBetween = (from: string, to: string): number => (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS;

/**
 * Leave requests (ledighetsansökan): filing, the decision, passing a request
 * on to rektor, the inboxes, and rektor's delegation (Mentorns
 * ledighetsbeslut, 20261023091000).
 *
 * WHO DECIDES. Rektor (SCHOOL_ADMIN) decides every request, as before. When
 * the school has recorded a delegation, the pupil's mentor decides a request
 * of at most that many skoldagar too: a TEACHER holding MENTORSKAP on the
 * pupil's class on the request's dates. The database says who that is, in
 * one place (app.leave_deciding_mentors), and the arms that let a mentor read
 * and decide are the API's alone, so a teacher's own Supabase session decides
 * nothing. This service never second-guesses the arms: a request a mentor
 * may not decide is one their transaction does not find (404).
 *
 * THE FIRST DECISION WINS. A decision is a conditional UPDATE of a PENDING
 * row; a second mentor, a second admin, or a decision racing a referral
 * finds none and is answered 409.
 *
 * WHAT AN APPROVAL WRITES. One full-day AbsenceReport per skoldag of the
 * request (school-days.ts, the TypeScript twin of app.leave_school_days): no
 * absence on a weekend, a lov or a studiedag, where there was none to report.
 */
@Injectable()
export class LeaveService {
  private readonly logger = new Logger(LeaveService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------------------------------------------------------------------
  // Filing
  // ---------------------------------------------------------------------

  /**
   * A guardian files for a child, a pupil for themselves, an admin for
   * anyone; at most LEAVE_REQUEST_MAX_DAYS days, and never ending before it
   * starts (LeaveRequests_a_year_at_most holds every other path to the same
   * bound). Both are a 400 with a code, which the family's page words in its
   * own language. When the request is the
   * mentor's to decide, the database tells the mentors (LEAVE_REQUESTED) from
   * the row itself, by a trigger, and app.leave_request_notices hands back
   * what it wrote with the mentors' addresses: the filer may neither write a
   * teacher's notification nor read a teacher's address. The e-mail and push
   * follow the commit.
   */
  async createLeaveRequest(dto: CreateLeaveRequestDto, user: AuthenticatedUser) {
    const requestedById = requireUserId(user);
    if (dto.endDate < dto.startDate) {
      throw new BadRequestException({ message: 'endDate must not be before startDate.', code: LEAVE_REQUEST_ENDS_BEFORE_START });
    }
    if (daysBetween(dto.startDate, dto.endDate) >= LEAVE_REQUEST_MAX_DAYS) {
      throw new BadRequestException({
        message: `A leave request covers at most ${LEAVE_REQUEST_MAX_DAYS} days.`,
        code: LEAVE_REQUEST_TOO_LONG,
        params: { days: LEAVE_REQUEST_MAX_DAYS },
      });
    }
    const contact = contactOf(dto);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        await assertMayActForStudent(tx, dto.studentId, user);
        const schoolId = await schoolIdOf(tx, dto.studentId);

        // The school's policy, answered in the families' own words. The database holds the same
        // rules on every path (LeaveRequests_policy) and stamps what the request met.
        const [refusal] = await tx.$queryRaw<Array<{ code: string; days: number | null }>>`
          SELECT "code", "days" FROM app.leave_filing_check(${dto.startDate}::date, ${contact.name}::text, ${contact.phone}::text, ${contact.relation}::text)`;
        if (refusal) throw filingRefusal(refusal.code, refusal.days);

        const request = await tx.leaveRequest.create({
          data: {
            schoolId,
            studentId: dto.studentId,
            requestedById,
            startDate: parseUtcDate(dto.startDate),
            endDate: parseUtcDate(dto.endDate),
            reason: dto.reason,
            contactName: contact.name,
            contactPhone: contact.phone,
            contactRelation: contact.relation,
          },
          select: { id: true, studentId: true, status: true, consentRequired: true, shortNotice: true },
        });

        const told = await tx.$queryRaw<LeaveNoticeRow[]>`
          SELECT "notificationId", "userId", "email", "meta" FROM app.leave_request_notices(${request.id}::uuid)`;
        deliverLeaveNotices(this.notifications, tx, schoolId, told);
        // The guardians the school asked to consent: the database wrote their notices from the row.
        const asked = await tx.$queryRaw<ConsentNoticeRow[]>`
          SELECT "notificationId", "userId", "email", "type", "meta", "schoolId" FROM app.leave_consent_notices(${request.id}::uuid)`;
        deliverConsentNotices(this.notifications, tx, asked);

        this.logger.log(
          `Leave requested [request=${request.id}, mentorsTold=${told.length}, guardiansAsked=${asked.length}, shortNotice=${request.shortNotice}]`,
        );
        return request;
      });
    } catch (error) {
      // A race with the policy (changed, or a day turned over) between the check and the write.
      const refused = refusalOfState(leaveSqlStateOf(error), tooLateDaysOf(error));
      if (refused) throw refused;
      throw error;
    }
  }

  // ---------------------------------------------------------------------
  // Deciding
  // ---------------------------------------------------------------------

  /**
   * The admin's decision, or the deciding mentor's (a TEACHER, whose
   * transaction finds the request only when it is theirs to decide).
   * Recorded with the role it was made in. Approval writes the absence of
   * each skoldag; the requester is told either way.
   */
  async decideLeaveRequest(id: string, dto: DecideLeaveRequestDto, user: AuthenticatedUser) {
    const asMentor = user.role === Role.TEACHER;
    const decidedAs = asMentor ? 'MENTOR' : 'ADMIN';
    // A mentor's decision names the mentor (leave_requests_mentor_update).
    const decidedById = asMentor ? requireUserId(user) : (user.userId ?? null);
    try {
      return await this.decide(id, dto, user, { asMentor, decidedAs, decidedById });
    } catch (error) {
      // A decision racing the last guardian's no, or a custody that came back: the database holds the line.
      const state = leaveSqlStateOf(error);
      if (state === 'LV412') throw awaitingConsent();
      if (state === 'LV409') throw alreadyDecided();
      throw error;
    }
  }

  private async decide(
    id: string,
    dto: DecideLeaveRequestDto,
    user: AuthenticatedUser,
    who: { asMentor: boolean; decidedAs: 'MENTOR' | 'ADMIN'; decidedById: string | null },
  ) {
    const { asMentor, decidedAs, decidedById } = who;
    return this.prisma.withRls(user, async (tx) => {
      const request = await tx.leaveRequest.findUnique({
        where: { id },
        select: {
          id: true,
          schoolId: true,
          studentId: true,
          requestedById: true,
          startDate: true,
          endDate: true,
          status: true,
          consentRequired: true,
          student: { select: { firstName: true, lastName: true } },
        },
      });
      if (!request) throw await this.missing(tx, id, asMentor);
      if (request.status !== 'PENDING') throw alreadyDecided();
      // The school asked every guardian to consent: a request goes to a decision when they have
      // (a custody that ended holds nobody up). The database refuses a decision before it (LV412).
      if (request.consentRequired) {
        const [consent] = await tx.$queryRaw<Array<{ met: boolean }>>`SELECT app.leave_consent_met(${id}::uuid) AS "met"`;
        if (!consent?.met) throw awaitingConsent();
      }

      const { count } = await tx.leaveRequest.updateMany({
        where: { id, status: 'PENDING', ...(asMentor ? { referredAt: null } : {}) },
        data: {
          status: dto.status,
          decidedById,
          decidedAs,
          decidedAt: new Date(),
          decisionNote: dto.note ?? null,
        },
      });
      if (count === 0) throw alreadyDecided();

      const from = toDateString(request.startDate);
      const to = toDateString(request.endDate);
      let absenceDays = 0;
      if (dto.status === 'APPROVED') {
        // The reports below are filed in the decider's name, and their
        // reporter column is required: a principal without a userId may
        // reject a request but not approve one. The throw rolls the decision
        // back.
        const reportedById = requireUserId(user);
        const basis = await readSchoolDayBasis(tx, request.schoolId, request.studentId, from, to);
        const days = schoolDaysOf(basis, from, to);
        if (days.length > 0) {
          // createMany: a TEACHER reads no AbsenceReports row (20261015120000),
          // and an INSERT … RETURNING would ask the SELECT arms.
          await tx.absenceReport.createMany({
            data: days.map((day) => ({
              schoolId: request.schoolId,
              studentId: request.studentId,
              reportedById,
              date: parseUtcDate(day),
              type: 'OTHER' as const,
              note: APPROVED_LEAVE_NOTE,
              // What SS12000 emits as "Beviljad ledighet" (20261114090000);
              // the note is free text a guardian may write too.
              grantedLeave: true,
            })),
          });
        }
        absenceDays = days.length;
      }

      const studentName = `${request.student.firstName} ${request.student.lastName}`;
      const range = `${from} – ${to}`;
      const approved = dto.status === 'APPROVED';
      await this.notifications.notifyUsers(tx, {
        schoolId: request.schoolId,
        userIds: [request.requestedById],
        type: 'LEAVE_DECIDED',
        meta: {
          status: dto.status,
          studentName,
          startDate: from,
          endDate: to,
          note: dto.note ?? null,
          decidedAs,
        },
        email: {
          subject: `Leave request ${approved ? 'approved' : 'rejected'} / Ledighetsansökan ${approved ? 'beviljad' : 'avslagen'}`,
          body:
            `Leave request for ${studentName} (${range}) was ${dto.status.toLowerCase()}${asMentor ? ' by the mentor' : ''}.` +
            (dto.note ? `\nNote: ${dto.note}` : '') +
            `\n\nLedighetsansökan för ${studentName} (${range}) ${approved ? 'beviljades' : 'avslogs'}${asMentor ? ' av mentorn' : ''}.`,
        },
      });

      this.logger.log(
        `Leave request decided [request=${id}, status=${dto.status}, as=${decidedAs}, absenceDays=${absenceDays}]`,
      );
      return { id, status: dto.status, decidedAs, absenceDays };
    });
  }

  /**
   * The deciding mentor passes a pending request on to rektor
   * (app.leave_request_refer). It is the admin's from then on, and the mentor
   * reads it no more.
   */
  async referLeaveRequest(id: string, user: AuthenticatedUser) {
    requireUserId(user);
    return this.prisma.withRls(user, async (tx) => {
      const request = await tx.leaveRequest.findUnique({ where: { id }, select: { status: true } });
      if (!request) throw await this.missing(tx, id, true);
      if (request.status !== 'PENDING') throw alreadyDecided();
      const [row] = await tx.$queryRaw<Array<{ referred: boolean }>>`
        SELECT app.leave_request_refer(${id}::uuid) AS "referred"`;
      if (!row?.referred) throw alreadyDecided();
      this.logger.log(`Leave request passed on to rektor [request=${id}]`);
      return { id, referred: true };
    });
  }

  /**
   * What a request the caller's transaction does not find is: for the
   * pupil's mentor, one that was theirs and is no longer (decided by a
   * co-mentor or rektor, passed on, or moved out of the delegation), which is
   * a 409 like any lost race (app.leave_request_taken says only that); for
   * everybody else, a 404.
   */
  private async missing(tx: PrismaClient, id: string, asMentor: boolean): Promise<Error> {
    if (asMentor) {
      const [row] = await tx.$queryRaw<Array<{ taken: boolean }>>`SELECT app.leave_request_taken(${id}::uuid) AS "taken"`;
      if (row?.taken) return alreadyDecided();
    }
    return new NotFoundException('Leave request not found.');
  }

  // ---------------------------------------------------------------------
  // The inboxes
  // ---------------------------------------------------------------------

  /**
   * GET /api/v1/leave-requests, for everybody who may read leave: rektor's
   * /admin/leave, the mentor's /teacher/ledighet, and the family's own lists
   * on /guardian and in the app. RLS decides which requests come back: a
   * guardian's children's, a pupil's own, every request of the school for
   * the admin, and for a TEACHER the pending requests theirs to decide and
   * the ones they decided. Rektor's delegation is GET /leave-delegation's.
   *
   * For the admin and the mentor each comes with its facts
   * (app.leave_request_facts): skoldagar, who decides it now, the pupil's
   * mentors, and the pupil's leave so far in the läsår, which only the
   * decider weighs: rektor on every request, the mentor on the pending ones
   * (a mentor's decided request has none, since the pupil may no longer be
   * theirs). A family's list has none.
   *
   * Every read is recorded in the read log (Läslogg): a mentor's as
   * LEAVE_REASON_AS_MENTOR, everybody else's as LEAVE_REQUESTS, about the
   * pupils whose requests were answered, and as PEOPLE about whoever else the
   * answer names. Names are read as the caller may read them: a person row
   * security hides is named by nobody (null), never an error.
   */
  async listLeaveRequests(query: LeaveRequestsQueryDto, user: AuthenticatedUser): Promise<LeaveRequestView[]> {
    const schoolId = requireSchoolId(user);
    const staff = user.role === Role.SCHOOL_ADMIN || user.role === Role.TEACHER;
    return this.prisma.withRls(user, async (tx) => {
      const rows = await tx.leaveRequest.findMany({
        where: { schoolId, ...(query.status ? { status: query.status } : {}) },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: LEAVE_LIST_LIMIT,
        select: {
          id: true,
          studentId: true,
          requestedById: true,
          startDate: true,
          endDate: true,
          reason: true,
          status: true,
          createdAt: true,
          decidedById: true,
          decidedAt: true,
          decisionNote: true,
          decidedAs: true,
          referredAt: true,
          referredById: true,
          consentRequired: true,
          shortNotice: true,
          contactName: true,
          contactPhone: true,
          contactRelation: true,
        },
      });
      const facts =
        staff && rows.length > 0
          ? await tx.$queryRaw<FactRow[]>`SELECT * FROM app.leave_request_facts(${rows.map((row) => row.id)}::uuid[])`
          : [];
      const factsById = new Map(facts.map((fact) => [fact.requestId, fact]));
      // The guardians' consent, as the caller may know it: for everybody who reads the request.
      const consents =
        rows.length > 0
          ? await tx.$queryRaw<ConsentFactRow[]>`SELECT * FROM app.leave_consent_facts(${rows.map((row) => row.id)}::uuid[])`
          : [];
      const consentById = new Map(consents.map((fact) => [fact.requestId, fact]));

      // The facts answer for exactly the rows the arms give (RLS 99a); a
      // staff row without them was decided or passed on in between.
      const answered = staff ? rows.filter((row) => factsById.has(row.id)) : rows;
      const named = new Set<string>();
      for (const row of answered) {
        named.add(row.studentId);
        named.add(row.requestedById);
        if (row.decidedById) named.add(row.decidedById);
        if (row.referredById) named.add(row.referredById);
      }
      for (const fact of facts) for (const id of fact.mentorIds) named.add(id);
      const people =
        named.size === 0
          ? []
          : await tx.user.findMany({
              where: { id: { in: [...named] } },
              select: { id: true, firstName: true, lastName: true, studentGroup: { select: { name: true } } },
            });
      const byId = new Map(people.map((person) => [person.id, person]));
      const nameOfId = (id: string | null) => (id ? nameOf(byId.get(id)) : null);
      const mentorsOf = (ids: readonly string[]) => ids.map((id) => ({ id, name: nameOfId(id) ?? '—' }));

      const requests: LeaveRequestView[] = answered.map((row) => {
        const fact = factsById.get(row.id);
        const pending = row.status === 'PENDING';
        return {
          id: row.id,
          studentId: row.studentId,
          requestedById: row.requestedById,
          startDate: toDateString(row.startDate),
          endDate: toDateString(row.endDate),
          reason: row.reason,
          status: row.status,
          decidedById: row.decidedById,
          decidedAt: row.decidedAt?.toISOString() ?? null,
          decisionNote: row.decisionNote,
          createdAt: row.createdAt.toISOString(),
          decidedAs: row.decidedAs,
          student: {
            id: row.studentId,
            name: nameOfId(row.studentId) ?? '—',
            className: byId.get(row.studentId)?.studentGroup?.name ?? null,
          },
          shortNotice: row.shortNotice,
          contact:
            row.contactName && row.contactPhone && row.contactRelation
              ? { name: row.contactName, phone: row.contactPhone, relation: row.contactRelation }
              : null,
          consent: consentView(row, consentById.get(row.id)),
          requestedBy: nameOfId(row.requestedById),
          decidedByName: nameOfId(row.decidedById),
          referral: row.referredAt ? { by: nameOfId(row.referredById), at: row.referredAt.toISOString() } : null,
          schoolDays: fact ? fact.schoolDays : null,
          decides: fact && pending ? (fact.decidingMentorIds.length > 0 ? 'MENTOR' : 'ADMIN') : null,
          mentors: fact ? mentorsOf(fact.mentorIds) : [],
          decidingMentors: fact ? mentorsOf(fact.decidingMentorIds) : [],
          year:
            fact?.yearName &&
            fact.yearStart &&
            fact.yearEnd &&
            fact.yearApprovedDays !== null &&
            fact.yearApprovedRequests !== null &&
            fact.yearPendingRequests !== null
              ? {
                  name: fact.yearName,
                  startDate: toDateString(fact.yearStart),
                  endDate: toDateString(fact.yearEnd),
                  approvedDays: fact.yearApprovedDays,
                  approvedRequests: fact.yearApprovedRequests,
                  pendingRequests: fact.yearPendingRequests,
                }
              : null,
        };
      });

      const pupils = answered.map((row) => row.studentId);
      await recordRead(tx, user.role === Role.TEACHER ? 'LEAVE_REASON_AS_MENTOR' : 'LEAVE_REQUESTS', pupils, user.channel);
      await recordRead(tx, 'PEOPLE', [...named].filter((id) => !pupils.includes(id) && byId.has(id)), user.channel);

      return requests;
    });
  }

  // ---------------------------------------------------------------------
  // Every guardian's consent (Ledighetspolicy, 20270205091000)
  // ---------------------------------------------------------------------

  /**
   * A guardian's answer to a request for consent. The answer is final and the database's
   * (app.leave_consent_answer): a yes that completes the consent tells the mentors who decide
   * the request, a no ends it and tells whoever applied, without saying who. The e-mail and the
   * push follow the commit. Repeating an answer changes nothing; the other answer is a 409.
   */
  async answerConsent(id: string, dto: AnswerLeaveConsentDto, user: AuthenticatedUser): Promise<LeaveConsentAnswered> {
    requireSchoolId(user);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        const told = await tx.$queryRaw<ConsentNoticeRow[]>`
          SELECT "notificationId", "userId", "email", "type", "meta", "schoolId" FROM app.leave_consent_answer(${id}::uuid, ${dto.consent})`;
        deliverConsentNotices(this.notifications, tx, told);
        const [fact] = await tx.$queryRaw<ConsentFactRow[]>`SELECT * FROM app.leave_consent_facts(${[id]}::uuid[])`;
        this.logger.log(`Leave consent answered [request=${id}, consent=${dto.consent}, told=${told.length}]`);
        return { id, answer: dto.consent ? 'GIVEN' : 'REFUSED', state: fact?.state ?? (dto.consent ? 'WAITING' : 'REFUSED') };
      });
    } catch (error) {
      switch (leaveSqlStateOf(error)) {
        case 'LV403':
          throw new ForbiddenException({ message: 'Only a guardian answers a request for consent.', code: LEAVE_CONSENT_NOT_A_GUARDIAN });
        case 'LV404':
          throw new NotFoundException({ message: 'No request for your consent was found.', code: LEAVE_CONSENT_NOT_FOUND });
        case 'LV409':
          throw new ConflictException({ message: 'The leave request is already decided or ended.', code: LEAVE_CONSENT_REQUEST_ENDED });
        case 'LV410':
          throw new ConflictException({ message: 'You are no longer a guardian of the child in the request.', code: LEAVE_CONSENT_CUSTODY_ENDED });
        case 'LV411':
          throw new ConflictException({ message: 'You have already answered, and an answer is final.', code: LEAVE_CONSENT_ANSWERED });
        default:
          throw error;
      }
    }
  }

  /**
   * One pass of the job: a reminder to each guardian who has not answered two days after the
   * request was filed, and the mentors' notices for a request a custody that ended made clear. The
   * database writes them and hands them back with the addresses (app.leave_consent_pass), which
   * answers nothing to a logged-in caller; the delivery follows the commit.
   */
  async consentPass(limit = 200): Promise<{ notices: number; reminded: number }> {
    const rows = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<ConsentNoticeRow[]>`
        SELECT "notificationId", "userId", "email", "type", "meta", "schoolId" FROM app.leave_consent_pass(${limit}::integer)`.then((found) => {
        deliverConsentNotices(this.notifications, tx, found);
        return found;
      }),
    );
    return { notices: rows.length, reminded: rows.filter((row) => row.type === 'LEAVE_CONSENT_REMINDER').length };
  }

  // ---------------------------------------------------------------------
  // The school's policy
  // ---------------------------------------------------------------------

  /** The school's leave policy, for the form and the settings page: always one, all off for a school that chose nothing. */
  async getPolicy(user: AuthenticatedUser): Promise<LeavePolicyView> {
    requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => this.readPolicy(tx));
  }

  /** An administrator who decides records the school's policy, all of it; in force for the requests filed from now on. */
  async setPolicy(dto: RecordLeavePolicyDto, user: AuthenticatedUser): Promise<LeavePolicyView> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const data = {
        requireAllGuardians: dto.requireAllGuardians,
        minDaysAhead: dto.minDaysAhead,
        shortNotice: dto.shortNotice,
        contact: dto.contact,
      };
      await tx.leavePolicy.upsert({ where: { schoolId }, create: { schoolId, ...data }, update: data });
      this.logger.log(
        `Leave policy recorded [consent=${dto.requireAllGuardians}, minDaysAhead=${dto.minDaysAhead ?? 'none'}, shortNotice=${dto.shortNotice}, contact=${dto.contact}]`,
      );
      return this.readPolicy(tx);
    });
  }

  private async readPolicy(tx: PrismaClient): Promise<LeavePolicyView> {
    const [row] = await tx.$queryRaw<LeavePolicyView[]>`
      SELECT "requireAllGuardians", "minDaysAhead", "shortNotice", "contact" FROM app.leave_policy()`;
    return row ?? { requireAllGuardians: false, minDaysAhead: null, shortNotice: 'REFUSE', contact: 'OFF' };
  }

  // ---------------------------------------------------------------------
  // Rektor's delegation
  // ---------------------------------------------------------------------

  /** The delegation in force and the latest decisions before it, for the school's staff. */
  async getDelegation(
    user: AuthenticatedUser,
  ): Promise<{ current: LeaveDelegationView | null; history: LeaveDelegationView[] }> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const rows = await tx.leaveDelegationDecision.findMany({
        where: { schoolId },
        orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
        take: DELEGATION_HISTORY,
        select: { mentorMaxSchoolDays: true, reference: true, decidedAt: true, decidedById: true },
      });
      const names = await this.namesOf(tx, rows.flatMap((row) => (row.decidedById ? [row.decidedById] : [])));
      const views = rows.map((row) => this.delegationView(row, names));
      return { current: views[0] ?? null, history: views };
    });
  }

  /**
   * Rektor records a delegation: the mentor decides a request of at most N
   * skoldagar (1..10), or none (null). A new decision, never an edit; the
   * database stamps who and when. In force at once: pending requests move to
   * or from the mentors with it, and the mentors they move to are told
   * (LEAVE_REQUESTED), once each, as if the request had just been filed.
   */
  async recordDelegation(dto: RecordLeaveDelegationDto, user: AuthenticatedUser): Promise<LeaveDelegationView> {
    const schoolId = requireSchoolId(user);
    requireUserId(user);
    const reference = dto.reference?.trim() || null;
    return this.prisma.withRls(user, async (tx) => {
      const row = await tx.leaveDelegationDecision.create({
        data: { schoolId, mentorMaxSchoolDays: dto.mentorMaxSchoolDays, reference },
        select: { mentorMaxSchoolDays: true, reference: true, decidedAt: true, decidedById: true },
      });
      const told = await tellNewMentors(this.notifications, tx, schoolId);
      this.logger.log(`Leave delegation recorded [mentorMaxSchoolDays=${row.mentorMaxSchoolDays ?? 'none'}, mentorsTold=${told}]`);
      return this.delegationView(row, await this.namesOf(tx, row.decidedById ? [row.decidedById] : []));
    });
  }

  private delegationView(
    row: { mentorMaxSchoolDays: number | null; reference: string | null; decidedAt: Date; decidedById: string | null },
    names: ReadonlyMap<string, string>,
  ): LeaveDelegationView {
    return {
      mentorMaxSchoolDays: row.mentorMaxSchoolDays,
      reference: row.reference,
      decidedAt: row.decidedAt.toISOString(),
      decidedBy: row.decidedById ? (names.get(row.decidedById) ?? null) : null,
    };
  }

  private async namesOf(tx: PrismaClient, ids: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const people = await tx.user.findMany({ where: { id: { in: unique } }, select: { id: true, firstName: true, lastName: true } });
    return new Map(people.map((p) => [p.id, nameOf(p)!]));
  }
}
