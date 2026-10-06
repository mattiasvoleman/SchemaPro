import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, type User, type UserRole } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { listNames, rethrowPrismaError } from '../common/utils/prisma-errors';
import { SupabaseAdminService } from './supabase-admin.service';
import type { CreateUserDto, UpdateUserDto } from './dto/user.dto';

/**
 * Whose post or behörighet may exist: the same two roles staff-lock.ts admits,
 * because a teaching rektor carries SCHOOL_ADMIN and is named on requirements.
 */
const isStaff = (role: UserRole): boolean => role === 'TEACHER' || role === 'SCHOOL_ADMIN';

/** "1 tjänst och 3 behörigheter", naming only what is there. */
function describeStaffingRows(
  employments: number,
  qualifications: number,
  duties: number,
): string {
  const parts: string[] = [];
  if (employments > 0) {
    parts.push(`${employments} ${employments === 1 ? 'tjänst' : 'tjänster'}`);
  }
  if (qualifications > 0) {
    parts.push(`${qualifications} ${qualifications === 1 ? 'behörighet' : 'behörigheter'}`);
  }
  if (duties > 0) {
    // "uppdrag" is its own plural.
    parts.push(`${duties} uppdrag`);
  }
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} och ${parts[parts.length - 1]}`;
}

/** Outcome of inviting one person. */
export interface InvitationResult {
  id: string;
  /**
   * False when the address already had an identity — the provider sends no
   * mail in that case, and saying otherwise would be a lie to the admin.
   */
  emailSent: boolean;
}

/** Outcome of a bulk invitation run. */
export interface BulkInvitationReport {
  sent: number;
  alreadyRegistered: number;
  errors: { userId: string; message: string }[];
}

/**
 * User lifecycle for a school:
 *
 * 1. Admin creates a person. By default NO email is sent: the row gets a
 *    placeholder `authId` that matches no Supabase identity, so the person
 *    exists in the catalog and cannot sign in. A school builds its roster
 *    weeks before term starts, and importing 300 students must not mean
 *    emailing 300 students.
 * 2. When the admin chooses to — at creation with `sendInvitation`, or later
 *    via `invite()` — the Supabase Admin API is called (service-role key,
 *    identity only — no tenant data access), the placeholder is replaced with
 *    the returned `auth.users.id`, and `invitedAt` is stamped. The row is
 *    always written before that call goes out, never after: see `create()`.
 * 3. The person clicks the invite email, sets a password on the web app's
 *    update-password page, and can immediately sign in — RLS resolves their
 *    role and school from the `Users` row.
 * 4. Deactivation (`isActive=false`) is preferred over deletion; hard delete
 *    also removes the Supabase identity.
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  async create(dto: CreateUserDto, user: AuthenticatedUser): Promise<User> {
    const schoolId = requireSchoolId(user);

    if (dto.studentGroupId && dto.role !== 'STUDENT') {
      throw new BadRequestException('Only students can be assigned to a student group.');
    }
    // Checked before anything is written: a deployment that cannot send mail
    // must not answer "created and invited" having done only the first half.
    if (dto.sendInvitation && !this.supabaseAdmin.isConfigured) {
      throw new ServiceUnavailableException(
        'Invitations are not configured for this deployment.',
      );
    }

    // Adding someone to the catalog is not the same act as contacting them.
    // Only an explicit `sendInvitation` reaches out; otherwise the row keeps
    // the placeholder authId below, which matches no Supabase identity and
    // therefore authenticates nobody.
    //
    // The row is written first even when an invitation was asked for, because
    // the order decides who pays for a failure. Minting the identity first
    // means a rejected insert — a duplicate email is the everyday case — has
    // already put a set-password link in somebody's inbox for an account this
    // school never got, and no transaction can take that back. This way the
    // insert either succeeds or nobody has been contacted.
    let created: User;
    try {
      created = await this.prisma.withRls(user, (tx) =>
        tx.user.create({
          data: {
            schoolId,
            authId: randomUUID(),
            invitedAt: null,
            role: dto.role,
            firstName: dto.firstName,
            lastName: dto.lastName,
            email: dto.email,
            phone: dto.phone ?? null,
            studentGroupId: dto.role === 'STUDENT' ? (dto.studentGroupId ?? null) : null,
          },
        }),
      );
    } catch (error) {
      rethrowPrismaError(error);
    }

    if (!dto.sendInvitation) {
      return created;
    }

    let invite: { authId: string; emailSent: boolean };
    try {
      invite = await this.mintIdentity(dto.email);
    } catch (error) {
      // The provider refused, so take the row back: "create and invite" keeps
      // its both-or-neither promise, and the admin's retry is then just
      // pressing the button again instead of colliding with a half-made
      // person. If the refusal was really a lost answer to mail that did go
      // out, creating the person again re-adopts that same identity — GoTrue
      // answers 422 for an address it knows — so the delivered link still
      // works.
      await this.discardUninvitedRow(created.id, user);
      throw error;
    }

    return this.adoptIdentity(created.id, invite.authId, user);
  }

  /**
   * Sends (or re-sends) the invitation for one person and adopts the identity
   * the provider returns.
   *
   * Replacing `authId` is the point: until now the row held a placeholder, and
   * the person could not sign in. Re-inviting somebody who already has an
   * identity is allowed — the result simply reports that no new email went
   * out, because GoTrue sends none for an address it already knows.
   */
  async invite(id: string, user: AuthenticatedUser): Promise<InvitationResult> {
    if (!this.supabaseAdmin.isConfigured) {
      throw new ServiceUnavailableException(
        'Invitations are not configured for this deployment.',
      );
    }

    const target = await this.prisma.withRls(user, (tx) =>
      tx.user.findUnique({
        where: { id },
        select: { id: true, email: true, isActive: true },
      }),
    );
    if (!target) {
      throw new NotFoundException('The requested record does not exist.');
    }
    if (!target.isActive) {
      throw new BadRequestException(
        'Inactive people cannot be invited. Reactivate them first.',
      );
    }

    const invite = await this.mintIdentity(target.email);
    await this.adoptIdentity(id, invite.authId, user);

    return { id, emailSent: invite.emailSent };
  }

  /**
   * Invites several people, one at a time.
   *
   * Row-wise like the CSV import, and for the same reason: each invitation is
   * an external side effect that no transaction can roll back, so one failure
   * must not discard the ones that already went out. The report names the
   * people who failed rather than the count alone.
   */
  async inviteMany(
    ids: string[],
    user: AuthenticatedUser,
  ): Promise<BulkInvitationReport> {
    const report: BulkInvitationReport = {
      sent: 0,
      alreadyRegistered: 0,
      errors: [],
    };

    for (const id of ids) {
      try {
        const result = await this.invite(id, user);
        if (result.emailSent) {
          report.sent += 1;
        } else {
          report.alreadyRegistered += 1;
        }
      } catch (error) {
        report.errors.push({
          userId: id,
          message:
            error instanceof Error
              ? error.message
              : 'Inbjudan kunde inte skickas.',
        });
      }
    }

    return report;
  }

  /**
   * The stored role and group are read under a row lock, in the transaction
   * that writes them.
   *
   * `withRls` runs READ COMMITTED, where a plain read holds nothing still.
   * Against a student with no group, a PATCH making them a teacher and a PATCH
   * putting them in 7B would each pass against the row the other has not
   * changed yet, and together try to store a teacher in 7B. The CHECK
   * Users_only_a_student_has_a_class refuses that row, but only as an unmapped
   * 500 for whichever PATCH writes second. With the lock the second PATCH waits
   * for the first to commit, is judged against what it wrote, and gets the 400.
   *
   * FOR NO KEY UPDATE rather than FOR UPDATE: see the Isolation section of
   * PrismaService. Raw SQL because Prisma has no locking read. Under RLS the
   * lock also needs the UPDATE policy to admit the row, and `users_admin_all`
   * does for the admin the controller already requires, so a user in another
   * school still reads as missing and gets the same 404.
   *
   * The same lock is the other half of src/staffing/staff-lock.ts. A post and a
   * behörighet belong to a member of staff, and the staffing writes read this
   * row FOR NO KEY UPDATE to make sure of it — which only settles the race. A
   * PATCH that makes a teacher a pupil AFTER their post was written would
   * leave a STUDENT holding a tjänstgöringsgrad and a legitimation, and the
   * load report would list a pupil among the teachers. Uppdrag (Fas 2) count
   * the same way: a pupil who is still mentor for 7B would be a row in the
   * matrix, and their rastvakt slot an UNAVAILABLE block on a pupil. So a role change out
   * of staff is refused while such rows exist, by count and in the same
   * transaction, and the sentence names what to remove first. No DB CHECK can
   * say this (cross-table), which is why it is said here.
   */
  async update(id: string, dto: UpdateUserDto, user: AuthenticatedUser): Promise<User> {
    try {
      return await this.prisma.withRls(user, async (tx) => {
        // Students-only is a rule about the row that results, not about the
        // patch, so the stored values are half the answer: a body naming only
        // a group says nothing about the role, and a body naming only a role
        // leaves any group already there in place. Both doors lead to the same
        // forbidden row, and that row is more than an untidy record —
        // app.current_user_group_id() reads studentGroupId without looking at
        // the role, so a teacher or guardian sitting in a student group is
        // handed the students' read path on that group's lessons.
        const [current] = await tx.$queryRaw<Pick<User, 'role' | 'studentGroupId'>[]>`
          SELECT "role", "studentGroupId"
          FROM "Users"
          WHERE "id" = ${id}::uuid
          FOR NO KEY UPDATE
        `;
        if (!current) {
          throw new NotFoundException('The requested record does not exist.');
        }
        const role = dto.role ?? current.role;
        const studentGroupId =
          dto.studentGroupId !== undefined ? dto.studentGroupId : current.studentGroupId;
        if (studentGroupId && role !== 'STUDENT') {
          throw new BadRequestException(
            'Only students can be assigned to a student group.',
          );
        }

        if (isStaff(current.role) && !isStaff(role)) {
          const [employments, qualifications, duties] = await Promise.all([
            tx.teacherEmployment.count({ where: { userId: id } }),
            tx.teacherSubjectQualification.count({ where: { userId: id } }),
            tx.teacherDuty.count({ where: { userId: id } }),
          ]);
          if (employments > 0 || qualifications > 0 || duties > 0) {
            throw new ConflictException(
              `Personen kan inte bli ${role === 'STUDENT' ? 'elev' : 'vårdnadshavare'}: ${describeStaffingRows(employments, qualifications, duties)} finns registrerade. Ta bort dem under Personer först.`,
            );
          }
        }

        return tx.user.update({
          where: { id },
          data: {
            ...(dto.role !== undefined ? { role: dto.role } : {}),
            ...(dto.firstName !== undefined ? { firstName: dto.firstName } : {}),
            ...(dto.lastName !== undefined ? { lastName: dto.lastName } : {}),
            ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
            ...(dto.studentGroupId !== undefined
              ? { studentGroupId: dto.studentGroupId }
              : {}),
            ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          },
        });
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    let authId: string | null = null;
    try {
      authId = await this.prisma.withRls(user, async (tx) => {
        const target = await tx.user.findUnique({
          where: { id },
          select: { authId: true, invitedAt: true },
        });
        if (!target) {
          throw new NotFoundException('The requested record does not exist.');
        }
        // A decided lokal timplan names who recorded the decision, and the
        // record keeps that name: LocalTimplans_decidedByUserId_schoolId_fkey
        // is ON DELETE RESTRICT. Asked first so the answer names the plans
        // and the way out, instead of the generic "references a record".
        const decided = await tx.localTimplan.findMany({
          where: { decidedByUserId: id },
          select: { name: true },
          orderBy: { name: 'asc' },
        });
        if (decided.length > 0) {
          throw recordedATimplanDecision(decided.map((plan) => plan.name));
        }
        await tx.user.delete({ where: { id } });
        // Somebody who was never contacted has no identity to delete: `authId`
        // is a placeholder uuid written at create time and matching nothing at
        // the provider. Asking it to delete one produced a warning that read
        // like a failure on every removal of an uninvited person, which is most
        // of them while a school is still building its catalog.
        return target.invitedAt === null ? null : target.authId;
      });
    } catch (error) {
      if (error instanceof NotFoundException || error instanceof ConflictException) throw error;
      // A plan decided by this person between the question and the delete.
      if (isDeciderReference(error)) throw recordedATimplanDecision([]);
      rethrowPrismaError(error);
    }

    // Best effort: also remove the Supabase identity so the email can be
    // re-invited later. The tenant row is already gone; an orphaned identity
    // grants no data access (RLS finds no Users row).
    if (authId) {
      try {
        await this.supabaseAdmin.deleteUser(authId);
      } catch {
        this.logger.warn('Failed to delete the Supabase identity for a removed user.');
      }
    }
  }

  /** Asks the provider for the identity behind an address, minting one if needed. */
  private async mintIdentity(
    email: string,
  ): Promise<{ authId: string; emailSent: boolean }> {
    try {
      return await this.supabaseAdmin.inviteUser(email);
    } catch {
      this.logger.error('Supabase invite failed.'); // no PII in logs
      throw new ServiceUnavailableException(
        'Could not send the invitation email. Please try again.',
      );
    }
  }

  /**
   * Points a row at the identity the provider just handed us.
   *
   * When this write fails the identity stays where it is. Deleting it as
   * compensation would be the wrong instinct twice over: `inviteUser` also
   * answers with identities it did NOT create — an address already known to
   * GoTrue resolves to the existing one, which may well belong to somebody
   * signed in at another school — and even when the identity is ours, the
   * invitation link has already been delivered, so removing it turns a mail
   * the person is holding into a dead end. Left alone, the same link keeps
   * working: a retry re-adopts the identity (GoTrue answers 422 for a known
   * address and SupabaseAdminService looks the id up) and links the row.
   *
   * What we owe instead is a trail. The pair logged below is what reconciles
   * a stranded identity with the row that should be carrying it; both are
   * opaque ids, so nothing about the person reaches the log.
   */
  private async adoptIdentity(
    id: string,
    authId: string,
    user: AuthenticatedUser,
  ): Promise<User> {
    try {
      return await this.prisma.withRls(user, (tx) =>
        tx.user.update({
          where: { id },
          data: { authId, invitedAt: new Date() },
        }),
      );
    } catch (error) {
      this.logger.error(
        `Invitation identity was not linked to its row [user=${id}] [authId=${authId}]`,
      );
      rethrowPrismaError(error);
    }
  }

  /**
   * Drops a row created moments ago for an invitation that never went out.
   *
   * Safe in the way the mirror-image compensation is not: this row is ours, it
   * is seconds old, it carries a placeholder identity and nothing references
   * it yet.
   */
  private async discardUninvitedRow(
    id: string,
    user: AuthenticatedUser,
  ): Promise<void> {
    try {
      await this.prisma.withRls(user, (tx) => tx.user.delete({ where: { id } }));
    } catch {
      // Not worth failing over: a row with a placeholder identity is the
      // ordinary state of somebody a school has added but not yet contacted.
      // The admin still hears about the invitation, which is the real failure.
      this.logger.warn('Could not remove a user row after a failed invitation.');
    }
  }
}

/**
 * The 409 for removing someone a decided timplan names as its decider. A
 * decision's who is part of the record; the person is deactivated instead,
 * which keeps the name on the plan and takes every access away.
 */
function recordedATimplanDecision(planNames: string[]): ConflictException {
  const which =
    planNames.length === 0
      ? 'en beslutad lokal timplan'
      : planNames.length === 1
        ? `den beslutade lokala timplanen ${listNames(planNames)}`
        : `de beslutade lokala timplanerna ${listNames(planNames)}`;
  return new ConflictException(
    `Personen står som den som registrerade beslutet om ${which} och kan inte tas bort. ` +
      'Inaktivera kontot i stället; beslutet behåller sitt namn.',
  );
}

/** The restrict foreign key from a decided plan to its decider, as the pg adapter reports it. */
function isDeciderReference(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2003' &&
    JSON.stringify(error.meta ?? {}).includes('LocalTimplans_decidedByUserId_schoolId_fkey')
  );
}
