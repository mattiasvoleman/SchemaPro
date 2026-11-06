import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import { recordRead } from '../access-log/access-log';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { requireSchoolId, requireUserId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  ACK_CUSTODY_ENDED,
  ACK_DISABLED,
  ACK_NO_GUARDIANS,
  ACK_NOT_A_GUARDIAN,
  ACK_NOT_FOUND,
  ACK_NOT_YOUR_PUPIL,
  ACK_UNKNOWN_PUPIL,
} from './ack';
import { requestedEntries, type ReminderRow, reminderEntries } from './ack-notices';
import type {
  AckConfirmed,
  AckCreated,
  AckDetail,
  AckGuardianRow,
  AckListItem,
  AckMine,
  AckPupilChoice,
  AckPupilRow,
  AckSettingsView,
} from './ack-views';
import type { AckSettingsDto, CreateAckRequestDto } from './dto/ack.dto';

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

/** The SQLSTATE a function of the migration raised, as the adapter reports a raw refusal (P2010). */
function sqlStateOf(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return null;
  const cause = (error.meta as { driverAdapterError?: { cause?: { originalCode?: unknown } } } | undefined)?.driverAdapterError?.cause;
  if (typeof cause?.originalCode === 'string') return cause.originalCode;
  return /Code: `([0-9A-Z]{5})`/.exec(error.message)?.[1] ?? null;
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

  /** The requests the caller may see, newest first, with counts and no names. */
  async list(user: AuthenticatedUser): Promise<AckListItem[]> {
    requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const requests = await tx.ackRequest.findMany({
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: { id: true, title: true, rule: true, authorName: true, createdAt: true, remindAt: true, reminderSentAt: true },
      });
      const status = await this.statusOf(tx, requests.map((request) => request.id));
      return requests.map((request) => {
        const rows = status.filter((row) => row.request_id === request.id);
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
          reminderSent: request.reminderSentAt !== null,
        };
      });
    });
  }

  /** One request with who confirmed and when, for the pupils the caller may see. Recorded in the read log. */
  async detail(id: string, user: AuthenticatedUser): Promise<AckDetail> {
    requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const request = await tx.ackRequest.findUnique({
        where: { id },
        select: { id: true, title: true, body: true, rule: true, authorName: true, createdAt: true, remindAt: true, reminderSentAt: true },
      });
      if (!request) throw this.notFound();
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
        pupils: shown,
      };
    });
  }

  // -------------------------------------------------------------------
  // The guardian

  /** The guardian's own requests, newest first: the children they are still linked to, and their own confirmation. */
  async mine(user: AuthenticatedUser): Promise<AckMine[]> {
    requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const requests = await tx.ackRequest.findMany({
        orderBy: { createdAt: 'desc' },
        take: 100,
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
      return requests.flatMap((request) => {
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
      });
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
  // The job

  /**
   * The reminder pass (app.ack_remind_due): one reminder to each guardian who
   * has not confirmed a request whose time has come. The database writes the
   * notices and hands them back with the addresses; the e-mail and the push go
   * after the commit through the delivery that is there. A failed delivery is
   * the delivery's to retry; the reminder is marked sent either way, once.
   */
  async remind(): Promise<{ reminded: number }> {
    const rows = await this.prisma.withDeliveryService((tx) => tx.$queryRaw<ReminderRow[]>(Prisma.sql`SELECT * FROM app.ack_remind_due()`));
    if (rows.length > 0) this.notifications.deliverCommitted(reminderEntries(rows));
    return { reminded: rows.length };
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

  private notFound(): NotFoundException {
    return new NotFoundException({ code: ACK_NOT_FOUND, message: 'Meddelandet finns inte, eller gäller inte dig.' });
  }
}
