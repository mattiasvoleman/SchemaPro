import { Body, ConflictException, Controller, Get, Logger, Post, UseGuards } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import type { PrismaClient } from '@prisma/client';
import { Decides } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { RolesGuard } from '../auth/roles.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { requireSchoolId, requireUserId } from '../common/utils/request-context';
import { PrismaService } from '../database/prisma.service';
import { isLockTimeout } from '../publication/publish-mode';

/** A decision that waited its 5 s for the school's attendance writers holding the decisions lock (an SS12000 apply, a publication). */
export const ATTENDANCE_SHARING_BUSY = 'ATTENDANCE_SHARING_BUSY';

/**
 * Rektor's decision whether integrations may read pupils' attendance and
 * absence (SS12000 v2.0's /attendances and /absences, scopes
 * attendances.read and absences.read): AttendanceSharingDecisions,
 * migration 20261114090000. Append-only; the latest row is in force and no
 * row is not shared. A new decision, never an edit: the database stamps who
 * and when, and a key with the scope reads from the next request (or stops,
 * 403 NOT_SHARED).
 */
export class RecordAttendanceSharingDto {
  @IsBoolean({ message: 'shares must be true or false.' })
  shares!: boolean;

  /** The school's konsekvensbedömning or decision (dnr). */
  @IsOptional()
  @IsString()
  @Matches(/\S/, { message: 'reference must not be blank.' })
  @MaxLength(200)
  reference?: string;
}

export interface AttendanceSharingView {
  shares: boolean;
  reference: string | null;
  decidedAt: string;
  decidedBy: string | null;
}

/** The history a page shows: the latest decisions, newest first. */
export const ATTENDANCE_SHARING_HISTORY = 20;

@Controller('api/v1/integrations/attendance-sharing')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class AttendanceSharingController {
  private readonly logger = new Logger(AttendanceSharingController.name);

  constructor(private readonly prisma: PrismaService) {}

  /** The decision in force (null: never decided, not shared) and the history. */
  @Get()
  async get(@CurrentUser() user: AuthenticatedUser): Promise<{ current: AttendanceSharingView | null; history: AttendanceSharingView[] }> {
    requireSchoolId(user);
    return this.prisma.withRls(user, async (tx) => {
      const rows = await tx.attendanceSharingDecision.findMany({
        orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
        take: ATTENDANCE_SHARING_HISTORY,
        select: { shares: true, reference: true, decidedAt: true, decidedById: true },
      });
      const names = await namesOf(tx, rows.map((row) => row.decidedById));
      const history = rows.map((row) => view(row, names));
      return { current: history[0] ?? null, history };
    });
  }

  /** Rektor's (or a full administrator's): the decisions (Roller i skolan), as the arm asks too. */
  @Post()
  @Decides()
  async record(@Body() dto: RecordAttendanceSharingDto, @CurrentUser() user: AuthenticatedUser): Promise<AttendanceSharingView> {
    const schoolId = requireSchoolId(user);
    const userId = requireUserId(user);
    const reference = dto.reference?.trim() || null;
    try {
      return await this.prisma.withRls(user, async (tx) => {
        // The decider's name first (the database stamps the decider as the
        // caller): the insert takes the school's decisions lock, and holds it
        // only to the commit, while every writer of the school's attendance
        // versions as if it shared (app.attendance_recorded_as_shared).
        const names = await namesOf(tx, [userId]);
        const row = await tx.attendanceSharingDecision.create({
          data: { schoolId, shares: dto.shares, reference },
          select: { shares: true, reference: true, decidedAt: true, decidedById: true },
        });
        this.logger.log(`Attendance sharing decided [shares=${row.shares}]`);
        return view(row, names);
      });
    } catch (error) {
      // A decision waits at most 5 s for every writer of the school's
      // attendance that took the decisions lock before it, whatever it read
      // (app.attendance_sharing_decisions_are_stamped): an SS12000 apply or a
      // publication can hold it for minutes. A register save never waits for
      // the decision, and a removal only while it is being written or waits
      // to be; the decision is the one refused, and is made again in a moment.
      if (isLockTimeout(error)) {
        throw new ConflictException({
          message: 'Skolans närvaro eller elever ändras just nu. Beslutet sparades inte. Försök igen om en stund.',
          code: ATTENDANCE_SHARING_BUSY,
        });
      }
      throw error;
    }
  }
}

function view(
  row: { shares: boolean; reference: string | null; decidedAt: Date; decidedById: string | null },
  names: ReadonlyMap<string, string>,
): AttendanceSharingView {
  return {
    shares: row.shares,
    reference: row.reference,
    decidedAt: row.decidedAt.toISOString(),
    decidedBy: row.decidedById ? (names.get(row.decidedById) ?? null) : null,
  };
}

/** The deciders' names: the school's own administrators, as a decision record names them. */
async function namesOf(tx: PrismaClient, ids: ReadonlyArray<string | null>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))];
  if (unique.length === 0) return new Map();
  const people = await tx.user.findMany({ where: { id: { in: unique } }, select: { id: true, firstName: true, lastName: true } });
  return new Map(people.map((person) => [person.id, `${person.firstName} ${person.lastName}`]));
}
