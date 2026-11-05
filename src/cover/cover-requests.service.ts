import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type CoverRecipientAnswer, type CoverRequestStatus, type PrismaClient } from '@prisma/client';
import { recordRead } from '../access-log/access-log';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { requireSchoolId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { enterGrundschemaWrite } from '../publication/publish-mode';
import { RealtimeService } from '../realtime/realtime.service';
import { pairsStatement, toBoardItem, type BoardItem, type PairRow } from './cover-board';
import { asDay, dayBounds, readPersonDays, schoolTimezone } from './cover-context';
import { lockLessons, lockTeachers } from './cover-decisions';
import { COVER_PASS_NOT_FOUND, mapCoverErrors, sqlStateOf } from './cover-errors';
import { sendAccepted, sendClosed, sendRequested, type RequestNoticeContext } from './cover-request-notices';
import { requestSelect, toBoardRequest, type BoardRequest } from './cover-request-reads';
import { ownYesBreaksRule, recipientBreaksRule } from './cover-request-rules';
import { hardFindings, maskFindings, type CoverTarget, type PersonLesson, type RuleFinding } from './cover-rules';
import { swedishWhen } from './cover-notices';
import { CoverService, checkWindow, emptyEffects, merge, naming, type CoverEffects } from './cover.service';
import {
  DEFAULT_EXPIRY_MINUTES,
  type CreateCoverRequestDto,
} from './dto/cover-requests.dto';

export const COVER_REQUEST_LESSON_CANCELLED = 'COVER_REQUEST_LESSON_CANCELLED';
export const COVER_REQUEST_LESSON_COVERED = 'COVER_REQUEST_LESSON_COVERED';
export const COVER_REQUEST_LESSON_STARTED = 'COVER_REQUEST_LESSON_STARTED';
export const COVER_REQUEST_EXISTS = 'COVER_REQUEST_EXISTS';
export const COVER_REQUEST_ENDED = 'COVER_REQUEST_ENDED';
export const COVER_REQUEST_RECIPIENT_INVALID = 'COVER_REQUEST_RECIPIENT_INVALID';
export const COVER_REQUEST_WINDOW = 'COVER_REQUEST_WINDOW';

/** A request is judged and shown this long after it was sent. */
const MINE_LOOKBACK_DAYS = 14;
/** The passes a colleague confirms are read this far ahead. */
const PASSES_AHEAD_DAYS = 28;
/** The fairness view's longest period. */
const FAIRNESS_DAYS = 366;
/** A request must have at least this long to be answered. */
const MIN_ANSWER_MS = 60_000;

export type MyRequestState =
  | 'OPEN'
  | 'ACCEPTED_BY_ME'
  | 'DECLINED_BY_ME'
  | 'TAKEN'
  | 'WITHDRAWN'
  | 'EXPIRED'
  | 'CLOSED';

export interface RequestLessonView {
  lessonId: string;
  date: string;
  startsAt: string;
  endsAt: string;
  subjectName: string;
  groupName: string;
  roomName: string | null;
  /** The lesson is no longer held (cancelled): the question cannot be said yes to. */
  cancelled: boolean;
}

/** A request as the colleague asked reads it: the lessons and the time, never who is away. */
export interface MyCoverRequest {
  id: string;
  state: MyRequestState;
  createdAt: string;
  expiresAt: string;
  lessons: RequestLessonView[];
}

/** A pass a cover decision gave the colleague, and whether they have confirmed it. */
export interface MyCoverPass {
  lessonId: string;
  date: string;
  startsAt: string;
  endsAt: string;
  subjectName: string;
  groupName: string;
  roomName: string | null;
  confirmedAt: string | null;
}

export interface MyCoverResponse {
  requests: MyCoverRequest[];
  passes: MyCoverPass[];
}

export interface FairnessRow {
  userId: string;
  received: number;
  accepted: number;
  declined: number;
  /** Asked and never answered: taken by another, withdrawn, expired or just not answered. */
  unanswered: number;
}

export interface FairnessResponse {
  from: string;
  to: string;
  rows: FairnessRow[];
}

/** One locked request row. */
interface LockedRequest {
  id: string;
  schoolId: string;
  status: CoverRequestStatus;
  expiresAt: Date;
  requestedByUserId: string | null;
  now: Date;
}

interface AcceptOutcome {
  effects: CoverEffects;
  schoolId: string;
  requestId: string;
  senderId: string;
  acceptedById: string;
  lessonIds: string[];
  others: string[];
}

/**
 * VIKARIEFRÅGAN: an administrator asks chosen colleagues to cover one or more
 * lessons; the first who says yes gets all of them and it is published; the
 * others are told it is taken; the vikarie confirms with one tap.
 *
 * WHO WRITES WHAT
 *
 *   * The administrator creates and withdraws, with their own claims (Drift).
 *   * A colleague declines with their own claims: a narrow UPDATE of their
 *     own row, held by app.cover_recipient_answer_is_narrow.
 *   * A colleague's YES is placed AS THE ADMINISTRATOR WHO SENT THE REQUEST.
 *     Putting a vikarie on a lesson is the cover board's own write
 *     (CoverService.decideInTransaction): it removes the absent teacher's row,
 *     adds the vikarie's, writes the decision, takes the locks and tells the
 *     class, and every one of those is an administrator's right that a
 *     teacher's claims do not carry. Writing a second version of all that for
 *     a teacher would fork the board's rules, so the yes runs the board's
 *     own function, in one transaction, with the claims of the sender
 *     app.cover_request_sender names. The database says it only to a colleague
 *     who was asked and has not answered, while the request is open, and only
 *     for a sender who is still an active administrator writing Drift. The
 *     colleague's identity is the substitute, never the decider: a yes can do
 *     nothing the sender's own click on this colleague's name could not.
 *
 * THE FIRST YES
 *
 * The request's lessons are locked (the board's own order), then the request
 * row FOR UPDATE, before anything else is read, so any number of colleagues
 * answering together queue there: the first through writes ACCEPTED (and the
 * database refuses that write after expiresAt or for somebody not asked), and
 * each of the others finds the request no longer OPEN when its turn comes and
 * is told it is taken. The yes is judged by the
 * hard rules of cover again (cover-rules.ts): a yes that breaks one, the
 * daily cap among them, is refused by name and the request stays open for the
 * next colleague. Nothing is written until every lesson has passed.
 */
@Injectable()
export class CoverRequestsService {
  private readonly logger = new Logger(CoverRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cover: CoverService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeService,
  ) {}

  // ---------------------------------------------------------------------
  // The administrator

  async create(dto: CreateCoverRequestDto, user: AuthenticatedUser): Promise<BoardRequest> {
    const schoolId = requireSchoolId(user);
    const senderId = user.userId;
    if (!senderId) throw new BadRequestException('Avsändaren saknar användar-id.');
    const now = this.cover.now();
    const created = await this.cover.write(user, async (tx) => {
      const timezone = await schoolTimezone(tx, schoolId);
      const pairs = dedupePairs(dto.lessons);
      await lockLessons(tx, pairs.map((pair) => pair.lessonId));

      const items = await readPairs(tx, pairs, now);
      const lessons = pairs.map((pair) => {
        const item = items.get(pairKey(pair));
        if (!item) {
          throw new NotFoundException({ message: 'Lektionen berörs inte av frånvaron.', code: 'COVER_NOT_AFFECTED', params: { lessonId: pair.lessonId } });
        }
        return item;
      });
      for (const item of lessons) refuseUnaskable(item, now, timezone);

      const recipientIds = [...new Set(dto.recipientIds)];
      const people = await tx.user.findMany({
        where: { id: { in: recipientIds }, role: 'TEACHER', isActive: true },
        select: { id: true, firstName: true, lastName: true },
      });
      const nameOf = new Map(people.map((person) => [person.id, `${person.firstName} ${person.lastName}`.trim()]));
      for (const id of recipientIds) {
        if (!nameOf.has(id)) {
          throw new BadRequestException({
            message: 'recipientIds: bara aktiva lärare i skolan kan få en förfrågan.',
            code: COVER_REQUEST_RECIPIENT_INVALID,
            params: { userId: id },
          });
        }
        if (lessons.some((item) => item.absentTeacherId === id)) {
          throw new BadRequestException({
            message: 'recipientIds: den frånvarande kan inte få förfrågan om sin egen lektion.',
            code: COVER_REQUEST_RECIPIENT_INVALID,
            params: { userId: id },
          });
        }
      }

      // The colleagues the hard rules of cover would not put in front of the
      // class are not asked: the question would only be refused as a yes.
      const breaks = await ruleBreaks(tx, lessons, recipientIds, timezone);
      const firstBreak = breaks[0];
      if (firstBreak) {
        const item = lessons.find((lesson) => lesson.lessonId === firstBreak.lessonId)!;
        throw recipientBreaksRule(
          nameOf.get(firstBreak.userId) ?? '',
          firstBreak.userId,
          swedishWhen(new Date(item.startsAt), timezone),
          firstBreak.lessonId,
          maskFindings(firstBreak.findings, false),
        );
      }

      // A request the nightly job has not yet settled must not stand in the
      // way of a new one for the same lesson.
      await tx.$executeRaw(Prisma.sql`
        UPDATE "CoverRequests" SET "status" = 'EXPIRED'
         WHERE "status" = 'OPEN' AND "expiresAt" <= clock_timestamp()
           AND "id" IN (SELECT l."requestId" FROM "CoverRequestLessons" l
                         WHERE l."open" AND l."calendarLessonId" = ANY(${pairs.map((pair) => pair.lessonId)}::uuid[]))`);
      const taken = await tx.coverRequestLesson.findFirst({
        where: { open: true, OR: pairs.map((pair) => ({ absenceId: pair.absenceId, calendarLessonId: pair.lessonId })) },
        select: { requestId: true, calendarLessonId: true },
      });
      if (taken) throw exists(taken.calendarLessonId);

      const earliest = Math.min(...lessons.map((item) => new Date(item.startsAt).getTime()));
      const wanted = now.getTime() + (dto.expiresInMinutes ?? DEFAULT_EXPIRY_MINUTES) * 60_000;
      const expiresAt = new Date(Math.min(wanted, earliest));

      let request;
      try {
        request = await tx.coverRequest.create({
          data: {
            schoolId,
            requestedByUserId: senderId,
            expiresAt,
            lessons: { create: pairs.map((pair) => ({ schoolId, absenceId: pair.absenceId, calendarLessonId: pair.lessonId })) },
            recipients: { create: recipientIds.map((userId) => ({ schoolId, userId })) },
          },
          select: { id: true },
        });
      } catch (error) {
        // The partial unique index: another administrator asked in the same moment.
        if (sqlStateOf(error) === '23505' || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
          throw exists(pairs[0]!.lessonId);
        }
        throw error;
      }
      return { id: request.id, schoolId, timezone, expiresAt, recipientIds, lessonIds: pairs.map((pair) => pair.lessonId) };
    });

    // Told after the commit, in a transaction of its own: a refused write told nobody.
    await this.prisma
      .withRls(user, async (tx) => {
        await sendRequested(this.notifications, tx, {
          schoolId,
          timezone: created.timezone,
          context: { requestId: created.id, lessonIds: created.lessonIds },
          recipientIds: created.recipientIds,
          expiresAt: created.expiresAt,
        });
      })
      .catch(() => this.logger.warn(`Cover request notices failed after commit [request=${created.id}]`));
    this.broadcast(schoolId, created.lessonIds, user);
    this.logger.log(`Cover request sent [request=${created.id}, lessons=${created.lessonIds.length}, recipients=${created.recipientIds.length}]`);
    return this.viewOf(user, created.id);
  }

  /** The administrator takes the question back. */
  async withdraw(requestId: string, user: AuthenticatedUser): Promise<BoardRequest> {
    const schoolId = requireSchoolId(user);
    const closed = await this.cover.write(user, async (tx) => {
      const timezone = await schoolTimezone(tx, schoolId);
      const request = await lockRequest(tx, requestId, schoolId);
      if (request.status !== 'OPEN') throw ended(request.status);
      const lines = await tx.coverRequestLesson.findMany({ where: { requestId }, select: { calendarLessonId: true } });
      const pending = await tx.coverRequestRecipient.findMany({
        where: { requestId, answer: 'PENDING' },
        select: { userId: true },
      });
      await tx.coverRequest.update({ where: { id: requestId }, data: { status: 'WITHDRAWN' } });
      return { timezone, lessonIds: lines.map((line) => line.calendarLessonId), pending: pending.map((row) => row.userId) };
    });
    await this.prisma
      .withRls(user, async (tx) => {
        await sendClosed(this.notifications, tx, {
          schoolId,
          timezone: closed.timezone,
          context: { requestId, lessonIds: closed.lessonIds },
          recipientIds: closed.pending,
          reason: 'WITHDRAWN',
        });
      })
      .catch(() => this.logger.warn(`Cover request withdrawal notices failed [request=${requestId}]`));
    this.broadcast(schoolId, closed.lessonIds, user);
    this.logger.log(`Cover request withdrawn [request=${requestId}]`);
    return this.viewOf(user, requestId);
  }

  /** Per colleague: how many requests they were sent, said yes and no to, over a period. */
  async fairness(from: string, to: string, user: AuthenticatedUser): Promise<FairnessResponse> {
    const schoolId = requireSchoolId(user);
    checkFairnessWindow(from, to);
    return this.prisma.withRls(user, async (tx) => {
      const timezone = await schoolTimezone(tx, schoolId);
      const createdAt = { gte: dayBounds(from, timezone).start, lt: dayBounds(to, timezone).end };
      const grouped = await tx.coverRequestRecipient.groupBy({
        by: ['userId', 'answer'],
        where: { request: { createdAt } },
        _count: { _all: true },
      });
      const rows = new Map<string, FairnessRow>();
      for (const group of grouped) {
        const row = rows.get(group.userId) ?? { userId: group.userId, received: 0, accepted: 0, declined: 0, unanswered: 0 };
        row.received += group._count._all;
        if (group.answer === 'ACCEPTED') row.accepted += group._count._all;
        else if (group.answer === 'DECLINED') row.declined += group._count._all;
        else row.unanswered += group._count._all;
        rows.set(group.userId, row);
      }
      const sorted = [...rows.values()].sort((a, b) => a.userId.localeCompare(b.userId));
      // How often each was asked and what they answered is work behaviour of
      // named people, read as the cover counter is (EMPLOYMENT).
      await recordRead(tx, 'EMPLOYMENT', sorted.map((row) => row.userId), user.channel);
      return { from, to, rows: sorted };
    });
  }

  // ---------------------------------------------------------------------
  // The colleague asked

  async mine(user: AuthenticatedUser): Promise<MyCoverResponse> {
    requireSchoolId(user);
    const me = user.userId;
    if (!me) throw new BadRequestException('Användar-id saknas.');
    const now = this.cover.now();
    return this.prisma.withRls(user, async (tx) => {
      const since = new Date(now.getTime() - MINE_LOOKBACK_DAYS * 86_400_000);
      const rows = await tx.coverRequest.findMany({
        where: { createdAt: { gte: since }, recipients: { some: { userId: me } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: {
          id: true,
          status: true,
          createdAt: true,
          expiresAt: true,
          acceptedByUserId: true,
          lessons: { select: { calendarLessonId: true } },
          recipients: { where: { userId: me }, select: { answer: true } },
        },
      });
      const passRows = await tx.$queryRaw<{ calendarLessonId: string; confirmedAt: Date | null }[]>(Prisma.sql`
        SELECT "calendarLessonId", "confirmedAt"
          FROM app.cover_my_passes(${now}::timestamptz, ${new Date(now.getTime() + PASSES_AHEAD_DAYS * 86_400_000)}::timestamptz)`);
      const lessonIds = [...new Set([...rows.flatMap((row) => row.lessons.map((line) => line.calendarLessonId)), ...passRows.map((row) => row.calendarLessonId)])];
      const views = await lessonViews(tx, lessonIds);
      const requests: MyCoverRequest[] = rows.map((row) => {
        const lessons = row.lessons
          .map((line) => views.get(line.calendarLessonId))
          .filter((view): view is RequestLessonView => view !== undefined)
          .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.lessonId.localeCompare(b.lessonId));
        return {
          id: row.id,
          state: myStateOf(row, me, now, lessons),
          createdAt: row.createdAt.toISOString(),
          expiresAt: row.expiresAt.toISOString(),
          lessons,
        };
      });
      const passes: MyCoverPass[] = [];
      for (const row of passRows) {
        const view = views.get(row.calendarLessonId);
        if (!view) continue;
        const { cancelled: _cancelled, ...pass } = view;
        void _cancelled;
        passes.push({ ...pass, confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null });
      }
      passes.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.lessonId.localeCompare(b.lessonId));
      return { requests, passes };
    });
  }

  async decline(requestId: string, user: AuthenticatedUser): Promise<{ requestId: string }> {
    const schoolId = requireSchoolId(user);
    const me = user.userId;
    if (!me) throw new BadRequestException('Användar-id saknas.');
    const lessonIds = await this.cover.write(user, async (tx) => {
      const done = await tx.coverRequestRecipient.updateMany({
        where: { requestId, userId: me, answer: 'PENDING' },
        data: { answer: 'DECLINED' },
      });
      if (done.count === 0) {
        const mine = await tx.coverRequestRecipient.findFirst({ where: { requestId, userId: me }, select: { answer: true } });
        if (!mine) throw new NotFoundException({ message: 'Förfrågan finns inte, eller gäller inte dig.', code: 'COVER_REQUEST_NOT_FOUND' });
        throw new ConflictException({ message: 'Du har redan svarat på förfrågan.', code: 'COVER_REQUEST_ANSWERED' });
      }
      // The lessons the question asks for, which the colleague asked reads, so the board can say who has said no.
      const lines = await tx.coverRequestLesson.findMany({ where: { requestId }, select: { calendarLessonId: true } });
      return lines.map((line) => line.calendarLessonId);
    });
    this.broadcast(schoolId, lessonIds, user);
    this.logger.log(`Cover request declined [request=${requestId}]`);
    return { requestId };
  }

  /** The tap on a pass. Idempotent. */
  async confirm(lessonId: string, user: AuthenticatedUser): Promise<{ lessonId: string; confirmed: number }> {
    const schoolId = requireSchoolId(user);
    const confirmed = await mapCoverErrors(async () => {
      try {
        return await this.prisma.withRls(user, async (tx) => {
          const rows = await tx.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT app.cover_confirm(${lessonId}::uuid) AS n`);
          return Number(rows[0]?.n ?? 0);
        });
      } catch (error) {
        if (sqlStateOf(error) === 'CR404') {
          throw new NotFoundException({ message: 'Passet är inte ditt att bekräfta.', code: COVER_PASS_NOT_FOUND });
        }
        throw error;
      }
    });
    await this.prisma
      .withRls(user, async (tx) => {
        const lesson = await tx.calendarLesson.findUnique({ where: { id: lessonId }, select: { date: true } });
        if (lesson) this.realtime.notifyCoverBoardChanged(schoolId, asDay(lesson.date), asDay(lesson.date));
      })
      .catch(() => this.logger.debug(`Cover confirmation broadcast failed [school=${schoolId}]`));
    return { lessonId, confirmed };
  }

  /**
   * THE FIRST YES. See the class comment. Everything between the sender's
   * claims and the commit is one transaction.
   */
  async accept(requestId: string, user: AuthenticatedUser): Promise<{ requestId: string; lessons: number }> {
    const schoolId = requireSchoolId(user);
    const me = user.userId;
    if (!me) throw new BadRequestException('Användar-id saknas.');

    // Who places the vikarie: answered by the database to this colleague alone.
    const sender = await mapCoverErrors(() =>
      this.prisma.withRls(user, async (tx) => {
        const rows = await tx.$queryRaw<{ userId: string; authId: string; adminProfile: AuthenticatedUser['adminProfile'] | null; hrRead: boolean }[]>(
          Prisma.sql`SELECT "userId", "authId", "adminProfile", "hrRead" FROM app.cover_request_sender(${requestId}::uuid)`,
        );
        return rows[0];
      }),
    );
    if (!sender) {
      throw new ConflictException({
        message: 'Den som skickade förfrågan kan inte längre tillsätta uppdraget. Hör av dig till expeditionen.',
        code: 'COVER_REQUEST_SENDER_GONE',
      });
    }
    const principal: AuthenticatedUser = {
      authId: sender.authId,
      role: Role.SCHOOL_ADMIN,
      userId: sender.userId,
      schoolId,
      ...(sender.adminProfile ? { adminProfile: sender.adminProfile, hrRead: sender.hrRead } : {}),
      ...(user.closedSchools ? { closedSchools: user.closedSchools } : {}),
      ...(user.channel ? { channel: user.channel } : {}),
    };

    const outcome = await this.cover.write(principal, (tx) => this.acceptInTransaction(tx, principal, requestId, me));
    await this.cover.afterCommit(principal, outcome.effects);
    await this.tellAfterAccept(principal, outcome);
    this.logger.log(`Cover request accepted [request=${requestId}, lessons=${outcome.lessonIds.length}]`);
    return { requestId, lessons: outcome.lessonIds.length };
  }

  private async acceptInTransaction(
    tx: PrismaClient,
    principal: AuthenticatedUser,
    requestId: string,
    teacherId: string,
  ): Promise<AcceptOutcome> {
    const schoolId = requireSchoolId(principal);
    await enterGrundschemaWrite(tx, schoolId);
    // A request's lessons never change once it is sent, so they can be read
    // before any lock; they are locked, in id order, FIRST, as the board
    // locks them in every write (decide, bulk, apply): a decision on one of
    // them ends the request by trigger and so takes its row, and a yes that
    // took the request's row before the lessons' would meet that decision
    // crossways and one of the two would be a deadlock's victim.
    const lines = await tx.coverRequestLesson.findMany({
      where: { requestId },
      select: { absenceId: true, calendarLessonId: true },
      orderBy: [{ calendarLessonId: 'asc' }, { absenceId: 'asc' }],
    });
    if (lines.length === 0) throw gone();
    const pairs = lines.map((line) => ({ absenceId: line.absenceId, lessonId: line.calendarLessonId }));
    await lockLessons(tx, pairs.map((pair) => pair.lessonId));
    // THE LOCK THAT MAKES THE FIRST YES THE ONLY ONE: any number of colleagues
    // answering together queue here, on the one request, and the first through
    // ends it.
    const request = await lockRequest(tx, requestId, schoolId);
    if (request.status === 'ACCEPTED') throw taken();
    if (request.status !== 'OPEN' || request.expiresAt.getTime() <= request.now.getTime()) throw gone();
    if (request.requestedByUserId !== principal.userId) throw senderGone();

    const mine = await tx.coverRequestRecipient.findFirst({
      where: { requestId, userId: teacherId },
      select: { answer: true },
    });
    if (!mine) throw new NotFoundException({ message: 'Förfrågan finns inte, eller gäller inte dig.', code: 'COVER_REQUEST_NOT_FOUND' });
    if (mine.answer !== 'PENDING') {
      throw new ConflictException({ message: 'Du har redan svarat på förfrågan.', code: 'COVER_REQUEST_ANSWERED' });
    }
    await lockTeachers(tx, [teacherId]);

    const now = this.cover.now();
    const timezone = await schoolTimezone(tx, schoolId);
    const items = await readPairs(tx, pairs, now);
    const lessons: BoardItem[] = [];
    for (const pair of pairs) {
      const item = items.get(pairKey(pair));
      if (!item) throw gone();
      if (item.lessonStatus === 'CANCELLED') throw cancelled(item.lessonId);
      if (item.status !== 'OPEN') throw covered(item.lessonId);
      lessons.push(item);
    }

    // The yes is judged by the rules of cover as the question was.
    const breaks = await ruleBreaks(tx, lessons, [teacherId], timezone);
    const broken = breaks[0];
    if (broken) {
      const item = lessons.find((lesson) => lesson.lessonId === broken.lessonId)!;
      throw ownYesBreaksRule(swedishWhen(new Date(item.startsAt), timezone), broken.lessonId, maskFindings(broken.findings, false));
    }

    // Claim first, so the decisions below find the request ended and leave it be.
    await tx.coverRequest.update({ where: { id: requestId }, data: { status: 'ACCEPTED', acceptedByUserId: teacherId } });
    await tx.coverRequestRecipient.update({
      where: { requestId_userId: { requestId, userId: teacherId } },
      data: { answer: 'ACCEPTED' },
    });

    const effects = emptyEffects();
    for (const pair of pairs) {
      try {
        merge(
          effects,
          await this.cover.decideInTransaction(
            tx,
            { lessonId: pair.lessonId, absenceId: pair.absenceId, kind: 'SUBSTITUTE', substituteId: teacherId, expected: 'OPEN' },
            principal,
          ),
        );
      } catch (error) {
        if (error instanceof HttpException && (error.getResponse() as { code?: string }).code === 'COVER_STALE') {
          throw naming(covered(pair.lessonId), pair.lessonId);
        }
        throw naming(error, pair.lessonId);
      }
    }
    // A yes is the vikarie's confirmation: they need not tap the pass they asked for.
    await tx.coverConfirmation.createMany({
      data: pairs.map((pair) => ({ schoolId, absenceId: pair.absenceId, calendarLessonId: pair.lessonId, userId: teacherId })),
    });

    const others = await tx.coverRequestRecipient.findMany({
      where: { requestId, answer: 'PENDING', userId: { not: teacherId } },
      select: { userId: true },
    });
    return {
      effects,
      schoolId,
      requestId,
      senderId: principal.userId!,
      acceptedById: teacherId,
      lessonIds: pairs.map((pair) => pair.lessonId),
      others: others.map((row) => row.userId),
    };
  }

  /** After the commit: the sender is told who took it, and the others that it is taken. */
  private async tellAfterAccept(principal: AuthenticatedUser, outcome: AcceptOutcome): Promise<void> {
    await this.prisma
      .withRls(principal, async (tx) => {
        const timezone = await schoolTimezone(tx, outcome.schoolId);
        const context: RequestNoticeContext = { requestId: outcome.requestId, lessonIds: outcome.lessonIds };
        const person = await tx.user.findUnique({ where: { id: outcome.acceptedById }, select: { firstName: true, lastName: true } });
        await sendAccepted(this.notifications, tx, {
          schoolId: outcome.schoolId,
          timezone,
          context,
          senderId: outcome.senderId,
          acceptedByName: person ? `${person.firstName} ${person.lastName}`.trim() : '',
        });
        await sendClosed(this.notifications, tx, {
          schoolId: outcome.schoolId,
          timezone,
          context,
          recipientIds: outcome.others,
          reason: 'TAKEN',
        });
      })
      .catch(() => this.logger.warn(`Cover request notices failed after accept [request=${outcome.requestId}]`));
  }

  /** The nightly job: the open requests whose time is out. */
  async expire(): Promise<number> {
    const rows = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT app.cover_requests_expire() AS n`),
    );
    return Number(rows[0]?.n ?? 0);
  }

  // ---------------------------------------------------------------------

  private async viewOf(user: AuthenticatedUser, requestId: string): Promise<BoardRequest> {
    const now = this.cover.now();
    return this.prisma.withRls(user, async (tx) => {
      const row = await tx.coverRequest.findUnique({ where: { id: requestId }, select: requestSelect });
      if (!row) throw new NotFoundException({ message: 'Förfrågan finns inte.', code: 'COVER_REQUEST_NOT_FOUND' });
      return toBoardRequest(row, now);
    });
  }

  private broadcast(schoolId: string, lessonIds: readonly string[], user: AuthenticatedUser): void {
    this.prisma
      .withRls(user, async (tx) => {
        const dates = (await tx.calendarLesson.findMany({ where: { id: { in: [...lessonIds] } }, select: { date: true } })).map((row) => asDay(row.date)).sort();
        if (dates.length > 0) this.realtime.notifyCoverBoardChanged(schoolId, dates[0]!, dates[dates.length - 1]!);
      })
      .catch(() => this.logger.debug(`Cover request broadcast failed [school=${schoolId}]`));
  }
}

// -------------------------------------------------------------------------
// Reads and rules

/** What the colleague can do with the request now, from their own side. */
export function myStateOf(
  row: { status: CoverRequestStatus; expiresAt: Date; acceptedByUserId: string | null; recipients: { answer: CoverRecipientAnswer }[]; lessons: unknown[] },
  me: string,
  now: Date,
  lessons: readonly RequestLessonView[],
): MyRequestState {
  const answer = row.recipients[0]?.answer;
  if (row.status === 'ACCEPTED') return row.acceptedByUserId === me ? 'ACCEPTED_BY_ME' : 'TAKEN';
  if (row.status === 'WITHDRAWN') return 'WITHDRAWN';
  if (row.status === 'EXPIRED') return 'EXPIRED';
  if (row.status === 'CLOSED') return 'CLOSED';
  if (row.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  if (lessons.length === 0 || lessons.some((lesson) => lesson.cancelled)) return 'CLOSED';
  return answer === 'DECLINED' ? 'DECLINED_BY_ME' : 'OPEN';
}

async function lessonViews(tx: PrismaClient, ids: readonly string[]): Promise<Map<string, RequestLessonView>> {
  if (ids.length === 0) return new Map();
  const lessons = await tx.calendarLesson.findMany({
    where: { id: { in: [...ids] } },
    select: { id: true, date: true, startsAt: true, endsAt: true, status: true, subjectId: true, studentGroupId: true, roomId: true },
  });
  const [subjects, groups, rooms] = await Promise.all([
    tx.subject.findMany({ where: { id: { in: lessons.map((l) => l.subjectId) } }, select: { id: true, name: true } }),
    tx.studentGroup.findMany({ where: { id: { in: lessons.map((l) => l.studentGroupId) } }, select: { id: true, name: true } }),
    tx.room.findMany({ where: { id: { in: lessons.flatMap((l) => (l.roomId ? [l.roomId] : [])) } }, select: { id: true, name: true } }),
  ]);
  const name = (rows: { id: string; name: string }[]) => new Map(rows.map((row) => [row.id, row.name]));
  const subjectName = name(subjects);
  const groupName = name(groups);
  const roomName = name(rooms);
  return new Map(
    lessons.map((lesson) => [
      lesson.id,
      {
        lessonId: lesson.id,
        date: asDay(lesson.date),
        startsAt: lesson.startsAt.toISOString(),
        endsAt: lesson.endsAt.toISOString(),
        subjectName: subjectName.get(lesson.subjectId) ?? '',
        groupName: groupName.get(lesson.studentGroupId) ?? '',
        roomName: lesson.roomId ? (roomName.get(lesson.roomId) ?? null) : null,
        cancelled: lesson.status === 'CANCELLED',
      },
    ]),
  );
}

interface Pair {
  absenceId: string;
  lessonId: string;
}

const pairKey = (pair: Pair) => `${pair.absenceId}:${pair.lessonId}`;

function dedupePairs(pairs: readonly Pair[]): Pair[] {
  return [...new Map(pairs.map((pair) => [pairKey(pair), { absenceId: pair.absenceId, lessonId: pair.lessonId }])).values()].sort(
    (a, b) => a.lessonId.localeCompare(b.lessonId) || a.absenceId.localeCompare(b.absenceId),
  );
}

/** The board's own reading of the pairs (cover-board.ts), keyed by absence and lesson. */
async function readPairs(tx: PrismaClient, pairs: readonly Pair[], now: Date): Promise<Map<string, BoardItem>> {
  const rows = (await tx.$queryRaw<PairRow[]>(pairsStatement({ kind: 'absences', ids: [...new Set(pairs.map((pair) => pair.absenceId))] }))) ?? [];
  const wanted = new Set(pairs.map(pairKey));
  const items = new Map<string, BoardItem>();
  for (const row of rows) {
    const item = toBoardItem(row, now);
    const key = pairKey({ absenceId: item.absenceId, lessonId: item.lessonId });
    if (wanted.has(key)) items.set(key, item);
  }
  return items;
}

/** A lesson nobody can be asked to cover, by name. */
function refuseUnaskable(item: BoardItem, now: Date, timezone: string): void {
  if (item.lessonStatus === 'CANCELLED') throw cancelled(item.lessonId);
  if (item.status !== 'OPEN') throw covered(item.lessonId);
  const starts = new Date(item.startsAt).getTime();
  if (starts - now.getTime() < MIN_ANSWER_MS) {
    throw new ConflictException({
      message: `Lektionen ${swedishWhen(new Date(item.startsAt), timezone)} har redan börjat eller börjar inom en minut. Tillsätt en vikarie direkt på tavlan.`,
      code: COVER_REQUEST_LESSON_STARTED,
      params: { lessonId: item.lessonId },
    });
  }
}

/** Every (colleague, lesson) the hard rules of cover refuse, the first of each colleague, in lesson order. */
async function ruleBreaks(
  tx: PrismaClient,
  lessons: readonly BoardItem[],
  userIds: readonly string[],
  timezone: string,
): Promise<{ userId: string; lessonId: string; findings: RuleFinding[] }[]> {
  const out: { userId: string; lessonId: string; findings: RuleFinding[] }[] = [];
  const byDate = new Map<string, BoardItem[]>();
  for (const item of lessons) byDate.set(item.date, [...(byDate.get(item.date) ?? []), item]);
  const refused = new Set<string>();
  for (const date of [...byDate.keys()].sort()) {
    const dayItems = byDate.get(date)!.sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.lessonId.localeCompare(b.lessonId));
    const year = await tx.academicYear.findFirst({
      where: { studentGroups: { some: { id: dayItems[0]!.studentGroupId } } },
      select: { id: true },
    });
    const read = await readPersonDays(tx, { date, timezone, academicYearId: year?.id ?? null, userIds });
    for (const userId of [...userIds].sort()) {
      if (refused.has(userId)) continue;
      const day = read.days.get(userId);
      if (!day) {
        out.push({ userId, lessonId: dayItems[0]!.lessonId, findings: [{ code: 'INACTIVE', params: {} }] });
        refused.add(userId);
        continue;
      }
      // The earlier lessons of the same request count as given, so a colleague
      // asked for three in a row is judged on the day those three make.
      const given: PersonLesson[] = [];
      for (const item of dayItems) {
        const target: CoverTarget = {
          id: item.lessonId,
          date,
          start: new Date(item.startsAt).getTime(),
          end: new Date(item.endsAt).getTime(),
          teacherIds: item.teachers.map((teacher) => teacher.teacherId),
          roomId: item.roomId,
        };
        const findings = hardFindings(day, target, given);
        if (findings.length > 0) {
          out.push({ userId, lessonId: item.lessonId, findings });
          refused.add(userId);
          break;
        }
        given.push({
          id: target.id,
          date: target.date,
          start: target.start,
          end: target.end,
          status: 'SCHEDULED',
          studentGroupId: '',
          subjectId: '',
          roomId: target.roomId ?? null,
        });
      }
    }
  }
  return out;
}

/** The request row, locked: any number of answers queue here. */
async function lockRequest(tx: PrismaClient, requestId: string, schoolId: string): Promise<LockedRequest> {
  const rows = await tx.$queryRaw<LockedRequest[]>(Prisma.sql`
    SELECT "id", "schoolId", "status", "expiresAt", "requestedByUserId", clock_timestamp() AS "now"
      FROM "CoverRequests"
     WHERE "id" = ${requestId}::uuid AND "schoolId" = ${schoolId}::uuid
       FOR UPDATE`);
  const row = rows[0];
  if (!row) throw new NotFoundException({ message: 'Förfrågan finns inte.', code: 'COVER_REQUEST_NOT_FOUND' });
  return row;
}

export function checkFairnessWindow(from: string, to: string): void {
  checkWindow(from, to, FAIRNESS_DAYS);
}

// -------------------------------------------------------------------------
// The refusals

function cancelled(lessonId: string): ConflictException {
  return new ConflictException({
    message: 'Lektionen är inställd och hålls inte, så ingen vikarie behövs.',
    code: COVER_REQUEST_LESSON_CANCELLED,
    params: { lessonId },
  });
}

function covered(lessonId: string): ConflictException {
  return new ConflictException({
    message: 'Lektionen har redan en vikarie eller är hanterad på annat sätt.',
    code: COVER_REQUEST_LESSON_COVERED,
    params: { lessonId },
  });
}

function exists(lessonId: string): ConflictException {
  return new ConflictException({
    message: 'Det finns redan en öppen förfrågan för lektionen. Dra tillbaka den först.',
    code: COVER_REQUEST_EXISTS,
    params: { lessonId },
  });
}

function ended(current: CoverRequestStatus): ConflictException {
  return new ConflictException({
    message: 'Förfrågan är redan avslutad.',
    code: COVER_REQUEST_ENDED,
    params: { current },
  });
}

function taken(): ConflictException {
  return new ConflictException({
    message: 'Uppdraget är redan tillsatt: en kollega hann tacka ja före dig.',
    code: 'COVER_REQUEST_TAKEN',
  });
}

function gone(): ConflictException {
  return new ConflictException({
    message: 'Förfrågan är avslutad: den har gått ut, dragits tillbaka eller tillsatts på annat sätt.',
    code: 'COVER_REQUEST_GONE',
  });
}

function senderGone(): ConflictException {
  return new ConflictException({
    message: 'Den som skickade förfrågan kan inte längre tillsätta uppdraget. Hör av dig till expeditionen.',
    code: 'COVER_REQUEST_SENDER_GONE',
  });
}
