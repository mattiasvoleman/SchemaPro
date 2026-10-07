import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, TeacherDuty } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Role } from '../auth/enums/role.enum';
import { PrismaService } from '../database/prisma.service';
import { SLOT_MINUTES, minutesOf } from '../common/solver-grid';
import { requireSchoolId, requireUserId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import { toWallClock } from '../common/utils/time';
import { DUTY_SLOT_REASON, dutySlotConstraintData, dutySlotTimes, slotGridFault } from './duty-slot';
import { lockStaffRow } from './staff-lock';
import type {
  CreateTeacherDutyDto,
  TeacherDutySlotDto,
  UpdateTeacherDutyDto,
} from './dto/teacher-duty.dto';

/** The weekly time an uppdrag blocks, as the client wrote it and reads it back. */
export interface TeacherDutySlot {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

/**
 * An uppdrag as the client sees it: the row, and its blocked time read back
 * from the linked constraint rather than stored twice. `blockedConstraintId`
 * stays in the answer so a constraint list can say "held by an uppdrag"; it
 * is never accepted in a body.
 */
export interface TeacherDutyResponse extends TeacherDuty {
  blockedSlot: TeacherDutySlot | null;
}

const WITH_SLOT = {
  blockedConstraint: { select: { dayOfWeek: true, startTime: true, endTime: true } },
} as const;

type DutyWithSlot = Prisma.TeacherDutyGetPayload<{ include: typeof WITH_SLOT }>;

function toResponse(row: DutyWithSlot): TeacherDutyResponse {
  const { blockedConstraint, ...duty } = row;
  return {
    ...duty,
    // A constraint RLS hides (none should be: it is the teacher's own) or a
    // weekday-less one (the trigger refuses those) reads as no slot rather
    // than as a half-filled one.
    blockedSlot:
      blockedConstraint && blockedConstraint.dayOfWeek !== null
        ? {
            dayOfWeek: blockedConstraint.dayOfWeek,
            startTime: toWallClock(blockedConstraint.startTime),
            endTime: toWallClock(blockedConstraint.endTime),
          }
        : null,
  };
}

/**
 * A slot the solver can hold: whole minutes, on its five-minute grid, start
 * before end. Checked before a transaction is opened — it needs nothing from
 * the database — and in Swedish, naming the field, as the rest of this route
 * answers.
 */
export function assertDutySlot(slot: TeacherDutySlotDto): void {
  const fault = slotGridFault(slot);
  if (!fault) return;
  if (fault.kind === 'SECONDS') {
    throw new BadRequestException(
      `blockedSlot.${fault.field}: anges i hela minuter — schemat räknar inte sekunder.`,
    );
  }
  if (fault.kind === 'OFF_GRID') {
    const value = slot[fault.field];
    const below = Math.floor(minutesOf(value) / SLOT_MINUTES) * SLOT_MINUTES;
    const clock = (minutes: number) =>
      `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
    throw new BadRequestException(
      `blockedSlot.${fault.field}: ${value.slice(0, 5)} ligger inte på schemats ${SLOT_MINUTES}-minutersrutnät. Närmast är ${clock(below)} eller ${clock(below + SLOT_MINUTES)}.`,
    );
  }
  throw new BadRequestException(
    `blockedSlot: starttiden (${slot.startTime.slice(0, 5)}) måste ligga före sluttiden (${slot.endTime.slice(0, 5)}).`,
  );
}

/** Kept here for the callers that import it with the service; see duty-slot.ts. */
export { DUTY_SLOT_REASON };

/**
 * Lärarnas uppdrag: mentorskap, ämnesansvar, rastvakt, APT — the part of a
 * tjänst that is not a timplanspost.
 *
 * ONE WRITER, AS FOR THE POST. An admin writes uppdrag; a teacher reads their
 * own and no colleague's — teacher_duties_teacher_own_select says so for every
 * door, and the list below filters the same way so the gateway and RLS agree.
 * A teacher naming a colleague in the query gets a 403 rather than a quietly
 * emptier list: the question itself is one they may not ask.
 *
 * A FIXED TIME IS A CONSTRAINT THE SERVICE OWNS. `blockedSlot` becomes one
 * UNAVAILABLE TEACHER AvailabilityConstraint on that weekday, created,
 * moved and deleted in the SAME transaction as the duty, so the timetable
 * never holds a rastvakt slot without its uppdrag or the reverse. The
 * client never names the constraint. The database checks the link as well
 * (TeacherDuties_block_is_the_teachers): what this service writes always
 * passes it, and a PostgREST writer that points the link elsewhere does not.
 *
 * THE DUTY ROW IS LOCKED before a slot is touched. Two PATCHes adding a time
 * to a duty that has none would otherwise both read "no constraint", both
 * create one, and the loser's link would be overwritten — an UNAVAILABLE
 * row blocking the teacher for an uppdrag nobody can see. FOR NO KEY UPDATE,
 * as everywhere a row is locked to be written without changing its key.
 */
@Injectable()
export class TeacherDutiesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    academicYearId: string,
    userId: string | undefined,
    user: AuthenticatedUser,
  ): Promise<TeacherDutyResponse[]> {
    requireSchoolId(user);
    let where: Prisma.TeacherDutyWhereInput;
    if (user.role === Role.SCHOOL_ADMIN) {
      where = userId ? { academicYearId, userId } : { academicYearId };
    } else {
      const own = requireUserId(user);
      if (userId && userId !== own) {
        throw new ForbiddenException('Du kan bara läsa dina egna uppdrag.');
      }
      // Duplicates the RLS arm on purpose, as the employments list does.
      where = { academicYearId, userId: own };
    }
    const rows = await this.prisma.withRls(user, (tx) =>
      tx.teacherDuty.findMany({
        where,
        include: WITH_SLOT,
        orderBy: [{ userId: 'asc' }, { kind: 'asc' }, { label: 'asc' }],
      }),
    );
    return rows.map(toResponse);
  }

  async create(dto: CreateTeacherDutyDto, user: AuthenticatedUser): Promise<TeacherDutyResponse> {
    const schoolId = requireSchoolId(user);
    const slot = dto.blockedSlot ?? null;
    if (slot) assertDutySlot(slot);

    try {
      const row = await this.prisma.withRls(user, async (tx) => {
        // The person is staff, and stays staff until this commits: the role
        // PATCH reads the same row under the same lock.
        await lockStaffRow(tx, dto.userId, 'uppdrag');
        const constraint = slot
          ? await tx.availabilityConstraint.create({
              data: dutySlotConstraintData(schoolId, dto.userId, slot),
              select: { id: true },
            })
          : null;
        return tx.teacherDuty.create({
          data: {
            schoolId,
            userId: dto.userId,
            academicYearId: dto.academicYearId,
            kind: dto.kind,
            label: dto.label.trim(),
            minutesPerWeek: dto.minutesPerWeek,
            countsAsTeaching: dto.countsAsTeaching ?? false,
            subjectId: dto.subjectId ?? null,
            studentGroupId: dto.studentGroupId ?? null,
            blockedConstraintId: constraint?.id ?? null,
            note: dto.note?.trim() || null,
          },
          include: WITH_SLOT,
        });
      });
      return toResponse(row);
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  async update(
    id: string,
    dto: UpdateTeacherDutyDto,
    user: AuthenticatedUser,
  ): Promise<TeacherDutyResponse> {
    const schoolId = requireSchoolId(user);
    if (dto.blockedSlot) assertDutySlot(dto.blockedSlot);

    try {
      const row = await this.prisma.withRls(user, async (tx) => {
        const current = await lockDuty(tx, id);
        // Another school's row is invisible under RLS and reads as missing,
        // which is the 404 the update itself would give.
        if (!current) throw new NotFoundException('The requested record does not exist.');

        let blockedConstraintId = current.blockedConstraintId;
        let dropConstraint: string | null = null;
        const label = dto.label !== undefined ? dto.label.trim() : current.label;

        if (dto.blockedSlot === null) {
          dropConstraint = current.blockedConstraintId;
          blockedConstraintId = null;
        } else if (dto.blockedSlot) {
          if (current.blockedConstraintId) {
            await tx.availabilityConstraint.update({
              where: { id: current.blockedConstraintId },
              data: { ...dutySlotTimes(dto.blockedSlot), reason: DUTY_SLOT_REASON },
              select: { id: true },
            });
          } else {
            const created = await tx.availabilityConstraint.create({
              data: dutySlotConstraintData(schoolId, current.userId, dto.blockedSlot),
              select: { id: true },
            });
            blockedConstraintId = created.id;
          }
        }

        const updated = await tx.teacherDuty.update({
          where: { id },
          data: {
            ...(dto.kind !== undefined ? { kind: dto.kind } : {}),
            ...(dto.label !== undefined ? { label } : {}),
            ...(dto.minutesPerWeek !== undefined ? { minutesPerWeek: dto.minutesPerWeek } : {}),
            ...(dto.countsAsTeaching !== undefined
              ? { countsAsTeaching: dto.countsAsTeaching }
              : {}),
            ...(dto.subjectId !== undefined ? { subjectId: dto.subjectId } : {}),
            ...(dto.studentGroupId !== undefined ? { studentGroupId: dto.studentGroupId } : {}),
            ...(dto.note !== undefined ? { note: dto.note?.trim() || null } : {}),
            ...(blockedConstraintId !== current.blockedConstraintId ? { blockedConstraintId } : {}),
          },
          include: WITH_SLOT,
        });
        // Unlinked first, deleted second: the constraint's own trigger has
        // nothing to say about a row no duty holds any more.
        if (dropConstraint) {
          await tx.availabilityConstraint.deleteMany({ where: { id: dropConstraint } });
        }
        return updated;
      });
      return toResponse(row);
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  /** Deletes the uppdrag and the time it blocked, in one transaction. */
  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    requireSchoolId(user);
    try {
      await this.prisma.withRls(user, async (tx) => {
        const current = await lockDuty(tx, id);
        if (!current) throw new NotFoundException('The requested record does not exist.');
        await tx.teacherDuty.delete({ where: { id } });
        if (current.blockedConstraintId) {
          // TeacherDuties_take_their_block has already deleted it with the
          // duty; this says so in the code that owns the pair, and costs a
          // statement that finds nothing. deleteMany, so a count of 0 is no
          // reason to fail the delete asked for.
          await tx.availabilityConstraint.deleteMany({ where: { id: current.blockedConstraintId } });
        }
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }
}

/**
 * The duty row, read under a row lock in the transaction that writes it or its
 * slot. Raw SQL because Prisma has no locking read; under RLS the lock also
 * needs the UPDATE policy, which only teacher_duties_admin_all grants, so a
 * row the caller may not write reads as missing.
 */
async function lockDuty(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<Pick<TeacherDuty, 'id' | 'userId' | 'label' | 'blockedConstraintId'> | undefined> {
  const [row] = await tx.$queryRaw<
    Pick<TeacherDuty, 'id' | 'userId' | 'label' | 'blockedConstraintId'>[]
  >`
    SELECT "id", "userId", "label", "blockedConstraintId"
    FROM "TeacherDuties"
    WHERE "id" = ${id}::uuid
    FOR NO KEY UPDATE
  `;
  return row;
}
