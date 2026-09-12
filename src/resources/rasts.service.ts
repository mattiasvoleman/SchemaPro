import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { PrismaClient, Rast } from '@prisma/client';
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
  /** Whether the stretch ending at this rast must hold a lesson. */
  requiresLessonBefore: boolean;
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
            requiresLessonBefore: dto.requiresLessonBefore ?? false,
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
   *
   * Read under a row lock, in the transaction that writes it: two one-sided
   * PATCHes must not both pass against the row neither has changed yet. See
   * `lockBounds`.
   */
  async update(
    id: string,
    dto: UpdateRastDto,
    user: AuthenticatedUser,
  ): Promise<RastResponse> {
    requireSchoolId(user);

    try {
      const row = await this.prisma.withRls(user, async (tx) => {
        const current = await lockBounds(tx, id);
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

        return tx.rast.update({
          where: { id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
            ...(dto.minGradeLevel !== undefined ? { minGradeLevel: dto.minGradeLevel } : {}),
            ...(dto.maxGradeLevel !== undefined ? { maxGradeLevel: dto.maxGradeLevel } : {}),
            ...(dto.dayOfWeek !== undefined ? { dayOfWeek: dto.dayOfWeek } : {}),
            ...(dto.startTime !== undefined ? { startTime: parseTimeString(dto.startTime) } : {}),
            ...(dto.endTime !== undefined ? { endTime: parseTimeString(dto.endTime) } : {}),
            ...(dto.requiresLessonBefore !== undefined
              ? { requiresLessonBefore: dto.requiresLessonBefore }
              : {}),
          },
        });
      });
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
    requiresLessonBefore: row.requiresLessonBefore,
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

/** What update() merges a PATCH against: the window and the span. */
type StoredBounds = Pick<Rast, 'startTime' | 'endTime' | 'minGradeLevel' | 'maxGradeLevel'>;

/**
 * The bounds update() merges against, read under a row lock in the transaction
 * that writes them. FrameTimesService's `lockBounds` gives the whole argument,
 * and this table has the same two CHECKs with the same gap in them. READ
 * COMMITTED holds nothing still, so two one-sided PATCHes can each pass against
 * the row neither has changed yet: an inversion then fails as a 500, and a
 * start moved to 09:40 racing an end moved to 09:40:30 is stored as a
 * thirty-second rast.
 */
async function lockBounds(tx: PrismaClient, id: string): Promise<StoredBounds | undefined> {
  const [row] = await tx.$queryRaw<StoredBounds[]>`
    SELECT "startTime", "endTime", "minGradeLevel", "maxGradeLevel"
    FROM "Rasts"
    WHERE "id" = ${id}::uuid
    FOR UPDATE
  `;
  return row;
}
