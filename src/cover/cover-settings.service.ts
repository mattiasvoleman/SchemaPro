import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Role } from '../auth/enums/role.enum';
import { parseDateString, parseTimeString, toWallClock } from '../common/utils/time';
import { requireSchoolId, requireUserId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';
import { rethrowCoverError } from './cover-errors';
import { ensureDefaultReasons } from './teacher-absences.service';
import type {
  CoverSettingsDto,
  CreateAvailabilityDto,
  CreateReasonDto,
  UpdateReasonDto,
} from './dto/cover.dto';

export interface ReasonView {
  id: string;
  builtin: string | null;
  label: string | null;
  sortOrder: number;
  archived: boolean;
}

export interface CoverSettingsView {
  poolPreference: 'PREFER' | 'NEUTRAL' | 'LAST_RESORT';
  teacherSelfReport: boolean;
}

export interface AvailabilityView {
  id: string;
  userId: string;
  date: string | null;
  dayOfWeek: number | null;
  startTime: string;
  endTime: string;
}

export const REASON_BUILTIN_LABEL = 'REASON_BUILTIN_LABEL';
export const AVAILABILITY_SHAPE = 'AVAILABILITY_SHAPE';
export const AVAILABILITY_NOT_YOURS = 'AVAILABILITY_NOT_YOURS';

const REASON_SELECT = { id: true, builtin: true, label: true, sortOrder: true, archivedAt: true } as const;

/**
 * The school's absence categories, the board's two switches, and the
 * substitute pool with its availability windows. Admin writes everything; a
 * teacher reads the categories and the switches (self-report needs both)
 * and a pool member reads and writes their own windows. RLS says the same.
 */
@Injectable()
export class CoverSettingsService {
  private readonly logger = new Logger(CoverSettingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async reasons(user: AuthenticatedUser): Promise<ReasonView[]> {
    const schoolId = requireSchoolId(user);
    return this.write(user, async (tx) => {
      if (user.role === Role.SCHOOL_ADMIN) await ensureDefaultReasons(tx, schoolId);
      const rows = await tx.teacherAbsenceReason.findMany({
        select: REASON_SELECT,
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      });
      return rows.map(reasonView);
    });
  }

  async createReason(dto: CreateReasonDto, user: AuthenticatedUser): Promise<ReasonView> {
    const schoolId = requireSchoolId(user);
    return this.write(user, async (tx) =>
      reasonView(
        await tx.teacherAbsenceReason.create({
          data: { schoolId, label: dto.label, sortOrder: dto.sortOrder ?? 500 },
          select: REASON_SELECT,
        }),
      ),
    );
  }

  async updateReason(id: string, dto: UpdateReasonDto, user: AuthenticatedUser): Promise<ReasonView> {
    return this.write(user, async (tx) => {
      const current = await tx.teacherAbsenceReason.findUnique({ where: { id }, select: REASON_SELECT });
      if (!current) throw new NotFoundException('Orsaken finns inte.');
      if (dto.label !== undefined && current.builtin !== null) {
        throw new BadRequestException({
          message: 'label: en inbyggd orsak byter inte namn; arkivera den och lägg till en egen.',
          code: REASON_BUILTIN_LABEL,
        });
      }
      return reasonView(
        await tx.teacherAbsenceReason.update({
          where: { id },
          data: {
            ...(dto.label !== undefined ? { label: dto.label } : {}),
            ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
            ...(dto.archived !== undefined ? { archivedAt: dto.archived ? (current.archivedAt ?? new Date()) : null } : {}),
          },
          select: REASON_SELECT,
        }),
      );
    });
  }

  async settings(user: AuthenticatedUser): Promise<CoverSettingsView> {
    const schoolId = requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => settingsOf(tx, schoolId));
  }

  async putSettings(dto: CoverSettingsDto, user: AuthenticatedUser): Promise<CoverSettingsView> {
    const schoolId = requireSchoolId(user);
    return this.write(user, async (tx) => {
      // A teacher reporting their own absence picks from the list, so the
      // list exists the moment self-report is switched on.
      if (dto.teacherSelfReport) await ensureDefaultReasons(tx, schoolId);
      const row = await tx.coverSettings.upsert({
        where: { schoolId },
        create: { schoolId, poolPreference: dto.poolPreference, teacherSelfReport: dto.teacherSelfReport },
        update: { poolPreference: dto.poolPreference, teacherSelfReport: dto.teacherSelfReport },
        select: { poolPreference: true, teacherSelfReport: true },
      });
      this.logger.log(`Cover settings saved [school=${schoolId}]`);
      return row;
    });
  }

  async pool(user: AuthenticatedUser): Promise<{ userId: string; createdAt: string }[]> {
    return this.prisma.withRls(user, async (tx) =>
      (
        await tx.substitutePoolMember.findMany({
          select: { userId: true, createdAt: true },
          orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }],
        })
      ).map((row) => ({ userId: row.userId, createdAt: row.createdAt.toISOString() })),
    );
  }

  async addToPool(userId: string, user: AuthenticatedUser): Promise<{ userId: string }> {
    const schoolId = requireSchoolId(user);
    return this.write(user, async (tx) => {
      await tx.substitutePoolMember.create({
        data: { schoolId, userId, createdByUserId: user.userId ?? null },
        select: { id: true },
      });
      this.logger.log(`Pool member added [user=${userId}]`);
      return { userId };
    });
  }

  async removeFromPool(userId: string, user: AuthenticatedUser): Promise<void> {
    await this.write(user, async (tx) => {
      const { count } = await tx.substitutePoolMember.deleteMany({ where: { userId } });
      if (count === 0) throw new NotFoundException('Personen står inte i vikariepoolen.');
    });
  }

  async availability(userId: string | undefined, user: AuthenticatedUser): Promise<AvailabilityView[]> {
    const own = user.role !== Role.SCHOOL_ADMIN;
    const target = own ? requireUserId(user) : userId;
    return this.prisma.withRls(user, async (tx) =>
      (
        await tx.substituteAvailability.findMany({
          where: target ? { userId: target } : {},
          select: { id: true, userId: true, date: true, dayOfWeek: true, startTime: true, endTime: true },
          orderBy: [{ userId: 'asc' }, { date: 'asc' }, { dayOfWeek: 'asc' }, { startTime: 'asc' }],
        })
      ).map(availabilityView),
    );
  }

  async addAvailability(dto: CreateAvailabilityDto, user: AuthenticatedUser): Promise<AvailabilityView> {
    const schoolId = requireSchoolId(user);
    const isAdmin = user.role === Role.SCHOOL_ADMIN;
    const me = requireUserId(user);
    const userId = dto.userId ?? (isAdmin ? undefined : me);
    if (!userId) throw new BadRequestException({ message: 'userId: vems tillgänglighet.', code: AVAILABILITY_SHAPE });
    if (!isAdmin && userId !== me) {
      throw new ForbiddenException({ message: 'En vikarie anger bara sin egen tillgänglighet.', code: AVAILABILITY_NOT_YOURS });
    }
    if ((dto.date === undefined) === (dto.dayOfWeek === undefined)) {
      throw new BadRequestException({ message: 'date eller dayOfWeek, exakt en av dem.', code: AVAILABILITY_SHAPE });
    }
    if (dto.startTime >= dto.endTime) {
      throw new BadRequestException({ message: 'endTime: efter startTime.', code: AVAILABILITY_SHAPE });
    }
    return this.write(user, async (tx) =>
      availabilityView(
        await tx.substituteAvailability.create({
          data: {
            schoolId,
            userId,
            date: dto.date !== undefined ? parseDateString(dto.date) : null,
            dayOfWeek: dto.dayOfWeek ?? null,
            startTime: parseTimeString(dto.startTime),
            endTime: parseTimeString(dto.endTime),
          },
          select: { id: true, userId: true, date: true, dayOfWeek: true, startTime: true, endTime: true },
        }),
      ),
    );
  }

  async removeAvailability(id: string, user: AuthenticatedUser): Promise<void> {
    await this.write(user, async (tx) => {
      // RLS: the admin any window, a member their own.
      const { count } = await tx.substituteAvailability.deleteMany({ where: { id } });
      if (count === 0) throw new NotFoundException('Tillgängligheten finns inte.');
    });
  }

  private async write<T>(user: AuthenticatedUser, body: (tx: PrismaClient) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.withRls(user, body);
    } catch (error) {
      rethrowCoverError(error);
    }
  }
}

export async function settingsOf(tx: PrismaClient, schoolId: string): Promise<CoverSettingsView> {
  const row = await tx.coverSettings.findUnique({
    where: { schoolId },
    select: { poolPreference: true, teacherSelfReport: true },
  });
  return row ?? { poolPreference: 'NEUTRAL', teacherSelfReport: false };
}

function reasonView(row: {
  id: string;
  builtin: string | null;
  label: string | null;
  sortOrder: number;
  archivedAt: Date | null;
}): ReasonView {
  return { id: row.id, builtin: row.builtin, label: row.label, sortOrder: row.sortOrder, archived: row.archivedAt !== null };
}

function availabilityView(row: {
  id: string;
  userId: string;
  date: Date | null;
  dayOfWeek: number | null;
  startTime: Date;
  endTime: Date;
}): AvailabilityView {
  return {
    id: row.id,
    userId: row.userId,
    date: row.date ? row.date.toISOString().slice(0, 10) : null,
    dayOfWeek: row.dayOfWeek,
    startTime: toWallClock(row.startTime),
    endTime: toWallClock(row.endTime),
  };
}
