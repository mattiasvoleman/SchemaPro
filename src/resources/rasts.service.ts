import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Rast } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { parseTimeString, toWallClock } from '../common/utils/time';
import type { CreateRastDto, UpdateRastDto } from './dto/rast.dto';

/** A rast as the client sees it: clock strings, not 1970 timestamps. */
export interface RastResponse {
  id: string;
  name: string;
  minGradeLevel: number;
  maxGradeLevel: number;
  dayOfWeek: number | null;
  /** HH:MM */
  startTime: string;
  /** HH:MM */
  endTime: string;
}

@Injectable()
export class RastsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthenticatedUser): Promise<RastResponse[]> {
    requireSchoolId(user);
    const rows = await this.prisma.withRls(user, (tx) =>
      tx.rast.findMany({
        // Youngest stage first, then the every-day row before the weekdays that
        // may shadow it, then up the clock — the order the day is actually
        // lived, which is the order the admin page prints.
        orderBy: [
          { minGradeLevel: 'asc' },
          { dayOfWeek: { sort: 'asc', nulls: 'first' } },
          { startTime: 'asc' },
        ],
      }),
    );
    return rows.map(toResponse);
  }

  async create(dto: CreateRastDto, user: AuthenticatedUser): Promise<RastResponse> {
    const schoolId = requireSchoolId(user);
    assertWindow(dto.startTime, dto.endTime);
    assertSpan(dto.minGradeLevel, dto.maxGradeLevel);

    try {
      const row = await this.prisma.withRls(user, (tx) =>
        tx.rast.create({
          data: {
            schoolId,
            name: dto.name.trim(),
            minGradeLevel: dto.minGradeLevel,
            maxGradeLevel: dto.maxGradeLevel,
            dayOfWeek: dto.dayOfWeek ?? null,
            startTime: parseTimeString(dto.startTime),
            endTime: parseTimeString(dto.endTime),
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
   * reason FrameTimesService and LunchServingsService do: a PATCH naming one end
   * of the window says nothing about the other, and validating the payload
   * alone lets the database answer with a constraint violation the admin cannot
   * act on.
   */
  async update(
    id: string,
    dto: UpdateRastDto,
    user: AuthenticatedUser,
  ): Promise<RastResponse> {
    requireSchoolId(user);
    const current = await this.prisma.withRls(user, (tx) =>
      tx.rast.findUnique({ where: { id } }),
    );
    if (!current) {
      throw new NotFoundException(`Rast ${id} not found.`);
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
        tx.rast.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
            ...(dto.minGradeLevel !== undefined ? { minGradeLevel: dto.minGradeLevel } : {}),
            ...(dto.maxGradeLevel !== undefined ? { maxGradeLevel: dto.maxGradeLevel } : {}),
            ...(dto.dayOfWeek !== undefined ? { dayOfWeek: dto.dayOfWeek } : {}),
            ...(dto.startTime !== undefined ? { startTime: parseTimeString(dto.startTime) } : {}),
            ...(dto.endTime !== undefined ? { endTime: parseTimeString(dto.endTime) } : {}),
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
      await this.prisma.withRls(user, (tx) => tx.rast.delete({ where: { id } }));
    } catch (error) {
      rethrowPrismaError(error);
    }
  }
}

function toResponse(row: Rast): RastResponse {
  return {
    id: row.id,
    name: row.name,
    minGradeLevel: row.minGradeLevel,
    maxGradeLevel: row.maxGradeLevel,
    dayOfWeek: row.dayOfWeek,
    startTime: toWallClock(row.startTime),
    endTime: toWallClock(row.endTime),
  };
}

/**
 * Compared as MINUTES, not as strings: the DTO's regex admits HH:MM and
 * HH:MM:SS, and a lexical compare reads "09:00" as before "09:00:30" — a
 * thirty-second rast, accepted as a window.
 *
 * There is no MINIMUM length here on purpose. A three-minute rast is short, and
 * short is what a changeover between two rooms is; the engine rounds it OUTWARD
 * to a whole slot rather than to nothing, so it is honoured rather than lost.
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
