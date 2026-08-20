import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { User } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { SupabaseAdminService } from './supabase-admin.service';
import type { CreateUserDto, UpdateUserDto } from './dto/user.dto';

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
 * 2. When the admin chooses to, `invite()` calls the Supabase Admin API
 *    (service-role key, identity only — no tenant data access), replaces the
 *    placeholder with the returned `auth.users.id`, and stamps `invitedAt`.
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

    // Adding someone to the catalog is not the same act as contacting them.
    // Only an explicit `sendInvitation` reaches out; otherwise the row carries
    // a placeholder authId, which matches no Supabase identity and therefore
    // authenticates nobody.
    let authId: string = randomUUID();
    let invitedAt: Date | null = null;

    if (dto.sendInvitation) {
      if (!this.supabaseAdmin.isConfigured) {
        throw new ServiceUnavailableException(
          'Invitations are not configured for this deployment.',
        );
      }
      try {
        const invite = await this.supabaseAdmin.inviteUser(dto.email);
        authId = invite.authId;
        invitedAt = new Date();
      } catch {
        // No PII in logs: log the failure class only.
        this.logger.error('Supabase invite failed for a new user.');
        throw new ServiceUnavailableException(
          'Could not send the invitation email. Please try again.',
        );
      }
    }

    try {
      return await this.prisma.withRls(user, (tx) =>
        tx.user.create({
          data: {
            schoolId,
            authId,
            invitedAt,
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

    let invite: { authId: string; emailSent: boolean };
    try {
      invite = await this.supabaseAdmin.inviteUser(target.email);
    } catch {
      this.logger.error('Supabase invite failed.'); // no PII in logs
      throw new ServiceUnavailableException(
        'Could not send the invitation email. Please try again.',
      );
    }

    await this.prisma.withRls(user, (tx) =>
      tx.user.update({
        where: { id },
        data: { authId: invite.authId, invitedAt: new Date() },
      }),
    );

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

  async update(id: string, dto: UpdateUserDto, user: AuthenticatedUser): Promise<User> {
    if (dto.studentGroupId && dto.role && dto.role !== 'STUDENT') {
      throw new BadRequestException('Only students can be assigned to a student group.');
    }

    try {
      return await this.prisma.withRls(user, (tx) =>
        tx.user.update({
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
        }),
      );
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
          select: { authId: true },
        });
        if (!target) {
          throw new NotFoundException('The requested record does not exist.');
        }
        await tx.user.delete({ where: { id } });
        return target.authId;
      });
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
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
}
