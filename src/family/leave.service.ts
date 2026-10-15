import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import { recordRead } from '../access-log/access-log';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Role } from '../auth/enums/role.enum';
import { parseUtcDate, toDateString } from '../calendar/publish-days';
import { requireSchoolId, requireUserId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { LeaveRequestsQueryDto } from './dto/family-reads.dto';
import { LEAVE_REQUEST_MAX_DAYS, type CreateLeaveRequestDto, type DecideLeaveRequestDto, type RecordLeaveDelegationDto } from './dto/family.dto';
import { assertMayActForStudent, schoolIdOf } from './family-access';
import { deliverLeaveNotices, tellNewMentors, type LeaveNoticeRow } from './leave-notices';
import { readSchoolDayBasis, schoolDaysOf } from './school-days';

/** What every absence an approved leave writes says (decisions of 20261015090000 and 20261023091000). */
export const APPROVED_LEAVE_NOTE = 'Approved leave';

export const LEAVE_REQUEST_DECIDED = 'LEAVE_REQUEST_DECIDED';
export const LEAVE_REQUEST_TOO_LONG = 'LEAVE_REQUEST_TOO_LONG';
export const LEAVE_REQUEST_ENDS_BEFORE_START = 'LEAVE_REQUEST_ENDS_BEFORE_START';

/** The most requests one list answers with, newest first. */
export const LEAVE_LIST_LIMIT = 200;

/** Rektor's delegation decisions shown in the history. */
const DELEGATION_HISTORY = 20;

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
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
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

function alreadyDecided(): ConflictException {
  return new ConflictException({ message: 'Leave request is already decided.', code: LEAVE_REQUEST_DECIDED });
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
    return this.prisma.withRls(user, async (tx) => {
      await assertMayActForStudent(tx, dto.studentId, user);
      const schoolId = await schoolIdOf(tx, dto.studentId);

      const request = await tx.leaveRequest.create({
        data: {
          schoolId,
          studentId: dto.studentId,
          requestedById,
          startDate: parseUtcDate(dto.startDate),
          endDate: parseUtcDate(dto.endDate),
          reason: dto.reason,
        },
        select: { id: true, studentId: true, status: true },
      });

      const told = await tx.$queryRaw<LeaveNoticeRow[]>`
        SELECT "notificationId", "userId", "email", "meta" FROM app.leave_request_notices(${request.id}::uuid)`;
      deliverLeaveNotices(this.notifications, tx, schoolId, told);

      this.logger.log(`Leave requested [request=${request.id}, mentorsTold=${told.length}]`);
      return request;
    });
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
          student: { select: { firstName: true, lastName: true } },
        },
      });
      if (!request) throw await this.missing(tx, id, asMentor);
      if (request.status !== 'PENDING') throw alreadyDecided();

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
        },
      });
      const facts =
        staff && rows.length > 0
          ? await tx.$queryRaw<FactRow[]>`SELECT * FROM app.leave_request_facts(${rows.map((row) => row.id)}::uuid[])`
          : [];
      const factsById = new Map(facts.map((fact) => [fact.requestId, fact]));

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
