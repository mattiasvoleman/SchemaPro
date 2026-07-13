import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Role } from '../auth/enums/role.enum';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import type { ReportAttendanceDto } from './dto/report-attendance.dto';

export interface AttendanceReportResult {
  created: number;
  updated: number;
}

/**
 * Processes batched attendance reports from mobile devices.
 *
 * ## Authorization
 *
 * The service performs an explicit teacher-assignment check in addition to
 * RLS. While RLS (`attendance_teacher_insert` / `attendance_teacher_update`)
 * would ultimately reject unauthorized writes at the database level, failing
 * fast here keeps error messages clear and avoids wasted round-trips.
 *
 * ## Rate limiting
 *
 * Throttling is handled at the controller layer via `@nestjs/throttler` to
 * protect the endpoint during high-concurrency morning check-in peaks.
 */
@Injectable()
export class AttendanceService {
  private readonly logger = new Logger(AttendanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async reportAttendance(
    dto: ReportAttendanceDto,
    user: AuthenticatedUser,
  ): Promise<AttendanceReportResult> {
    return this.prisma.withRls(user, async (tx) => {
      // Verify the lesson exists (RLS will scope this to the caller's school).
      const lesson = await tx.calendarLesson.findUnique({
        where: { id: dto.calendarLessonId },
        select: {
          id: true,
          schoolId: true,
          date: true,
          startsAt: true,
          endsAt: true,
          subject: { select: { name: true } },
        },
      });

      if (!lesson) {
        throw new NotFoundException(
          `Calendar lesson not found: ${dto.calendarLessonId}`,
        );
      }

      // For teachers: verify they are explicitly assigned to this lesson.
      // SCHOOL_ADMIN is trusted to record for any lesson in their school.
      if (user.role === Role.TEACHER) {
        await this.assertTeacherIsAssigned(
          tx,
          dto.calendarLessonId,
          user,
        );
      }

      let created = 0;
      let updated = 0;

      const now = new Date();
      const recordedById = user.userId ?? null;

      // Use upsert for idempotency — mobile devices may re-send if the first
      // attempt was lost while offline.
      for (const entry of dto.records) {
        const result = await tx.attendanceRecord.upsert({
          where: {
            calendarLessonId_studentId: {
              calendarLessonId: dto.calendarLessonId,
              studentId: entry.studentId,
            },
          },
          create: {
            schoolId: lesson.schoolId,
            calendarLessonId: dto.calendarLessonId,
            studentId: entry.studentId,
            status: entry.status,
            recordedById,
            recordedAt: now,
            note: entry.note ?? null,
          },
          update: {
            status: entry.status,
            recordedById,
            recordedAt: now,
            note: entry.note ?? null,
          },
          select: { createdAt: true, updatedAt: true },
        });

        // Prisma upsert doesn't distinguish create vs update, so compare timestamps.
        const wasCreated =
          result.createdAt.getTime() === result.updatedAt.getTime();
        if (wasCreated) {
          created++;
        } else {
          updated++;
        }
      }

      this.logger.log(
        `Attendance reported [lesson=${dto.calendarLessonId}, created=${created}, updated=${updated}]`,
      );

      // Skola24-style guardian alert: a student was marked ABSENT without a
      // prior absence report covering this lesson.
      const absentIds = dto.records
        .filter((entry) => entry.status === 'ABSENT')
        .map((entry) => entry.studentId);
      if (absentIds.length > 0) {
        const reports = await tx.absenceReport.findMany({
          where: { studentId: { in: absentIds }, date: lesson.date },
          select: { studentId: true, startTime: true, endTime: true },
        });
        const lessonStartMin =
          lesson.startsAt.getUTCHours() * 60 + lesson.startsAt.getUTCMinutes();
        const lessonEndMin =
          lesson.endsAt.getUTCHours() * 60 + lesson.endsAt.getUTCMinutes();
        const covered = new Set(
          reports
            .filter((report) => {
              if (!report.startTime || !report.endTime) return true; // full day
              const start =
                report.startTime.getUTCHours() * 60 +
                report.startTime.getUTCMinutes();
              const end =
                report.endTime.getUTCHours() * 60 + report.endTime.getUTCMinutes();
              return start < lessonEndMin && lessonStartMin < end;
            })
            .map((report) => report.studentId),
        );
        const unreported = absentIds.filter((studentId) => !covered.has(studentId));
        if (unreported.length > 0) {
          const students = await tx.user.findMany({
            where: { id: { in: unreported } },
            select: { id: true, firstName: true, lastName: true },
          });
          for (const student of students) {
            const guardianIds = await this.notifications.guardiansOf(tx, [student.id]);
            if (guardianIds.length === 0) continue;
            const studentName = `${student.firstName} ${student.lastName}`;
            await this.notifications.notifyUsers(tx, {
              schoolId: lesson.schoolId,
              userIds: guardianIds,
              type: 'ABSENCE_UNREPORTED',
              meta: {
                studentName,
                subjectName: lesson.subject.name,
                date: lesson.date.toISOString().slice(0, 10),
              },
              email: {
                subject: 'Unreported absence / Oanmäld frånvaro',
                body:
                  `${studentName} was marked absent from ${lesson.subject.name} on ` +
                  `${lesson.date.toISOString().slice(0, 10)} without a prior absence report.\n\n` +
                  `${studentName} markerades frånvarande från ${lesson.subject.name} den ` +
                  `${lesson.date.toISOString().slice(0, 10)} utan föranmäld frånvaro.`,
              },
            });
          }
        }
      }

      return { created, updated };
    });
  }

  // ---------------------------------------------------------------------------

  private async assertTeacherIsAssigned(
    tx: Prisma.TransactionClient,
    calendarLessonId: string,
    user: AuthenticatedUser,
  ): Promise<void> {
    if (!user.userId) {
      throw new ForbiddenException(
        'Teacher userId is missing from the authentication token.',
      );
    }

    const assignment = await tx.calendarLessonTeacher.findUnique({
      where: {
        calendarLessonId_teacherId: {
          calendarLessonId,
          teacherId: user.userId,
        },
      },
      select: { id: true },
    });

    if (!assignment) {
      throw new ForbiddenException(
        'You are not assigned to this lesson and cannot record attendance for it.',
      );
    }
  }
}
