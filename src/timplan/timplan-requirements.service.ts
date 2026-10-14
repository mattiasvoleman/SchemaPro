import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { LocalTimplanStatus } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError } from '../common/utils/prisma-errors';
import type { GenerateRequirementsDto } from './dto/generate-requirements.dto';
import {
  alternativeLineOf,
  proposeRequirements,
  type ProposedBlock,
  type ProposedRow,
  type SkippedRow,
} from './generate-requirements';

/** The problem `code` of a språkval block whose name another årskurs' posts hold. */
export const LANGUAGE_BLOCK_IN_OTHER_GRADE = 'LANGUAGE_BLOCK_IN_OTHER_GRADE';

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
  /** Only when språkval groups were named: the blocks the rows are posted in. */
  blocks?: ProposedBlock[];
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
 * SPRÅKVAL AS A BLOCK. Teaching groups named in `languageGroups` get their
 * language's row, and each årskurs' rows go into the block "Språkval åk g" —
 * the year's block of that name, or a new one. The block is written before
 * the rows, which name it in the same INSERT, so the block trigger judges the
 * block as it stands with all of them in it: a block the school already filled
 * with rows of other lessons refuses the apply as a whole (409
 * BLOCK_MEMBERS_DIFFER), and nothing is written.
 *
 * A NAME IS NOT AN ÅRSKURS. "Språkval åk 7" can already hold another årskurs'
 * posts — a block carried at its årskurs by the rollover keeps its name, and a
 * school names its blocks as it likes — and joining it would place åk 7's
 * languages at the same times as åk 8's. So a block of that name with a post
 * on a group of another årskurs refuses the preview and the apply alike (409
 * LANGUAGE_BLOCK_IN_OTHER_GRADE), naming the groups, before anything is
 * written. A group without an årskurs, as a teaching group often is, says
 * nothing either way and refuses nothing here; the rollover is what keeps
 * such a block from meeting this name with last year's cohort in it, by
 * naming a carried block after its pupils' årskurs, or after last year when
 * that is unknown (planBlocks in rollover-plan.ts).
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
        // The språkval groups, read only when named: teaching groups of this year.
        const languageIds = [...new Set((dto.languageGroups ?? []).map((choice) => choice.studentGroupId))];
        const languageGroups =
          languageIds.length === 0
            ? []
            : await tx.studentGroup.findMany({
                where: { id: { in: languageIds }, academicYearId: dto.academicYearId, kind: 'TEACHING_GROUP' },
                select: { id: true, name: true },
              });
        const languageName = new Map(languageGroups.map((group) => [group.id, group.name]));
        for (const [index, choice] of (dto.languageGroups ?? []).entries()) {
          if (!languageName.has(choice.studentGroupId)) {
            throw new BadRequestException(
              `languageGroups: rad ${index + 1}: gruppen är ingen undervisningsgrupp i läsåret.`,
            );
          }
        }
        const groupIds = [...classes.map((g) => g.id), ...languageIds];
        const existing =
          groupIds.length === 0
            ? []
            : await tx.teachingRequirement.findMany({
                where: { academicYearId: dto.academicYearId, studentGroupId: { in: groupIds } },
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
          ...(dto.languageGroups && dto.languageGroups.length > 0
            ? {
                languageGroups: dto.languageGroups.map((choice) => ({
                  ...choice,
                  groupName: languageName.get(choice.studentGroupId) ?? '',
                })),
              }
            : {}),
        });

        if (proposal.blocks && proposal.blocks.length > 0) {
          const named = await tx.teachingBlock.findMany({
            where: { academicYearId: dto.academicYearId, name: { in: proposal.blocks.map((block) => block.name) } },
            select: {
              name: true,
              requirements: { select: { studentGroup: { select: { name: true, gradeLevel: true } } } },
            },
          });
          for (const block of proposal.blocks) {
            const held = named.find((candidate) => candidate.name === block.name);
            const others = [
              ...new Set(
                (held?.requirements ?? [])
                  .map((requirement) => requirement.studentGroup)
                  .filter((group) => group.gradeLevel !== null && group.gradeLevel !== block.gradeLevel)
                  .map((group) => group.name),
              ),
            ].sort((a, b) => a.localeCompare(b, 'sv'));
            if (others.length > 0) {
              throw new ConflictException({
                message:
                  `Läsåret har redan ett block som heter "${block.name}", och det håller poster i en annan ` +
                  `årskurs (${others.join(', ')}). Språkvalet i åk ${block.gradeLevel} läggs inte i det. ` +
                  'Byt namn på det blocket under Block på Timplansposter, och skapa sedan timplansposterna igen.',
                code: LANGUAGE_BLOCK_IN_OTHER_GRADE,
              });
            }
          }
        }

        const answer = {
          localTimplanId: plan.id,
          planName: plan.name,
          planStatus: plan.status,
          academicYearId: dto.academicYearId,
          gradeLevels,
          minutesPerLesson: dto.minutesPerLesson,
          ...(dto.remainder !== undefined ? { remainder: dto.remainder } : {}),
          dryRun: dto.dryRun,
          ...(proposal.blocks ? { blocks: proposal.blocks } : {}),
        };
        if (dto.dryRun || proposal.rows.length === 0) {
          return { ...answer, created: 0, rows: proposal.rows, skipped: proposal.skipped };
        }

        // The blocks first: the year's own of that name, or a new one.
        const blockIdByName = new Map<string, string>();
        for (const block of proposal.blocks ?? []) {
          const { id } = await tx.teachingBlock.upsert({
            where: {
              schoolId_academicYearId_name: { schoolId, academicYearId: dto.academicYearId, name: block.name },
            },
            create: { schoolId, academicYearId: dto.academicYearId, name: block.name },
            update: {},
            select: { id: true },
          });
          blockIdByName.set(block.name, id);
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
            ...(row.blockName ? { blockId: blockIdByName.get(row.blockName) } : {}),
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
