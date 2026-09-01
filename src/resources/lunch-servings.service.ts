import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { LunchServing } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { parseTimeString, toWallClock } from '../common/utils/time';
import type {
  CreateLunchServingDto,
  UpdateLunchServingDto,
} from './dto/lunch-serving.dto';

/** A sitting as the client sees it: clock strings, not 1970 timestamps. */
export interface LunchServingResponse {
  id: string;
  minGradeLevel: number;
  maxGradeLevel: number;
  dayOfWeek: number | null;
  /** HH:MM */
  startTime: string;
  /** HH:MM */
  endTime: string;
  seats: number | null;
}

@Injectable()
export class LunchServingsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthenticatedUser): Promise<LunchServingResponse[]> {
    requireSchoolId(user);
    const rows = await this.prisma.withRls(user, (tx) =>
      tx.lunchServing.findMany({
        // Youngest stage first, then the every-day row before the weekdays that
        // replace it — the order the flow actually runs in on a Monday.
        orderBy: [
          { minGradeLevel: 'asc' },
          { dayOfWeek: { sort: 'asc', nulls: 'first' } },
          { startTime: 'asc' },
        ],
      }),
    );
    return rows.map(toResponse);
  }

  async create(
    dto: CreateLunchServingDto,
    user: AuthenticatedUser,
  ): Promise<LunchServingResponse> {
    const schoolId = requireSchoolId(user);
    assertWindow(dto.startTime, dto.endTime);
    assertSpan(dto.minGradeLevel, dto.maxGradeLevel);

    try {
      const row = await this.prisma.withRls(user, (tx) =>
        tx.lunchServing.create({
          data: {
            schoolId,
            minGradeLevel: dto.minGradeLevel,
            maxGradeLevel: dto.maxGradeLevel,
            dayOfWeek: dto.dayOfWeek ?? null,
            startTime: parseTimeString(dto.startTime),
            endTime: parseTimeString(dto.endTime),
            seats: dto.seats ?? null,
          },
        }),
      );
      return toResponse(row);
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  /**
   * The stored row is read first, and the checks run on the MERGE — the same
   * reason FrameTimesService does: a PATCH naming one end of the window says
   * nothing about the other, and validating the payload alone lets the database
   * answer with a constraint violation the admin cannot act on.
   */
  async update(
    id: string,
    dto: UpdateLunchServingDto,
    user: AuthenticatedUser,
  ): Promise<LunchServingResponse> {
    requireSchoolId(user);
    const current = await this.prisma.withRls(user, (tx) =>
      tx.lunchServing.findUnique({ where: { id } }),
    );
    if (!current) {
      throw new NotFoundException(`Lunch serving ${id} not found.`);
    }

    assertWindow(
      dto.startTime ?? toWallClock(current.startTime),
      dto.endTime ?? toWallClock(current.endTime),
    );
    assertSpan(
      dto.minGradeLevel ?? current.minGradeLevel,
      dto.maxGradeLevel ?? current.maxGradeLevel,
    );

    try {
      const row = await this.prisma.withRls(user, (tx) =>
        tx.lunchServing.update({
          where: { id },
          data: {
            ...(dto.minGradeLevel !== undefined ? { minGradeLevel: dto.minGradeLevel } : {}),
            ...(dto.maxGradeLevel !== undefined ? { maxGradeLevel: dto.maxGradeLevel } : {}),
            ...(dto.dayOfWeek !== undefined ? { dayOfWeek: dto.dayOfWeek } : {}),
            ...(dto.startTime !== undefined ? { startTime: parseTimeString(dto.startTime) } : {}),
            ...(dto.endTime !== undefined ? { endTime: parseTimeString(dto.endTime) } : {}),
            ...(dto.seats !== undefined ? { seats: dto.seats } : {}),
          },
        }),
      );
      return toResponse(row);
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    requireSchoolId(user);
    try {
      await this.prisma.withRls(user, (tx) => tx.lunchServing.delete({ where: { id } }));
    } catch (error) {
      rethrowPrismaError(error);
    }
  }
}

function toResponse(row: LunchServing): LunchServingResponse {
  return {
    id: row.id,
    minGradeLevel: row.minGradeLevel,
    maxGradeLevel: row.maxGradeLevel,
    dayOfWeek: row.dayOfWeek,
    startTime: toWallClock(row.startTime),
    endTime: toWallClock(row.endTime),
    seats: row.seats,
  };
}

/**
 * Compared as MINUTES, not as strings: the DTO's regex admits HH:MM and
 * HH:MM:SS, and a lexical compare reads "09:00" as before "09:00:30" — a
 * thirty-second sitting, accepted as a window.
 */
function assertWindow(startTime: string, endTime: string): void {
  if (minutesOf(startTime) >= minutesOf(endTime)) {
    throw new BadRequestException('startTime must be before endTime.');
  }
}

function minutesOf(time: string): number {
  const [hours, minutes] = time.split(':');
  return Number(hours) * 60 + Number(minutes);
}

function assertSpan(minGradeLevel: number, maxGradeLevel: number): void {
  if (minGradeLevel > maxGradeLevel) {
    throw new BadRequestException('minGradeLevel must not be above maxGradeLevel.');
  }
}
