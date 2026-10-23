import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { LessonRecurrence, PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError, writeConflict } from '../common/utils/prisma-errors';
import { parseDateString } from '../common/utils/time';
import { requirementName } from '../optimization/optimization-proxy.service';
import { RequirementImportChecks } from '../staffing/staffing-enforcement';
import { staffingSentence } from '../staffing/staffing-checks';
import { readsHr } from '../staffing/hr-visibility';
import { readYearBoundsForShare } from './academic-year-bounds';
import { NOT_A_CLASS, lockClassForSplit, splitLockedClass } from './student-groups.service';
import {
  TEACHING_BLOCK_NAME_TAKEN,
  blockName,
  type BlockStaffingWarning,
} from './teaching-blocks.service';
import { requirementResponse, type TeachingRequirementResponse } from './teaching-requirements.service';
import type { SplitByTermDto } from './dto/term-halves.dto';

/** The problem codes "Dela terminsvis i halvklass" answers with besides the shared ones. */
export const TERM_SUBJECTS_SAME = 'TERM_SUBJECTS_SAME';
export const TERM_TEACHER_TWICE = 'TERM_TEACHER_TWICE';
export const REQUIREMENT_IN_A_BLOCK = 'REQUIREMENT_IN_A_BLOCK';
export const REQUIREMENT_HAS_PERIOD = 'REQUIREMENT_HAS_PERIOD';
export const SPRING_START_OUTSIDE_YEAR = 'SPRING_START_OUTSIDE_YEAR';
export const CLASS_HAS_ONE_HALF = 'CLASS_HAS_ONE_HALF';
export const HALF_HAS_SUBJECT = 'HALF_HAS_SUBJECT';

/** What the split wrote: the halves, the two blocks and the four posts. */
export interface TermHalvesResponse {
  /** The class's two halves, the first half first. */
  halves: { id: string; name: string }[];
  /** Whether this request split the class (false: it had its halves). */
  createdHalves: boolean;
  /** The autumn's block first, each with its two posts. */
  blocks: { id: string; name: string; requirementIds: string[] }[];
  /** The four posts: the first half's autumn and spring, then the second's. */
  requirements: TeachingRequirementResponse[];
  /** The class's post, which the four replace. */
  removedRequirementId: string;
  /** The staffing policy's WARNs, each with the new post it is about. */
  warnings: BlockStaffingWarning[];
}

/** A WARN about a post not written yet, by its place among the four. */
type PlannedWarning = Omit<BlockStaffingWarning, 'requirementId'> & { index: number };

const DAY_MS = 24 * 60 * 60 * 1000;
const asDay = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * "Dela terminsvis i halvklass": a class's post, slöjd for 7A, replaced by
 * four on the class's two halves, so that one half reads textilslöjd in the
 * autumn and trä- och metallslöjd in the spring and the other half the other
 * way round. Everything the school could already do by hand in eight steps on
 * two pages (Dela klassen, four posts with a period each, two blocks, the
 * class's post removed), done in one transaction from the post.
 *
 * TWO SUBJECTS, NOT ONE. A group has one post per subject in a year
 * (TeachingRequirements' unique key, which the generator, the coverage and
 * the hand-edit checks all read as "the demand of this group in this
 * subject"), so a half cannot hold slöjd in the autumn and slöjd again in the
 * spring. The swap is between two subjects, which is also what lets each
 * half's post ask for its own sal: textilsalen and trä- och metallsalen are
 * the subjects' room types.
 *
 * ONE BLOCK PER TERM. A block's posts have the same lessons and weeks by
 * trigger (TB409), and the autumn's two posts have other weeks than the
 * spring's. So the autumn's block holds the first half's first subject and
 * the second half's second, and the spring's block the swap. Each block puts
 * its two halves at the same times, which is what keeps the class's week from
 * holding slöjd twice: two halves of one class never share a pupil, so the
 * block is always one the generator accepts. The generator plans one week
 * and has no terms, so it gives each block its own times and holds both all
 * year — the manual says so and how to put the spring on the autumn's times.
 *
 * THE FOUR POSTS COPY THE CLASS'S LESSONS: count, lengths, ombyte, its own
 * distribution and its weeks (udda/jämna). Not its teacher: each subject has
 * its own, named in the request, and the class's post is removed, so its
 * teacher's load is released before the new posts are judged. The periods
 * are the year's own start to the day before `springStartDate`, and
 * `springStartDate` to the year's own end, with the open ends stored as null
 * so a läsår whose dates are moved, or a rollover, keeps them whole.
 *
 * REFUSED: a post that is not a class's (a half is split already), one in a
 * block (removing it would leave the block without it unseen), one with a
 * period of its own (it is already a part of the year), the same subject
 * twice, one teacher for both subjects (the generator refuses a block whose
 * posts share a teacher), a spring start that leaves either term empty, a half that already
 * has a post in one of the subjects, a class with only one half left, and a
 * block name the year has. Each by its own code, before anything is written.
 *
 * LOCK ORDER: the class row first (FOR NO KEY UPDATE, as Dela klassen takes
 * it, so two splits of one class run one after the other and the second
 * finds the post gone), then the teachers' posts (RequirementImportChecks,
 * the import's order), then the requirement rows. The class's post is read
 * without a lock, as a timplanspost PATCH reads it, and removed by a DELETE
 * that matches only the post as it was read: anything that changed it in
 * between makes the whole split a 409 with nothing written.
 */
@Injectable()
export class TermHalvesService {
  constructor(private readonly prisma: PrismaService) {}

  async split(
    requirementId: string,
    dto: SplitByTermDto,
    user: AuthenticatedUser,
  ): Promise<TermHalvesResponse> {
    const schoolId = requireSchoolId(user);
    const [first, second] = dto.subjects;
    if (!first || !second || first.subjectId === second.subjectId) {
      throw new BadRequestException({
        message: 'subjects: halvorna byter mellan två olika ämnen, till exempel textilslöjd och trä- och metallslöjd.',
        code: TERM_SUBJECTS_SAME,
      });
    }
    // Each block holds one post of each subject at the same times, and the
    // generator refuses a block whose posts share a teacher: one teacher for
    // both subjects is a split no timetable can hold, so it is said here.
    if (first.teacherId && first.teacherId === second.teacherId) {
      throw new BadRequestException({
        message: 'subjects: halvorna har lektion samtidigt, så en lärare kan inte ha båda ämnena.',
        code: TERM_TEACHER_TWICE,
      });
    }
    const springStart = parseDateString(dto.springStartDate);
    const askedBlockNames = dto.blockNames?.map(blockName);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        const located = await tx.teachingRequirement.findUnique({
          where: { id: requirementId },
          select: { studentGroupId: true },
        });
        if (!located) throw new NotFoundException('Timplansposten finns inte.');
        await lockClassForSplit(tx, located.studentGroupId);

        const source = await tx.teachingRequirement.findUnique({
          where: { id: requirementId },
          include: {
            subject: { select: { name: true } },
            block: { select: { name: true } },
            studentGroup: {
              select: {
                id: true,
                name: true,
                kind: true,
                halves: { select: { id: true, name: true }, orderBy: { name: 'asc' } },
              },
            },
          },
        });
        // Moved to another group while this waited on the class: not the
        // post the request was about any more.
        if (!source || source.studentGroupId !== located.studentGroupId) {
          throw new NotFoundException('Timplansposten finns inte.');
        }
        const theClass = source.studentGroup;
        const postName = requirementName(source.subject.name, theClass.name);
        if (theClass.kind !== 'CLASS') {
          throw new BadRequestException({
            message: `${postName} är en undervisningsgrupps post. Bara en klass post kan delas terminsvis i halvklass.`,
            code: NOT_A_CLASS,
          });
        }
        if (source.blockId !== null) {
          throw new ConflictException({
            message: `${postName} ligger i blocket "${source.block?.name ?? ''}". Ta den ur blocket först.`,
            code: REQUIREMENT_IN_A_BLOCK,
          });
        }
        if (source.startDate !== null || source.endDate !== null) {
          throw new BadRequestException({
            message: `${postName} gäller redan bara en del av läsåret. Ta bort postens datum först.`,
            code: REQUIREMENT_HAS_PERIOD,
          });
        }

        const year = await readYearBoundsForShare(tx, source.academicYearId);
        // A year RLS hides is a post RLS hides, answered above; the guard is
        // for the type.
        if (!year) throw new NotFoundException('Timplansposten finns inte.');
        if (springStart <= year.startDate || springStart > year.endDate) {
          throw new BadRequestException({
            message:
              `springStartDate: vårterminen börjar efter läsårets första dag och senast dess sista ` +
              `(${asDay(year.startDate)} till ${asDay(year.endDate)}).`,
            code: SPRING_START_OUTSIDE_YEAR,
          });
        }
        const autumnEnd = new Date(springStart.getTime() - DAY_MS);

        const subjects = await tx.subject.findMany({
          where: { id: { in: [first.subjectId, second.subjectId] } },
          select: { id: true, name: true },
        });
        const subjectName = new Map(subjects.map((subject) => [subject.id, subject.name]));
        if (!subjectName.has(first.subjectId) || !subjectName.has(second.subjectId)) {
          throw new BadRequestException('subjects: ett av ämnena finns inte i skolan.');
        }

        // The class's halves, or two new ones. A class with one half left
        // (the other removed) cannot be split again until that one goes too.
        let createdHalves = false;
        let halves: { id: string; name: string }[] = theClass.halves;
        if (halves.length === 0) {
          halves = (await splitLockedClass(tx, schoolId, theClass.id, dto.halfNames)).map(({ id, name }) => ({ id, name }));
          createdHalves = true;
        } else if (halves.length !== 2) {
          throw new ConflictException({
            message:
              `${theClass.name} har bara halvan ${halves.map((half) => half.name).join(', ')}. ` +
              'Ta bort den under Klasser och försök igen, så delas klassen i två nya halvor.',
            code: CLASS_HAS_ONE_HALF,
          });
        }

        const taken = await tx.teachingRequirement.findMany({
          where: {
            studentGroupId: { in: halves.map((half) => half.id) },
            subjectId: { in: [first.subjectId, second.subjectId] },
          },
          select: { studentGroup: { select: { name: true } }, subject: { select: { name: true } } },
          orderBy: [{ studentGroup: { name: 'asc' } }, { subject: { name: 'asc' } }],
        });
        if (taken.length > 0) {
          throw new ConflictException({
            message:
              taken.map((row) => `${row.studentGroup.name} har redan en post i ${row.subject.name}`).join(', ') +
              (taken.length === 1 ? '. Ta bort den eller välj ett annat ämne.' : '. Ta bort dem eller välj andra ämnen.'),
            code: HALF_HAS_SUBJECT,
          });
        }

        const names = askedBlockNames ?? [
          blockName(`${source.subject.name} ${theClass.name} HT`),
          blockName(`${source.subject.name} ${theClass.name} VT`),
        ];
        if (names[0]!.toLowerCase() === names[1]!.toLowerCase()) {
          throw new BadRequestException('blockNames: två olika namn, ett för hösten och ett för våren.');
        }
        const takenBlocks = await tx.teachingBlock.findMany({
          where: { academicYearId: source.academicYearId, name: { in: names } },
          select: { name: true },
          orderBy: { name: 'asc' },
        });
        if (takenBlocks.length > 0) {
          throw new ConflictException({
            message: `Läsåret har redan ett block som heter "${takenBlocks[0]!.name}".`,
            code: TEACHING_BLOCK_NAME_TAKEN,
          });
        }

        // The four posts: half h reads subject (h + term) mod 2 in each term.
        const terms = [
          { startDate: null, endDate: autumnEnd },
          { startDate: springStart, endDate: null },
        ];
        const pair = [first, second];
        const planned = halves.flatMap((half, h) =>
          terms.map((term, t) => {
            const subject = pair[(h + t) % 2]!;
            return { half, term: t, ...term, subjectId: subject.subjectId, teacherId: subject.teacherId ?? null };
          }),
        );

        const warnings = await this.judge(tx, user, source, planned, subjectName);

        const { count } = await tx.teachingRequirement.deleteMany({
          where: {
            id: source.id,
            studentGroupId: theClass.id,
            blockId: null,
            startDate: null,
            endDate: null,
            lessonsPerWeek: source.lessonsPerWeek,
            minutesPerLesson: source.minutesPerLesson,
          },
        });
        if (count !== 1) throw writeConflict();

        const blocks: { id: string; name: string }[] = [];
        for (const name of names) {
          blocks.push(
            await tx.teachingBlock.create({
              data: { schoolId, academicYearId: source.academicYearId, name },
              select: { id: true, name: true },
            }),
          );
        }

        const created = await tx.teachingRequirement.createManyAndReturn({
          data: planned.map((row) => ({
            schoolId,
            academicYearId: source.academicYearId,
            subjectId: row.subjectId,
            studentGroupId: row.half.id,
            teacherId: row.teacherId,
            lessonsPerWeek: source.lessonsPerWeek,
            minutesPerLesson: source.minutesPerLesson,
            lessonLengths: source.lessonLengths,
            minutesBefore: source.minutesBefore,
            minutesAfter: source.minutesAfter,
            ownDistribution: source.ownDistribution,
            maxLessonsPerDay: source.maxLessonsPerDay,
            minDaysBetween: source.minDaysBetween,
            recurrence: source.recurrence,
            startDate: row.startDate,
            endDate: row.endDate,
            blockId: blocks[row.term]!.id,
          })),
        });
        // In the planned order, by the (group, subject) the unique key makes one row.
        const byDemand = new Map(created.map((row) => [`${row.studentGroupId}:${row.subjectId}`, row]));
        const rows = planned.map((row) => byDemand.get(`${row.half.id}:${row.subjectId}`)!);

        return {
          halves,
          createdHalves,
          blocks: blocks.map((block, t) => ({
            ...block,
            requirementIds: rows.filter((_, index) => planned[index]!.term === t).map((row) => row.id),
          })),
          requirements: rows.map(requirementResponse),
          removedRequirementId: source.id,
          warnings: warnings.map(({ index, ...warning }) => ({ ...warning, requirementId: rows[index]!.id })),
        };
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      rethrowPrismaError(error);
    }
  }

  /**
   * The staffing policy's two questions over the four posts, as the import
   * asks them of a file: the year read once, the class's post with its
   * teachers taken off first (it is about to go), and each post laid over the
   * year before the next is asked, so a teacher with the subject in both
   * halves is charged both terms. A REFUSE is a 409 naming the post, and
   * nothing is written; a WARN keeps the index of the post it is about.
   */
  private async judge(
    tx: PrismaClient,
    user: AuthenticatedUser,
    source: {
      id: string;
      academicYearId: string;
      studentGroupId: string;
      lessonsPerWeek: number;
      minutesPerLesson: number;
      lessonLengths: number[];
      recurrence: LessonRecurrence;
    },
    planned: readonly {
      half: { id: string; name: string };
      subjectId: string;
      teacherId: string | null;
      startDate: Date | null;
      endDate: Date | null;
    }[],
    subjectName: ReadonlyMap<string, string>,
  ): Promise<PlannedWarning[]> {
    const teacherIds = [...new Set(planned.flatMap((row) => (row.teacherId ? [row.teacherId] : [])))];
    // No teacher on any post: nothing to ask, and releasing the class's
    // teacher changes no answer.
    if (teacherIds.length === 0) return [];
    const checks = await RequirementImportChecks.open(tx, {
      viewer: user,
      showsPeriods: readsHr(user),
      schoolId: requireSchoolId(user),
      academicYearId: source.academicYearId,
      teacherIds,
      groupIds: [...new Set([source.studentGroupId, ...planned.map((row) => row.half.id)])],
    });
    if (!checks) return [];

    const stored = checks.stored(source.id);
    if (stored) {
      const { after } = checks.judge({
        requirementId: source.id,
        rowNumber: 0,
        subjectId: stored.subjectId,
        subjectName: stored.subjectName,
        studentGroupId: stored.studentGroupId,
        groupName: stored.groupName,
        patch: { teacherId: null, coTeacherId: null },
      });
      checks.apply(after);
    }

    const warnings: PlannedWarning[] = [];
    for (const [index, row] of planned.entries()) {
      if (row.teacherId === null) continue;
      const name = subjectName.get(row.subjectId) ?? '';
      const { findings, after } = checks.judge({
        requirementId: null,
        rowNumber: index + 1,
        subjectId: row.subjectId,
        subjectName: name,
        studentGroupId: row.half.id,
        groupName: row.half.name,
        patch: {
          teacherId: row.teacherId,
          coTeacherId: null,
          teacherLoadPercent: 100,
          coTeacherLoadPercent: 100,
          lessonsPerWeek: source.lessonsPerWeek,
          minutesPerLesson: source.minutesPerLesson,
          lessonLengths: source.lessonLengths,
          recurrence: source.recurrence,
          startDate: row.startDate ? asDay(row.startDate) : null,
          endDate: row.endDate ? asDay(row.endDate) : null,
        },
      });
      const refusal = findings.find((finding) => finding.mode === 'REFUSE');
      if (refusal) {
        throw new ConflictException({
          message: `${requirementName(name, row.half.name)}: ${staffingSentence(refusal)}`,
          code: refusal.code,
          params: { ...refusal.params, subjectId: row.subjectId, studentGroupId: row.half.id },
        });
      }
      warnings.push(...findings.map(({ code, params }) => ({ code, params, index })));
      checks.apply(after);
    }
    return warnings;
  }
}
