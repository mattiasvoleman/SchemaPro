import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { parseTimeString, zonedTimeToUtc } from '../common/utils/time';
import type { UpdateMasterLessonDto } from './dto/update-master-lesson.dto';

export interface MasterLessonConflict {
  kind: 'TEACHER' | 'ROOM' | 'GROUP' | 'AVAILABILITY';
  message: string;
  /** The other master lesson involved, when applicable. */
  masterLessonId?: string;
}

export interface UpdateMasterLessonResult {
  id: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  roomId: string | null;
  teacherId: string | null;
  /** Future calendar lessons that were moved along with the template. */
  propagatedLessons: number;
}

/**
 * Manual adjustments to the master timetable after (or instead of) AI
 * generation. Every change is validated against the rest of the timetable so
 * an admin cannot introduce a double-booking by hand:
 *
 * - the teacher must not teach another lesson in the same slot,
 * - the room must not host another lesson in the same slot,
 * - the student group must not have another lesson in the same slot,
 * - weekly `UNAVAILABLE` constraints for the teacher/room/group must not
 *   cover the slot.
 *
 * On conflict the request fails with 409 and a machine-readable conflict
 * list so the UI can show exactly what collided.
 */
@Injectable()
export class MasterLessonsService {
  private readonly logger = new Logger(MasterLessonsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async update(
    id: string,
    dto: UpdateMasterLessonDto,
    user: AuthenticatedUser,
  ): Promise<UpdateMasterLessonResult> {
    return this.prisma.withRls(user, async (tx) => {
      const lesson = await tx.masterLesson.findUnique({
        where: { id },
        select: {
          id: true,
          academicYearId: true,
          subjectId: true,
          studentGroupId: true,
          teacherId: true,
          roomId: true,
          dayOfWeek: true,
          startTime: true,
          endTime: true,
          school: { select: { id: true, timezone: true } },
        },
      });
      if (!lesson) {
        throw new NotFoundException('Master lesson not found.');
      }

      // Merge the patch onto the current slot.
      const candidate = {
        dayOfWeek: dto.dayOfWeek ?? lesson.dayOfWeek,
        startMinutes:
          dto.startTime !== undefined
            ? toMinutes(parseTimeString(dto.startTime))
            : toMinutes(lesson.startTime),
        endMinutes:
          dto.endTime !== undefined
            ? toMinutes(parseTimeString(dto.endTime))
            : toMinutes(lesson.endTime),
        teacherId: dto.teacherId !== undefined ? dto.teacherId : lesson.teacherId,
        roomId: dto.roomId !== undefined ? dto.roomId : lesson.roomId,
      };
      if (candidate.startMinutes >= candidate.endMinutes) {
        throw new BadRequestException('startTime must be before endTime.');
      }

      const conflicts = await this.findConflicts(tx, lesson, candidate);
      if (conflicts.length > 0) {
        // The exception filter forwards `message` as the problem detail, so
        // the conflict list is folded into it for the UI to display.
        const unique = [...new Set(conflicts.map((conflict) => conflict.message))];
        throw new ConflictException(unique.join(' '));
      }

      const updated = await tx.masterLesson.update({
        where: { id },
        data: {
          dayOfWeek: candidate.dayOfWeek,
          ...(dto.startTime !== undefined
            ? { startTime: parseTimeString(dto.startTime) }
            : {}),
          ...(dto.endTime !== undefined
            ? { endTime: parseTimeString(dto.endTime) }
            : {}),
          ...(dto.roomId !== undefined ? { roomId: dto.roomId } : {}),
          ...(dto.teacherId !== undefined ? { teacherId: dto.teacherId } : {}),
        },
        select: {
          id: true,
          dayOfWeek: true,
          startTime: true,
          endTime: true,
          roomId: true,
          teacherId: true,
        },
      });

      const propagatedLessons =
        dto.propagate === false
          ? 0
          : await this.propagate(tx, lesson, updated, lesson.school.timezone, lesson.school.id);

      this.logger.log(
        `Master lesson adjusted [lesson=${id}, propagated=${propagatedLessons}]`,
      );

      return {
        id: updated.id,
        dayOfWeek: updated.dayOfWeek,
        startTime: toHHMM(updated.startTime),
        endTime: toHHMM(updated.endTime),
        roomId: updated.roomId,
        teacherId: updated.teacherId,
        propagatedLessons,
      };
    });
  }

  // ---------------------------------------------------------------------
  // Conflict detection
  // ---------------------------------------------------------------------

  private async findConflicts(
    tx: PrismaClient,
    lesson: {
      id: string;
      academicYearId: string;
      studentGroupId: string;
    },
    candidate: {
      dayOfWeek: number;
      startMinutes: number;
      endMinutes: number;
      teacherId: string | null;
      roomId: string | null;
    },
  ): Promise<MasterLessonConflict[]> {
    const conflicts: MasterLessonConflict[] = [];

    const sameDay = await tx.masterLesson.findMany({
      where: {
        academicYearId: lesson.academicYearId,
        dayOfWeek: candidate.dayOfWeek,
        id: { not: lesson.id },
      },
      select: {
        id: true,
        teacherId: true,
        roomId: true,
        studentGroupId: true,
        startTime: true,
        endTime: true,
        subject: { select: { name: true } },
      },
    });

    for (const other of sameDay) {
      const overlaps =
        toMinutes(other.startTime) < candidate.endMinutes &&
        candidate.startMinutes < toMinutes(other.endTime);
      if (!overlaps) continue;

      if (candidate.teacherId && other.teacherId === candidate.teacherId) {
        conflicts.push({
          kind: 'TEACHER',
          message: `Teacher already teaches ${other.subject.name} in this slot.`,
          masterLessonId: other.id,
        });
      }
      if (candidate.roomId && other.roomId === candidate.roomId) {
        conflicts.push({
          kind: 'ROOM',
          message: `Room is already booked for ${other.subject.name} in this slot.`,
          masterLessonId: other.id,
        });
      }
      if (other.studentGroupId === lesson.studentGroupId) {
        conflicts.push({
          kind: 'GROUP',
          message: `The group already has ${other.subject.name} in this slot.`,
          masterLessonId: other.id,
        });
      }
    }

    // Weekly (recurring) unavailability for the involved resources.
    const constraints = await tx.availabilityConstraint.findMany({
      where: {
        type: 'UNAVAILABLE',
        dayOfWeek: candidate.dayOfWeek,
        date: null,
        OR: [
          ...(candidate.teacherId
            ? [{ resourceType: 'TEACHER' as const, userId: candidate.teacherId }]
            : []),
          ...(candidate.roomId
            ? [{ resourceType: 'ROOM' as const, roomId: candidate.roomId }]
            : []),
          {
            resourceType: 'STUDENT_GROUP' as const,
            studentGroupId: lesson.studentGroupId,
          },
        ],
      },
      select: { resourceType: true, startTime: true, endTime: true },
    });

    for (const constraint of constraints) {
      const overlaps =
        toMinutes(constraint.startTime) < candidate.endMinutes &&
        candidate.startMinutes < toMinutes(constraint.endTime);
      if (!overlaps) continue;

      const label =
        constraint.resourceType === 'TEACHER'
          ? 'The teacher is unavailable in this slot.'
          : constraint.resourceType === 'ROOM'
            ? 'The room is unavailable in this slot.'
            : 'The student group is unavailable in this slot.';
      conflicts.push({ kind: 'AVAILABILITY', message: label });
    }

    return conflicts;
  }

  // ---------------------------------------------------------------------
  // Propagation to materialized calendar lessons
  // ---------------------------------------------------------------------

  /**
   * Moves future, still-SCHEDULED calendar lessons that were materialized
   * from this template and carry no attendance yet. Lessons in the past or
   * with attendance are left untouched (history must stay accurate).
   */
  private async propagate(
    tx: PrismaClient,
    before: { id: string; dayOfWeek: number; teacherId: string | null },
    after: {
      dayOfWeek: number;
      startTime: Date;
      endTime: Date;
      roomId: string | null;
      teacherId: string | null;
    },
    timezone: string,
    schoolId: string,
  ): Promise<number> {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const futureLessons = await tx.calendarLesson.findMany({
      where: {
        masterLessonId: before.id,
        status: 'SCHEDULED',
        date: { gte: today },
        attendanceRecords: { none: {} },
      },
      select: { id: true, date: true },
    });

    const dayShift = after.dayOfWeek - before.dayOfWeek;
    const startHHMM = toHHMM(after.startTime);
    const endHHMM = toHHMM(after.endTime);

    for (const calendarLesson of futureLessons) {
      const newDate = new Date(calendarLesson.date);
      newDate.setUTCDate(newDate.getUTCDate() + dayShift);
      const dateString = newDate.toISOString().slice(0, 10);

      await tx.calendarLesson.update({
        where: { id: calendarLesson.id },
        data: {
          date: newDate,
          startsAt: zonedTimeToUtc(dateString, startHHMM, timezone),
          endsAt: zonedTimeToUtc(dateString, endHHMM, timezone),
          roomId: after.roomId,
        },
      });

      // Keep the LEAD teacher assignment in sync with the template.
      if (after.teacherId !== before.teacherId) {
        await tx.calendarLessonTeacher.deleteMany({
          where: { calendarLessonId: calendarLesson.id, role: 'LEAD' },
        });
        if (after.teacherId) {
          await tx.calendarLessonTeacher.create({
            data: {
              schoolId,
              calendarLessonId: calendarLesson.id,
              teacherId: after.teacherId,
              role: 'LEAD',
            },
          });
        }
      }
    }

    return futureLessons.length;
  }
}

// ---------------------------------------------------------------------------

function toMinutes(time: Date): number {
  return time.getUTCHours() * 60 + time.getUTCMinutes();
}

function toHHMM(time: Date): string {
  const h = time.getUTCHours().toString().padStart(2, '0');
  const m = time.getUTCMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}
