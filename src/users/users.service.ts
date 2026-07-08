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

/**
 * User lifecycle for a school:
 *
 * 1. Admin creates a person → we invite them via the Supabase Admin API
 *    (service-role key, identity only — no tenant data access) and store the
 *    returned `auth.users.id` as `Users.authId`.
 * 2. The person clicks the invite email, sets a password on the web app's
 *    update-password page, and can immediately sign in — RLS resolves their
 *    role and school from the `Users` row created here.
 * 3. Deactivation (`isActive=false`) is preferred over deletion; hard delete
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

    // Identity first: invite via Supabase so the person can actually sign in.
    // Without Supabase admin config we fall back to a placeholder authId so
    // the catalog still works in development.
    let authId: string;
    if (this.supabaseAdmin.isConfigured) {
      try {
        authId = await this.supabaseAdmin.inviteUser(dto.email);
      } catch {
        // No PII in logs: log the failure class only.
        this.logger.error('Supabase invite failed for a new user.');
        throw new ServiceUnavailableException(
          'Could not send the invitation email. Please try again.',
        );
      }
    } else {
      authId = randomUUID();
    }

    try {
      return await this.prisma.withRls(user, (tx) =>
        tx.user.create({
          data: {
            schoolId,
            authId,
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
