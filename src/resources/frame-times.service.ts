import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { FrameTime } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { parseTimeString, toWallClock } from '../common/utils/time';
import type { CreateFrameTimeDto, UpdateFrameTimeDto } from './dto/frame-time.dto';

/**
 * A frame as the client sees it: clock strings, not 1970 timestamps.
 *
 * Prisma hands a `@db.Time` column back as a Date anchored at 1970-01-01, and
 * `JSON.stringify` turns that into "1970-01-01T15:00:00.000Z". An endpoint that
 * returns the row unserialised therefore sends a timestamp where the form is
 * expecting a clock — the bug that emptied the lunch card's time inputs.
 */
export interface FrameTimeResponse {
  id: string;
  minGradeLevel: number;
  maxGradeLevel: number;
  dayOfWeek: number | null;
  /** HH:MM */
  startTime: string;
  /** HH:MM */
  endTime: string;
}

@Injectable()
export class FrameTimesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthenticatedUser): Promise<FrameTimeResponse[]> {
    requireSchoolId(user);
    const rows = await this.prisma.withRls(user, (tx) =>
      tx.frameTime.findMany({
        // The every-day frame first, then Monday onward: the order the form
        // reads in, since the every-day row is the one the weekday rows narrow.
        orderBy: [
          { minGradeLevel: 'asc' },
          { maxGradeLevel: 'asc' },
          { dayOfWeek: { sort: 'asc', nulls: 'first' } },
        ],
      }),
    );
    return rows.map(toResponse);
  }

  async create(dto: CreateFrameTimeDto, user: AuthenticatedUser): Promise<FrameTimeResponse> {
    const schoolId = requireSchoolId(user);
    assertWindow(dto.startTime, dto.endTime);
    assertSpan(dto.minGradeLevel, dto.maxGradeLevel);

    try {
      const row = await this.prisma.withRls(user, (tx) =>
        tx.frameTime.create({
          data: {
            schoolId,
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
   * The stored row is read first, and the CHECKS RUN ON THE MERGE.
   *
   * Every field here is optional and every one can break an invariant the
   * payload does not mention: a PATCH carrying only `endTime` can put it before
   * a `startTime` it never sends, and one carrying only `minGradeLevel` can
   * push it past the stored max. Validating the payload alone passes both, and
   * the database CHECK then answers with a constraint-violation the admin
   * cannot act on. Same trap as the timplan's length-only PATCH, which skipped
   * its guard because the guard sat inside the date branch.
   */
  async update(
    id: string,
    dto: UpdateFrameTimeDto,
    user: AuthenticatedUser,
  ): Promise<FrameTimeResponse> {
    requireSchoolId(user);
    const current = await this.prisma.withRls(user, (tx) =>
      tx.frameTime.findUnique({ where: { id } }),
    );
    if (!current) {
      throw new NotFoundException(`Frame time ${id} not found.`);
    }

    assertWindow(dto.startTime ?? toWallClock(current.startTime), dto.endTime ?? toWallClock(current.endTime));
    assertSpan(dto.minGradeLevel ?? current.minGradeLevel, dto.maxGradeLevel ?? current.maxGradeLevel);

    try {
      const row = await this.prisma.withRls(user, (tx) =>
        tx.frameTime.update({
          where: { id },
          data: {
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
      await this.prisma.withRls(user, (tx) => tx.frameTime.delete({ where: { id } }));
    } catch (error) {
      rethrowPrismaError(error);
    }
  }
}

function toResponse(row: FrameTime): FrameTimeResponse {
  return {
    id: row.id,
    minGradeLevel: row.minGradeLevel,
    maxGradeLevel: row.maxGradeLevel,
    dayOfWeek: row.dayOfWeek,
    startTime: toWallClock(row.startTime),
    endTime: toWallClock(row.endTime),
  };
}

/**
 * A frame is a window, so it has to hold something.
 *
 * Compared as MINUTES, not as strings. The DTO's regex admits both HH:MM and
 * HH:MM:SS, and a lexical compare across the two lengths reads "09:00" as
 * before "09:00:30" — a thirty-second frame, accepted as a window. Minutes are
 * also the precision every other part of this app schedules in, so a row that
 * cannot be expressed on the grid should not be storable.
 */
function assertWindow(startTime: string, endTime: string): void {
  if (minutesOf(startTime) >= minutesOf(endTime)) {
    throw new BadRequestException('startTime must be before endTime.');
  }
}

/** "HH:MM" or "HH:MM:SS" -> minutes since midnight. Seconds are dropped, not
 *  rounded: the grid has no place to put them and silently moving a boundary
 *  is worse than ignoring a precision nobody can enter through the UI. */
function minutesOf(time: string): number {
  const [hours, minutes] = time.split(':');
  return Number(hours) * 60 + Number(minutes);
}

function assertSpan(minGradeLevel: number, maxGradeLevel: number): void {
  if (minGradeLevel > maxGradeLevel) {
    throw new BadRequestException('minGradeLevel must not be above maxGradeLevel.');
  }
}
