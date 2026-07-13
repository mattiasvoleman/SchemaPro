import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Role } from '../auth/enums/role.enum';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { parseTimeString } from '../common/utils/time';
import type {
  CreateAbsenceReportDto,
  CreateGuardianLinkDto,
  CreateLeaveRequestDto,
  DecideLeaveRequestDto,
} from './dto/family.dto';

/**
 * Guardian↔student links, guardian/adult-student absence reporting, and
 * leave requests (ledighetsansökan) with admin decisions.
 *
 * RLS enforces every access path at the database level; the service adds
 * friendly validation (role checks, guardianship checks, date sanity) so the
 * UI gets useful errors instead of empty RLS results.
 */
@Injectable()
export class FamilyService {
  private readonly logger = new Logger(FamilyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------------------------------------------------------------------
  // Guardian links (admin)
  // ---------------------------------------------------------------------

  async createLink(dto: CreateGuardianLinkDto, user: AuthenticatedUser) {
    return this.prisma.withRls(user, async (tx) => {
      const [guardian, student] = await Promise.all([
        tx.user.findUnique({
          where: { id: dto.guardianId },
          select: { id: true, role: true, schoolId: true },
        }),
        tx.user.findUnique({
          where: { id: dto.studentId },
          select: { id: true, role: true, schoolId: true },
        }),
      ]);
      if (!guardian || guardian.role !== 'GUARDIAN') {
        throw new BadRequestException('guardianId must reference a GUARDIAN user.');
      }
      if (!student || student.role !== 'STUDENT') {
        throw new BadRequestException('studentId must reference a STUDENT user.');
      }
      if (guardian.schoolId !== student.schoolId) {
        throw new BadRequestException('Guardian and student belong to different schools.');
      }

      const link = await tx.guardianStudent.upsert({
        where: {
          guardianId_studentId: {
            guardianId: dto.guardianId,
            studentId: dto.studentId,
          },
        },
        create: {
          schoolId: student.schoolId,
          guardianId: dto.guardianId,
          studentId: dto.studentId,
        },
        update: {},
        select: { id: true, guardianId: true, studentId: true },
      });
      this.logger.log(`Guardian link ensured [link=${link.id}]`);
      return link;
    });
  }

  async removeLink(id: string, user: AuthenticatedUser) {
    return this.prisma.withRls(user, async (tx) => {
      const link = await tx.guardianStudent.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!link) throw new NotFoundException('Guardian link not found.');
      await tx.guardianStudent.delete({ where: { id } });
      return { id };
    });
  }

  // ---------------------------------------------------------------------
  // Absence reports (guardian or adult student)
  // ---------------------------------------------------------------------

  async createAbsenceReport(dto: CreateAbsenceReportDto, user: AuthenticatedUser) {
    if ((dto.startTime === undefined) !== (dto.endTime === undefined)) {
      throw new BadRequestException(
        'startTime and endTime must be provided together (omit both for full day).',
      );
    }
    return this.prisma.withRls(user, async (tx) => {
      await this.assertMayActForStudent(tx, dto.studentId, user);
      const schoolId = await this.schoolIdOf(tx, dto.studentId);

      const report = await tx.absenceReport.create({
        data: {
          schoolId,
          studentId: dto.studentId,
          reportedById: user.userId as string,
          date: new Date(`${dto.date}T00:00:00.000Z`),
          startTime: dto.startTime ? parseTimeString(dto.startTime) : null,
          endTime: dto.endTime ? parseTimeString(dto.endTime) : null,
          type: dto.type,
          note: dto.note ?? null,
        },
        select: { id: true, studentId: true, date: true },
      });
      this.logger.log(`Absence reported [report=${report.id}]`);
      return report;
    });
  }

  async removeAbsenceReport(id: string, user: AuthenticatedUser) {
    return this.prisma.withRls(user, async (tx) => {
      const report = await tx.absenceReport.findUnique({
        where: { id },
        select: { id: true, reportedById: true, date: true },
      });
      if (!report) throw new NotFoundException('Absence report not found.');
      if (
        user.role !== Role.SCHOOL_ADMIN &&
        report.reportedById !== user.userId
      ) {
        throw new ForbiddenException('Only the reporter may remove this report.');
      }
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      if (report.date < today) {
        throw new BadRequestException('Past absence reports cannot be removed.');
      }
      await tx.absenceReport.delete({ where: { id } });
      return { id };
    });
  }

  // ---------------------------------------------------------------------
  // Leave requests
  // ---------------------------------------------------------------------

  async createLeaveRequest(dto: CreateLeaveRequestDto, user: AuthenticatedUser) {
    if (dto.endDate < dto.startDate) {
      throw new BadRequestException('endDate must not be before startDate.');
    }
    return this.prisma.withRls(user, async (tx) => {
      await this.assertMayActForStudent(tx, dto.studentId, user);
      const schoolId = await this.schoolIdOf(tx, dto.studentId);

      const request = await tx.leaveRequest.create({
        data: {
          schoolId,
          studentId: dto.studentId,
          requestedById: user.userId as string,
          startDate: new Date(`${dto.startDate}T00:00:00.000Z`),
          endDate: new Date(`${dto.endDate}T00:00:00.000Z`),
          reason: dto.reason,
        },
        select: { id: true, studentId: true, status: true },
      });
      this.logger.log(`Leave requested [request=${request.id}]`);
      return request;
    });
  }

  /**
   * Admin decision. Approval automatically creates full-day absence reports
   * for every date in the range, so teachers see the leave in attendance.
   */
  async decideLeaveRequest(
    id: string,
    dto: DecideLeaveRequestDto,
    user: AuthenticatedUser,
  ) {
    return this.prisma.withRls(user, async (tx) => {
      const request = await tx.leaveRequest.findUnique({
        where: { id },
        select: {
          id: true,
          schoolId: true,
          studentId: true,
          requestedById: true,
          startDate: true,
          endDate: true,
          status: true,
          student: { select: { firstName: true, lastName: true } },
        },
      });
      if (!request) throw new NotFoundException('Leave request not found.');
      if (request.status !== 'PENDING') {
        throw new BadRequestException('Leave request is already decided.');
      }

      const updated = await tx.leaveRequest.update({
        where: { id },
        data: {
          status: dto.status,
          decidedById: user.userId ?? null,
          decidedAt: new Date(),
          decisionNote: dto.note ?? null,
        },
        select: { id: true, status: true },
      });

      let absenceDays = 0;
      if (dto.status === 'APPROVED') {
        const cursor = new Date(request.startDate);
        while (cursor <= request.endDate) {
          await tx.absenceReport.create({
            data: {
              schoolId: request.schoolId,
              studentId: request.studentId,
              reportedById: user.userId as string,
              date: new Date(cursor),
              type: 'OTHER',
              note: 'Approved leave',
            },
          });
          absenceDays++;
          cursor.setUTCDate(cursor.getUTCDate() + 1);
        }
      }

      const studentName = `${request.student.firstName} ${request.student.lastName}`;
      const range = `${request.startDate.toISOString().slice(0, 10)} – ${request.endDate
        .toISOString()
        .slice(0, 10)}`;
      await this.notifications.notifyUsers(tx, {
        schoolId: request.schoolId,
        userIds: [request.requestedById],
        type: 'LEAVE_DECIDED',
        meta: {
          status: dto.status,
          studentName,
          startDate: request.startDate.toISOString().slice(0, 10),
          endDate: request.endDate.toISOString().slice(0, 10),
          note: dto.note ?? null,
        },
        email: {
          subject: `Leave request ${dto.status === 'APPROVED' ? 'approved' : 'rejected'} / Ledighetsansökan ${dto.status === 'APPROVED' ? 'beviljad' : 'avslagen'}`,
          body:
            `Leave request for ${studentName} (${range}) was ${dto.status.toLowerCase()}.` +
            (dto.note ? `\nNote: ${dto.note}` : '') +
            `\n\nLedighetsansökan för ${studentName} (${range}) ${dto.status === 'APPROVED' ? 'beviljades' : 'avslogs'}.`,
        },
      });

      this.logger.log(
        `Leave request decided [request=${id}, status=${dto.status}, absenceDays=${absenceDays}]`,
      );
      return { ...updated, absenceDays };
    });
  }

  // ---------------------------------------------------------------------

  /** Guardians act for linked children; students for themselves; admins for anyone. */
  private async assertMayActForStudent(
    tx: PrismaClient,
    studentId: string,
    user: AuthenticatedUser,
  ): Promise<void> {
    if (user.role === Role.SCHOOL_ADMIN) return;
    if (user.role === Role.STUDENT) {
      if (user.userId !== studentId) {
        throw new ForbiddenException('Students may only report for themselves.');
      }
      return;
    }
    if (user.role === Role.GUARDIAN) {
      const link = await tx.guardianStudent.findFirst({
        where: { guardianId: user.userId, studentId },
        select: { id: true },
      });
      if (!link) {
        throw new ForbiddenException('Not a guardian of this student.');
      }
      return;
    }
    throw new ForbiddenException('This role cannot report absences.');
  }

  private async schoolIdOf(tx: PrismaClient, studentId: string): Promise<string> {
    const student = await tx.user.findUnique({
      where: { id: studentId },
      select: { schoolId: true },
    });
    if (!student) throw new NotFoundException('Student not found.');
    return student.schoolId;
  }
}
