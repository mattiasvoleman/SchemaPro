import { Injectable, NotFoundException } from '@nestjs/common';
import type { LocalTimplanStatus } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import type { GenerateRequirementsDto } from './dto/generate-requirements.dto';
import {
  alternativeLineOf,
  proposeRequirements,
  type ProposedRow,
  type SkippedRow,
} from './generate-requirements';

export interface GeneratedRow extends ProposedRow {
  /** The created requirement; absent in a preview. */
  requirementId?: string;
}

export interface GenerateRequirementsResponse {
  localTimplanId: string;
  planName: string;
  planStatus: LocalTimplanStatus;
  academicYearId: string;
  /** The årskurser the year attaches to this plan; empty means nothing to do. */
  gradeLevels: number[];
  minutesPerLesson: number;
  /** Echoed only when the request stated it; an omitted one is ROUND_UP. */
  remainder?: 'SPLIT' | 'ROUND_UP';
  dryRun: boolean;
  /** Rows written by this call (0 for a preview). */
  created: number;
  rows: GeneratedRow[];
  skipped: SkippedRow[];
}

/**
 * Skapa timplansposter: the plan's minutes per week as the TeachingRequirements
 * a läsår's classes are missing (generate-requirements.ts says what is
 * proposed and why).
 *
 * ONE TRANSACTION, READ THEN WRITE. The plan, the year's attachments to it,
 * the classes and the year's existing (group, subject) pairs are read under
 * the caller's RLS; the preview is answered from them, and an apply writes the
 * proposal with createManyAndReturn + skipDuplicates (ON CONFLICT DO NOTHING
 * on TeachingRequirements' unique (schoolId, year, group, subject) key). So an
 * apply is IDEMPOTENT — the second call creates nothing and names every row as
 * skipped — and a requirement saved by somebody else between this call's read
 * and its insert is not overwritten and not a 409: the insert passes it by,
 * and the answer moves that row from "created" to "skipped". Nothing existing
 * is ever updated or deleted.
 *
 * No teacher is set, so the staffing policy's checks have nothing to judge;
 * no period is set, so the year's bounds need no FOR SHARE read. A draft plan
 * generates like a decided one (next year is planned before the decision) and
 * the answer says which it was.
 */
@Injectable()
export class TimplanRequirementsService {
  constructor(private readonly prisma: PrismaService) {}

  async generate(
    planId: string,
    dto: GenerateRequirementsDto,
    user: AuthenticatedUser,
  ): Promise<GenerateRequirementsResponse> {
    const schoolId = requireSchoolId(user);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        const plan = await tx.localTimplan.findUnique({
          where: { id: planId },
          select: {
            id: true,
            name: true,
            status: true,
            entries: { select: { subjectId: true, gradeLevel: true, minutesPerWeek: true } },
          },
        });
        if (!plan) throw new NotFoundException('Den lokala timplanen finns inte.');
        const year = await tx.academicYear.findUnique({
          where: { id: dto.academicYearId },
          select: { id: true },
        });
        if (!year) throw new NotFoundException('Läsåret finns inte.');

        const attachments = await tx.academicYearTimplan.findMany({
          where: { academicYearId: dto.academicYearId, localTimplanId: planId },
          select: { gradeLevel: true },
          orderBy: { gradeLevel: 'asc' },
        });
        const gradeLevels = attachments.map((row) => row.gradeLevel);
        const classes =
          gradeLevels.length === 0
            ? []
            : await tx.studentGroup.findMany({
                where: { academicYearId: dto.academicYearId, kind: 'CLASS', gradeLevel: { in: gradeLevels } },
                select: { id: true, name: true, gradeLevel: true },
              });
        const existing =
          classes.length === 0
            ? []
            : await tx.teachingRequirement.findMany({
                where: { academicYearId: dto.academicYearId, studentGroupId: { in: classes.map((g) => g.id) } },
                select: { studentGroupId: true, subjectId: true },
              });
        const subjectIds = [...new Set(plan.entries.map((entry) => entry.subjectId))];
        const subjects =
          subjectIds.length === 0
            ? []
            : await tx.subject.findMany({
                where: { id: { in: subjectIds } },
                select: { id: true, name: true, nationalCode: true },
              });

        const proposal = proposeRequirements({
          gradeLevels,
          entries: plan.entries,
          classes,
          subjectNames: new Map(subjects.map((subject) => [subject.id, subject.name])),
          nationalCodes: new Map(subjects.map((subject) => [subject.id, subject.nationalCode])),
          existing,
          minutesPerLesson: dto.minutesPerLesson,
          remainder: dto.remainder ?? 'ROUND_UP',
          overrides: dto.overrides ?? [],
        });

        const answer = {
          localTimplanId: plan.id,
          planName: plan.name,
          planStatus: plan.status,
          academicYearId: dto.academicYearId,
          gradeLevels,
          minutesPerLesson: dto.minutesPerLesson,
          ...(dto.remainder !== undefined ? { remainder: dto.remainder } : {}),
          dryRun: dto.dryRun,
        };
        if (dto.dryRun || proposal.rows.length === 0) {
          return { ...answer, created: 0, rows: proposal.rows, skipped: proposal.skipped };
        }

        const written = await tx.teachingRequirement.createManyAndReturn({
          data: proposal.rows.map((row) => ({
            schoolId,
            academicYearId: dto.academicYearId,
            subjectId: row.subjectId,
            studentGroupId: row.studentGroupId,
            lessonsPerWeek: row.lessonsPerWeek,
            minutesPerLesson: row.minutesPerLesson,
            // Only a split row names the list; a uniform one leaves it to the
            // column's '{}', so a ROUND_UP apply writes the rows it always did.
            ...(row.lessonLengths ? { lessonLengths: row.lessonLengths } : {}),
            // Stated, as TeachingRequirementsService states them, so the row
            // is the one the preview described and not what defaults fill in.
            teacherId: null,
            coTeacherId: null,
            teacherLoadPercent: 100,
            coTeacherLoadPercent: 100,
            minutesBefore: 0,
            minutesAfter: 0,
            recurrence: 'ALL_WEEKS',
            startDate: null,
            endDate: null,
          })),
          skipDuplicates: true,
          select: { id: true, studentGroupId: true, subjectId: true },
        });
        const createdIds = new Map(
          written.map((row) => [`${row.studentGroupId}:${row.subjectId}`, row.id]),
        );
        const rows: GeneratedRow[] = [];
        const skipped = [...proposal.skipped];
        for (const row of proposal.rows) {
          const requirementId = createdIds.get(`${row.studentGroupId}:${row.subjectId}`);
          if (requirementId) rows.push({ ...row, requirementId });
          else {
            skipped.push({
              studentGroupId: row.studentGroupId,
              groupName: row.groupName,
              subjectId: row.subjectId,
              subjectName: row.subjectName,
              gradeLevel: row.gradeLevel,
              reason: 'EXISTS',
              alternativeCode: alternativeLineOf(
                subjects.find((subject) => subject.id === row.subjectId)?.nationalCode,
              ),
              alternativeTo: null,
            });
          }
        }
        return { ...answer, created: rows.length, rows, skipped };
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }
}
