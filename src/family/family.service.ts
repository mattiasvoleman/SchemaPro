import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { Role } from '../auth/enums/role.enum';
import { PrismaService } from '../database/prisma.service';
import { requireUserId } from '../common/utils/request-context';
import { parseTimeString } from '../common/utils/time';
import type { CreateAbsenceReportDto, CreateGuardianLinkDto } from './dto/family.dto';
import { assertMayActForStudent, schoolIdOf } from './family-access';

/**
 * Guardian↔student links and guardian/adult-student absence reporting.
 * Leave requests (ledighetsansökan) and their decisions are LeaveService's.
 *
 * RLS enforces every access path at the database level; the service adds
 * friendly validation (role checks, guardianship checks, date sanity) so the
 * UI gets useful errors instead of empty RLS results.
 */
@Injectable()
export class FamilyService {
  private readonly logger = new Logger(FamilyService.name);

  constructor(private readonly prisma: PrismaService) {}

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
    const reportedById = requireUserId(user);
    if ((dto.startTime === undefined) !== (dto.endTime === undefined)) {
      throw new BadRequestException(
        'startTime and endTime must be provided together (omit both for full day).',
      );
    }
    // HH:MM compares as text. A span that ends before it starts covers no lesson
    // in the register, and SS12000 would hand it out as nonsense (AbsenceReports_ends_after_it_starts).
    if (dto.startTime !== undefined && dto.endTime !== undefined && dto.endTime <= dto.startTime) {
      throw new BadRequestException('endTime must be after startTime.');
    }
    return this.prisma.withRls(user, async (tx) => {
      await assertMayActForStudent(tx, dto.studentId, user);
      const schoolId = await schoolIdOf(tx, dto.studentId);

      const report = await tx.absenceReport.create({
        data: {
          schoolId,
          studentId: dto.studentId,
          reportedById,
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
}
