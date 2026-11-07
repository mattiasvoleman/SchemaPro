import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, type AckReminderOutcome, type PrismaClient } from '@prisma/client';
import { recordRead } from '../access-log/access-log';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { requireSchoolId, requireUserId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';
import { errorName } from '../jobs/job-runner';
import { NotificationsService } from '../notifications/notifications.service';
import {
  ACK_CUSTODY_ENDED,
  ACK_DISABLED,
  ACK_NO_GUARDIANS,
  ACK_NOT_A_GUARDIAN,
  ACK_NOT_FOUND,
  ACK_NOT_STAFF,
  ACK_NOT_YOUR_PUPIL,
  ACK_PASS_BUDGET_MS,
  ACK_QUEUE_LIMIT,
  ACK_SENDER_DAY_LIMIT,
  ACK_TOO_MANY_RECIPIENTS,
  ACK_TOO_MANY_REQUESTS,
  ACK_UNKNOWN_PUPIL,
  PAGE_DEFAULT,
  USAGE_SENDERS,
} from './ack';
import { requestedEntries, type ReminderRow, reminderEntries } from './ack-notices';
import type {
  AckConfirmed,
  AckCreated,
  AckDetail,
  AckGuardianRow,
  AckListItem,
  AckMine,
  AckPage,
  AckPupilChoice,
  AckPupilRow,
  AckReminderState,
  AckReminderStopped,
  AckSettingsView,
  AckUsage,
} from './ack-views';
import type { AckPageQueryDto, AckSettingsDto, CreateAckRequestDto } from './dto/ack.dto';

/** The database's rows of app.ack_status. */
interface StatusRow {
  request_id: string;
  student_id: string;
  asked: number;
  acked: number;
  waiting: number;
  met: boolean;
}

const RECEIPT_CHUNK = 1000;
const fullName = (person: { firstName: string; lastName: string }) => `${person.firstName} ${person.lastName}`;

/**
 * Where a request's one reminder stands, from what the row says. SENT is only said when the delivery has also said
 * that the e-mail and the push were taken (reminderMirroredAt); until it has, and for good if the process stopped with
 * them in its queue, it is WRITTEN: in the inboxes, and nothing more is known.
 */
function reminderOf(request: { remindAt: Date | null; reminderOutcome: AckReminderOutcome | null; reminderMirroredAt: Date | null }): AckReminderState {
  if (request.reminderOutcome === 'SENT' && !request.reminderMirroredAt) return 'WRITTEN';
  if (request.reminderOutcome) return request.reminderOutcome;
  return request.remindAt ? 'SCHEDULED' : 'NONE';
}

/** A page from one row more than was asked for: the rows to show, and the id to continue after when there are more. */
function pageOf<T extends { id: string }>(rows: T[], limit: number): { rows: T[]; next: string | null } {
  const shown = rows.slice(0, limit);
  return { rows: shown, next: rows.length > limit ? shown[shown.length - 1]!.id : null };
}

/**
 * The SQLSTATE a function or trigger of the migration raised, as the adapter reports it: a raw refusal is P2010 with the
 * code in driverAdapterError.cause, and the same text is in the message. A model query that a trigger refuses
 * (createMany of the request and its receipts) may come back in another class, so the codes of the two limits are also
 * read from the message the trigger raised.
 */
function sqlStateOf(error: unknown): string | null {
  const meta = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } } } | null)?.meta;
  const cause = meta?.driverAdapterError?.cause;
  if (typeof cause?.originalCode === 'string') return cause.originalCode;
  const message = error instanceof Error ? error.message : '';
  const named = /Code: `([0-9A-Z]{5})`/.exec(message)?.[1];
  if (named) return named;
  if (message.includes('ACK_TOO_MANY_REQUESTS')) return 'KV429';
  if (message.includes('ACK_SENDER_DAY_LIMIT')) return 'KV427';
  if (message.includes('ACK_TOO_MANY_RECIPIENTS')) return 'KV428';
  return null;
}

/**
 * Kvittens (F4): the staff's requests for a guardian's confirmation, the
 * guardian's own list and button, and the school's two choices.
 *
 * WHO IS DONE is never decided here: app.ack_status answers per request and
 * pupil (ANY: someone confirmed; ALL: someone confirmed and nobody who still
 * can is waiting), and app.ack_open_pairs says which guardians still can. A
 * guardian whose custody has ended is "ENDED": the request is no longer theirs
 * and they cannot confirm it (KV410), and they do not hold up an ALL request.
 *
 * WHAT A SENDER MAY SEND is limited by the database (10 requests an hour for a
 * person, a share of the day for a person, 20 000 receipts a day for a school:
 * KV429, KV427 and KV428, here a 429), and the route is throttled besides.
 * The shares and the school's use are read by usage(). THE REMINDER is worked through a request at a
 * time, each in a transaction of its own (see remind).
 *
 * WHAT IS READ AND RECORDED. A staff member opening a request reads pupils'
 * and guardians' names and who is whose guardian, and it is recorded (PEOPLE
 * and GUARDIANS). So is the list of pupils a request can be about. The list of
 * requests names nobody and is not. A guardian reading their own request, and
 * confirming it, reads what the school wrote to them and is not recorded.
 * Nobody but the guardian and the staff above sees a guardian's confirmation,
 * and the other guardian never does: no arm gives them each other's rows.
 */
@Injectable()
export class AckService {
  private readonly logger = new Logger(AckService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  // -------------------------------------------------------------------
  // Settings

  async settings(user: AuthenticatedUser): Promise<AckSettingsView> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      if (user.role === Role.SCHOOL_ADMIN) {
        const row = await tx.ackSetting.findUnique({ where: { schoolId } });
        return { enabled: row?.enabled ?? false, remindAfterDays: row ? row.remindAfterDays : 2 };
      }
      const [row] = await tx.$queryRaw<Array<{ enabled: boolean; days: number | null }>>`
        SELECT app.ack_enabled() AS "enabled", app.ack_remind_after_days() AS "days"`;
      return { enabled: row?.enabled ?? false, remindAfterDays: row?.days ?? null };
    });
  }

  async updateSettings(dto: AckSettingsDto, user: AuthenticatedUser): Promise<AckSettingsView> {
    const schoolId = requireSchoolId(user);
    const data = {
      ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      ...(dto.remindAfterDays !== undefined ? { remindAfterDays: dto.remindAfterDays } : {}),
    };
    await this.prisma.withRls(user, async (tx) => {
      await tx.ackSetting.upsert({ where: { schoolId }, create: { schoolId, ...data }, update: data });
    });
    return this.settings(user);
  }

  // -------------------------------------------------------------------
  // The pupils a request can be about

  /** An administrator's every active pupil, a teacher's mentees; with how many guardians could be asked. */
  async pupils(user: AuthenticatedUser): Promise<AckPupilChoice[]> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const mentees = user.role === Role.TEACHER ? await this.menteesOf(tx) : null;
      if (mentees?.length === 0) return [];
      const pupils = await tx.user.findMany({
        where: { schoolId, role: 'STUDENT', isActive: true, ...(mentees ? { id: { in: mentees } } : {}) },
        select: { id: true, firstName: true, lastName: true, studentGroup: { select: { name: true } } },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
      });
      const links = await tx.guardianStudent.findMany({
        where: { studentId: { in: pupils.map((pupil) => pupil.id) }, guardian: { isActive: true, role: 'GUARDIAN' } },
        select: { studentId: true },
      });
      const guardians = new Map<string, number>();
      for (const link of links) guardians.set(link.studentId, (guardians.get(link.studentId) ?? 0) + 1);
      await recordRead(tx, 'PEOPLE', pupils.map((pupil) => pupil.id), user.channel);
      return pupils.map((pupil) => ({
        id: pupil.id,
        name: fullName(pupil),
        className: pupil.studentGroup?.name ?? null,
        guardians: guardians.get(pupil.id) ?? 0,
      }));
    });
  }

  // -------------------------------------------------------------------
  // Writing a request

  /**
   * Writes the request, a receipt for each guardian of each pupil, and the
   * guardians' notices, in one transaction. A teacher may ask only about their
   * mentees, an administrator about any pupil; the database says the same
   * (the arms of AckReceipts), so this answers first with a code.
   */
  async create(dto: CreateAckRequestDto, user: AuthenticatedUser): Promise<AckCreated> {
    try {
      return await this.write(dto, user);
    } catch (error) {
      switch (sqlStateOf(error)) {
        case 'KV429':
          throw new HttpException(
            { code: ACK_TOO_MANY_REQUESTS, message: 'Du har skickat tio meddelanden den senaste timmen. Vänta en stund och försök igen.' },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        case 'KV427':
          throw new HttpException(
            {
              code: ACK_SENDER_DAY_LIMIT,
              message: 'Du har bett om kvittens från så många vårdnadshavare det senaste dygnet att den här förfrågan skulle gå över din andel av dagen. Inget har skickats. Välj färre elever eller försök igen senare. Måste förfrågan gå ut nu kan en annan administratör skicka den, eftersom var och en har en egen andel.',
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        case 'KV428':
          throw new HttpException(
            { code: ACK_TOO_MANY_RECIPIENTS, message: 'Skolan har bett om kvittens från för många vårdnadshavare det senaste dygnet. Försök igen i morgon.' },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        default:
          throw error;
      }
    }
  }

  private async write(dto: CreateAckRequestDto, user: AuthenticatedUser): Promise<AckCreated> {
    const schoolId = requireSchoolId(user);
    const authorId = requireUserId(user);
    const studentIds = [...new Set(dto.studentIds)];
    return this.prisma.withRls(user, async (tx) => {
      const [{ enabled }] = await tx.$queryRaw<Array<{ enabled: boolean }>>`SELECT app.ack_enabled() AS "enabled"`;
      if (!enabled) throw new ConflictException({ code: ACK_DISABLED, message: 'Skolan har inte slagit på kvittens.' });

      const pupils = await tx.user.findMany({
        where: { id: { in: studentIds }, schoolId, role: 'STUDENT', isActive: true },
        select: { id: true },
      });
      if (pupils.length !== studentIds.length) {
        throw new UnprocessableEntityException({ code: ACK_UNKNOWN_PUPIL, message: 'En av eleverna finns inte i skolan, eller har slutat.' });
      }
      if (user.role === Role.TEACHER) {
        const mentees = new Set(await this.menteesOf(tx));
        if (studentIds.some((id) => !mentees.has(id))) {
          throw new ForbiddenException({ code: ACK_NOT_YOUR_PUPIL, message: 'Du kan bara be om kvittens om elever du är mentor för.' });
        }
      }

      const links = await tx.guardianStudent.findMany({
        where: { studentId: { in: studentIds }, guardian: { isActive: true, role: 'GUARDIAN' } },
        select: { studentId: true, guardianId: true },
      });
      const asked = new Set(links.map((link) => link.studentId));
      const withoutGuardian = studentIds.filter((id) => !asked.has(id));
      if (links.length === 0) {
        throw new UnprocessableEntityException({ code: ACK_NO_GUARDIANS, message: 'Ingen av eleverna har en vårdnadshavare att fråga.' });
      }

      const id = randomUUID();
      // createMany, not create: an INSERT … RETURNING asks the SELECT arms, and the
      // receipts below are not read back either.
      await tx.ackRequest.createMany({
        data: [{ id, schoolId, authorId, title: dto.title, body: dto.body, rule: dto.rule }],
      });
      for (let at = 0; at < links.length; at += RECEIPT_CHUNK) {
        await tx.ackReceipt.createMany({
          data: links.slice(at, at + RECEIPT_CHUNK).map((link) => ({ requestId: id, schoolId, studentId: link.studentId, guardianId: link.guardianId })),
        });
      }

      const guardianIds = [...new Set(links.map((link) => link.guardianId))];
      const entry = requestedEntries(id, dto.title);
      await this.notifications.notifyUsers(tx, { schoolId, userIds: guardianIds, type: 'ACK_REQUESTED', meta: entry.meta, email: entry.email });
      return { id, pupils: asked.size, guardians: guardianIds.length, withoutGuardian };
    });
  }

  // -------------------------------------------------------------------
  // Reading: the staff's list and a request

  /** A page of the requests the caller may see, newest first, with counts and no names. */
  async list(user: AuthenticatedUser, query: AckPageQueryDto = {}): Promise<AckPage<AckListItem>> {
    requireSchoolId(user);
    const limit = query.limit ?? PAGE_DEFAULT;
    return this.prisma.withRls(user, async (tx) => {
      const found = await tx.ackRequest.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(query.after ? { cursor: { id: query.after }, skip: 1 } : {}),
        select: { id: true, title: true, rule: true, authorName: true, createdAt: true, remindAt: true, reminderOutcome: true, reminderMirroredAt: true },
      });
      const { rows: requests, next } = pageOf(found, limit);
      const status = await this.statusOf(tx, requests.map((request) => request.id));
      const byRequest = new Map<string, StatusRow[]>();
      for (const row of status) byRequest.set(row.request_id, [...(byRequest.get(row.request_id) ?? []), row]);
      return {
        items: requests.map((request) => {
          const rows = byRequest.get(request.id) ?? [];
          return {
            id: request.id,
            title: request.title,
            rule: request.rule,
            authorName: request.authorName,
            createdAt: request.createdAt.toISOString(),
            pupils: rows.length,
            met: rows.filter((row) => row.met).length,
            waiting: rows.reduce((sum, row) => sum + row.waiting, 0),
            remindAt: request.remindAt?.toISOString() ?? null,
            reminder: reminderOf(request),
          };
        }),
        next,
      };
    });
  }

  /** One request with who confirmed and when, for the pupils the caller may see. Recorded in the read log. */
  async detail(id: string, user: AuthenticatedUser): Promise<AckDetail> {
    requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const request = await tx.ackRequest.findUnique({
        where: { id },
        select: {
          id: true,
          authorId: true,
          title: true,
          body: true,
          rule: true,
          authorName: true,
          createdAt: true,
          remindAt: true,
          reminderSentAt: true,
          reminderOutcome: true,
          reminderMirroredAt: true,
        },
      });
      if (!request) throw this.notFound();
      const reminder = reminderOf(request);
      const [status, open, receipts] = await Promise.all([
        this.statusOf(tx, [id]),
        tx.$queryRaw<Array<{ student_id: string; guardian_id: string }>>`SELECT * FROM app.ack_open_pairs(${id}::uuid)`,
        tx.ackReceipt.findMany({
          where: { requestId: id },
          select: {
            studentId: true,
            guardianId: true,
            ackedAt: true,
            remindedAt: true,
            student: { select: { firstName: true, lastName: true, studentGroup: { select: { name: true } } } },
            guardian: { select: { firstName: true, lastName: true } },
          },
        }),
      ]);
      const stillOpen = new Set(open.map((pair) => `${pair.student_id}|${pair.guardian_id}`));
      const met = new Map(status.map((row) => [row.student_id, row.met]));
      const pupils = new Map<string, AckPupilRow>();
      for (const receipt of receipts) {
        const pupil =
          pupils.get(receipt.studentId) ??
          {
            id: receipt.studentId,
            name: fullName(receipt.student),
            className: receipt.student.studentGroup?.name ?? null,
            met: met.get(receipt.studentId) ?? false,
            guardians: [] as AckGuardianRow[],
          };
        pupils.set(receipt.studentId, pupil);
        pupil.guardians.push({
          id: receipt.guardianId,
          name: fullName(receipt.guardian),
          state: receipt.ackedAt ? 'CONFIRMED' : stillOpen.has(`${receipt.studentId}|${receipt.guardianId}`) ? 'WAITING' : 'ENDED',
          ackedAt: receipt.ackedAt?.toISOString() ?? null,
          remindedAt: receipt.remindedAt?.toISOString() ?? null,
        });
      }
      const shown = [...pupils.values()].sort((a, b) => a.name.localeCompare(b.name, 'sv'));
      await recordRead(tx, 'PEOPLE', [...new Set(receipts.flatMap((receipt) => [receipt.studentId, receipt.guardianId]))], user.channel);
      await recordRead(tx, 'GUARDIANS', shown.map((pupil) => pupil.id), user.channel);
      return {
        id: request.id,
        title: request.title,
        body: request.body,
        rule: request.rule,
        authorName: request.authorName,
        createdAt: request.createdAt.toISOString(),
        remindAt: request.remindAt?.toISOString() ?? null,
        reminderSentAt: request.reminderSentAt?.toISOString() ?? null,
        reminderMirroredAt: request.reminderMirroredAt?.toISOString() ?? null,
        reminder,
        mayStopReminder: reminder === 'SCHEDULED' && (await this.mayStop(tx, user, request.authorId)),
        pupils: shown,
      };
    });
  }

  // -------------------------------------------------------------------
  // The guardian

  /** A page of the guardian's own requests, newest first: the children they are still linked to, and their own confirmation. */
  async mine(user: AuthenticatedUser, query: AckPageQueryDto = {}): Promise<AckPage<AckMine>> {
    requireSchoolId(user);
    const limit = query.limit ?? PAGE_DEFAULT;
    return this.prisma.withRls(user, async (tx) => {
      const found = await tx.ackRequest.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(query.after ? { cursor: { id: query.after }, skip: 1 } : {}),
        select: {
          id: true,
          title: true,
          body: true,
          rule: true,
          authorName: true,
          createdAt: true,
          receipts: { select: { studentId: true, ackedAt: true, student: { select: { firstName: true, lastName: true } } } },
        },
      });
      const { rows: requests, next } = pageOf(found, limit);
      return {
        items: requests.flatMap((request) => {
          if (request.receipts.length === 0) return [];
          const confirmed = request.receipts.every((receipt) => receipt.ackedAt !== null);
          const at = confirmed ? request.receipts.map((receipt) => receipt.ackedAt!.getTime()).reduce((a, b) => Math.min(a, b)) : null;
          return [
            {
              id: request.id,
              title: request.title,
              body: request.body,
              rule: request.rule,
              authorName: request.authorName,
              createdAt: request.createdAt.toISOString(),
              children: request.receipts.map((receipt) => ({ id: receipt.studentId, name: fullName(receipt.student) })),
              ackedAt: at === null ? null : new Date(at).toISOString(),
            },
          ];
        }),
        next,
      };
    });
  }

  /** The guardian confirms; a second tap answers the time of the first. */
  async confirm(id: string, user: AuthenticatedUser): Promise<AckConfirmed> {
    requireSchoolId(user);
    try {
      const at = await this.prisma.withRls(user, async (tx) => {
        const [row] = await tx.$queryRaw<Array<{ at: Date }>>`SELECT app.ack_confirm(${id}::uuid) AS "at"`;
        return row!.at;
      });
      return { ackedAt: at.toISOString() };
    } catch (error) {
      switch (sqlStateOf(error)) {
        case 'KV403':
          throw new ForbiddenException({ code: ACK_NOT_A_GUARDIAN, message: 'Bara en vårdnadshavare bekräftar.' });
        case 'KV404':
          throw this.notFound();
        case 'KV410':
          throw new ConflictException({ code: ACK_CUSTODY_ENDED, message: 'Du är inte längre vårdnadshavare för barnet i meddelandet.' });
        default:
          throw error;
      }
    }
  }

  // -------------------------------------------------------------------
  // Stopping a reminder

  /**
   * The author, or an administrator under Drift, stops a request's reminder
   * (a request that went out wrong). The answer is where the reminder stands
   * afterwards: STOPPED, or whatever it had already come to.
   */
  async stopReminder(id: string, user: AuthenticatedUser): Promise<AckReminderStopped> {
    requireSchoolId(user);
    try {
      const outcome = await this.prisma.withRls(user, async (tx) => {
        const [row] = await tx.$queryRaw<Array<{ outcome: AckReminderOutcome | null }>>`SELECT app.ack_stop_reminder(${id}::uuid) AS "outcome"`;
        return row?.outcome ?? null;
      });
      return { reminder: outcome ?? 'NONE' };
    } catch (error) {
      switch (sqlStateOf(error)) {
        case 'KV403':
          throw new ForbiddenException({ code: ACK_NOT_STAFF, message: 'Bara den som skrev meddelandet, eller en administratör, kan stoppa påminnelsen.' });
        case 'KV404':
          throw this.notFound();
        default:
          throw error;
      }
    }
  }

  // -------------------------------------------------------------------
  // The job

  /**
   * The reminder pass: one reminder to each guardian who has not confirmed a
   * request whose time has come. The database lists the requests that are due
   * (app.ack_remind_queue) and the pass takes them one at a time, each in a
   * transaction of its own (app.ack_remind_request) under the delivery door's
   * five seconds. A request that the database cannot finish in them, or that
   * fails for another reason, is rolled back alone and stays in the queue for
   * the next pass; the ones after it are still done, and a pass that runs out
   * of its minute leaves the rest for the next. The database writes the
   * notices and hands them back with the addresses; the e-mail and the push go
   * after each request's commit through the delivery that is there. The
   * request is SENT at the commit, which is what the database knows: the
   * notices are in the inboxes. That the e-mail and the push were taken by
   * their channels is the delivery's word, said when it has finished the batch
   * (markMirrored); until then, and for good if the process stops with the batch
   * in its queue or a channel refuses it, the request reads WRITTEN. Nothing
   * sends a reminder twice.
   */
  async remind(budgetMs: number = ACK_PASS_BUDGET_MS): Promise<{ reminded: number; requests: number; failed: number; left: number }> {
    const started = Date.now();
    const queue = await this.prisma.withDeliveryService((tx) =>
      tx.$queryRaw<Array<{ request_id: string }>>(Prisma.sql`SELECT request_id FROM app.ack_remind_queue(${ACK_QUEUE_LIMIT}::integer)`),
    );
    let reminded = 0;
    let requests = 0;
    let failed = 0;
    let at = 0;
    for (; at < queue.length && Date.now() - started < budgetMs; at += 1) {
      try {
        const rows = await this.prisma.withDeliveryService((tx) =>
          tx.$queryRaw<ReminderRow[]>(Prisma.sql`SELECT * FROM app.ack_remind_request(${queue[at]!.request_id}::uuid)`),
        );
        requests += 1;
        reminded += rows.length;
        if (rows.length > 0) {
          const requestId = queue[at]!.request_id;
          this.notifications.deliverCommitted(reminderEntries(rows), (delivered) => {
            if (delivered) void this.markMirrored(requestId);
            else this.logger.warn('A reminder was written to the inboxes but its e-mail or push was not taken by its channel');
          });
        }
      } catch (error) {
        failed += 1;
        this.logger.warn(`A request's reminder failed and stays in the queue [${errorName(error)}, sqlstate=${sqlStateOf(error) ?? 'none'}]`);
      }
    }
    return { reminded, requests, failed, left: queue.length - at };
  }

  /** Records that the delivery handed a SENT reminder's e-mail and push to their channels. Never throws: the request stays WRITTEN. */
  private async markMirrored(requestId: string): Promise<void> {
    try {
      await this.prisma.withDeliveryService((tx) => tx.$executeRaw(Prisma.sql`SELECT app.ack_reminder_mirrored(${requestId}::uuid)`));
    } catch (error) {
      this.logger.warn(`A reminder's delivery could not be recorded and stays WRITTEN [${errorName(error)}, sqlstate=${sqlStateOf(error) ?? 'none'}]`);
    }
  }

  // -------------------------------------------------------------------
  // The day's limits

  /**
   * How much of the day's limits has been used, for staff: the caller's own share (a teacher's 2 000 rows, an
   * administrator's 8 000), and for an administrator also the school's 20 000 and the senders who have used most.
   * The numbers are the database's (app.ack_usage asks the same function the limit does), counted over the last 24
   * hours as the limits are; a row is one guardian asked about one pupil.
   */
  async usage(user: AuthenticatedUser): Promise<AckUsage> {
    requireSchoolId(user);
    try {
      const rows = await this.prisma.withRls(user, (tx) =>
        tx.$queryRaw<Array<{ scope: 'SCHOOL' | 'ME' | 'SENDER'; author_id: string | null; author_name: string | null; used: number; cap: number }>>(
          Prisma.sql`SELECT scope, author_id, author_name, used, cap FROM app.ack_usage(${USAGE_SENDERS}::integer)`,
        ),
      );
      const line = (row: { used: number; cap: number }) => ({ used: Number(row.used), limit: Number(row.cap) });
      const school = rows.find((row) => row.scope === 'SCHOOL');
      const mine = rows.find((row) => row.scope === 'ME');
      return {
        school: school ? line(school) : null,
        // A login with no person (the huvudman's reader) is given an ME row of nothing used, but with no person id: it
        // has no share and cannot send, so the answer has no share of its own to show (the database's word, not ours).
        mine: mine?.author_id ? line(mine) : null,
        senders: school ? rows.filter((row) => row.scope === 'SENDER').map((row) => ({ name: row.author_name ?? '', ...line(row) })) : null,
      };
    } catch (error) {
      if (sqlStateOf(error) === 'KV403') {
        throw new ForbiddenException({ code: ACK_NOT_STAFF, message: 'Bara personal kan se förbrukningen.' });
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------

  /** The pupils a teacher mentors today, as the database says (the leave decision's definition). */
  private async menteesOf(tx: PrismaClient): Promise<string[]> {
    const [row] = await tx.$queryRaw<Array<{ ids: string[] }>>`SELECT app.ack_mentee_ids() AS "ids"`;
    return row?.ids ?? [];
  }

  private async statusOf(tx: PrismaClient, ids: string[]): Promise<StatusRow[]> {
    if (ids.length === 0) return [];
    return tx.$queryRaw<StatusRow[]>`SELECT * FROM app.ack_status(${ids}::uuid[])`;
  }

  /** Whether the reader may stop a reminder: its author, or an administrator who writes Drift. */
  private async mayStop(tx: PrismaClient, user: AuthenticatedUser, authorId: string | null): Promise<boolean> {
    if (user.role === Role.TEACHER) return authorId !== null && authorId === user.userId;
    if (user.role !== Role.SCHOOL_ADMIN) return false;
    const [row] = await tx.$queryRaw<Array<{ may: boolean }>>`SELECT app.current_user_may('DRIFT', true) AS "may"`;
    return row?.may === true;
  }

  private notFound(): NotFoundException {
    return new NotFoundException({ code: ACK_NOT_FOUND, message: 'Meddelandet finns inte, eller gäller inte dig.' });
  }
}
