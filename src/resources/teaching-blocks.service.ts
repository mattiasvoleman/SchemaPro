import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { requireSchoolId } from '../common/utils/request-context';
import { rethrowPrismaError, writeConflict } from '../common/utils/prisma-errors';
import { requirementName } from '../optimization/optimization-proxy.service';
import { enforceRequirementWrite } from '../staffing/staffing-enforcement';
import type { StaffingWarning } from '../staffing/staffing-checks';
import {
  assertLessonLengthFitsTheGrid,
  mergeLessonShape,
  touchesLessonShape,
} from './lesson-shape-merge';
import type { CreateTeachingBlockDto, UpdateTeachingBlockDto } from './dto/teaching-block.dto';

/** A block as the API answers it: its name and the rows it holds. */
export interface TeachingBlockResponse {
  id: string;
  academicYearId: string;
  name: string;
  /** The timplansposter in the block, by id. */
  requirementIds: string[];
  /**
   * Only on a PATCH that changed the block's lessons: what the staffing
   * policy's WARN mode said about each member's teachers, as the timplanspost
   * PATCH answers it. A REFUSE is the 409 the write answered instead.
   */
  warnings?: StaffingWarning[];
}

/** The problem `code` of a block name its läsår already has. */
export const TEACHING_BLOCK_NAME_TAKEN = 'TEACHING_BLOCK_NAME_TAKEN';
/** The problem `code` of a row asked to join while it is in another block. */
export const REQUIREMENT_IN_ANOTHER_BLOCK = 'REQUIREMENT_IN_ANOTHER_BLOCK';

const NAME_MAX = 80;

/**
 * Parallella block: the timplansposter of one läsår whose lessons the
 * generator places at the same times (migration 20261024090000).
 *
 * WHAT THE DATABASE HOLDS, AND THIS SERVICE DOES NOT REPEAT. A row joins a
 * block through TeachingRequirements."blockId", whose key is (blockId,
 * academicYearId, schoolId): a row of another year or school cannot name the
 * block, and the refusal is the database's. The members have the same lessons
 * and weeks by trigger, which answers TB409 and reaches the caller through
 * rethrowPrismaError as the 409 BLOCK_MEMBERS_DIFFER naming the block. The
 * service writes the whole membership in one UPDATE, so the trigger judges
 * the block as it will stand and not one row at a time.
 *
 * WHAT IT SAYS ITSELF: a name the year already has (409
 * TEACHING_BLOCK_NAME_TAKEN, rather than the generic "already exists"), a row
 * that is in another block (409 REQUIREMENT_IN_ANOTHER_BLOCK — joining would
 * silently take it from a block the school wrote, so it has to leave that one
 * first), a row of another year and an id that is no row of the school (400).
 *
 * THE BLOCK'S LESSONS ARE CHANGED HERE, for every member at once: a
 * timplanspost PATCH writes one row, and the trigger refuses one member whose
 * lessons leave the others'. The new lessons are merged over the members'
 * shape by the timplanspost's own merge, every member's teachers are judged by
 * the staffing policy as the PATCH judges them, and one UPDATE writes them all.
 *
 * WHAT IS LEFT TO THE GENERATOR: members that share a teacher or pupils, and
 * a block whose lessons are partly locked. Rosters, teachers and locks change
 * after a block is written, and a refusal at write time would hold the block
 * to a week that no longer exists; the generator refuses each by name before
 * the model is built (BLOCK_MEMBERS_SHARE_TEACHER, BLOCK_MEMBERS_SHARE_PUPILS,
 * BLOCK_PARTLY_LOCKED).
 */
@Injectable()
export class TeachingBlocksService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    dto: CreateTeachingBlockDto,
    user: AuthenticatedUser,
  ): Promise<TeachingBlockResponse> {
    const schoolId = requireSchoolId(user);
    const name = blockName(dto.name);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        const block = await tx.teachingBlock.create({
          data: { schoolId, academicYearId: dto.academicYearId, name },
          select: { id: true, academicYearId: true, name: true },
        });
        const requirementIds = await setMembers(tx, block, dto.requirementIds ?? []);
        return { ...block, requirementIds };
      });
    } catch (error) {
      rethrowBlockError(error, name);
    }
  }

  /**
   * A rename, a new membership, or both. The block's row is read FOR UPDATE
   * first and held to COMMIT, so two PATCHes of one block run one after the
   * other: each writes the membership it was asked for over the one the other
   * left, never a mix of the two.
   */
  async update(
    id: string,
    dto: UpdateTeachingBlockDto,
    user: AuthenticatedUser,
  ): Promise<TeachingBlockResponse> {
    requireSchoolId(user);
    const name = dto.name === undefined ? undefined : blockName(dto.name);
    // Needs nothing from the database, so it answers before one is opened.
    assertLessonLengthFitsTheGrid(dto.minutesPerLesson ?? undefined);
    for (const minutes of dto.lessonLengths ?? []) assertLessonLengthFitsTheGrid(minutes);
    try {
      return await this.prisma.withRls(user, async (tx) => {
        const [locked] = await tx.$queryRaw<{ id: string; academicYearId: string; name: string }[]>`
          SELECT "id", "academicYearId", "name" FROM "TeachingBlocks" WHERE "id" = ${id}::uuid FOR UPDATE`;
        if (!locked) {
          throw new NotFoundException(`Blocket ${id} finns inte.`);
        }
        const block =
          name === undefined || name === locked.name
            ? locked
            : await tx.teachingBlock.update({
                where: { id },
                data: { name },
                select: { id: true, academicYearId: true, name: true },
              });
        const requirementIds =
          dto.requirementIds === undefined
            ? await membersOf(tx, id)
            : await setMembers(tx, block, dto.requirementIds);
        const warnings = touchesLessonShape(dto) ? await setLessons(tx, user, id, dto) : null;
        return {
          id: block.id,
          academicYearId: block.academicYearId,
          name: block.name,
          requirementIds,
          ...(warnings !== null ? { warnings } : {}),
        };
      });
    } catch (error) {
      rethrowBlockError(error, name);
    }
  }

  /** The rows stay, out of any block: the key clears "blockId" alone. */
  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    requireSchoolId(user);
    try {
      await this.prisma.withRls(user, (tx) => tx.teachingBlock.delete({ where: { id } }));
    } catch (error) {
      rethrowPrismaError(error);
    }
  }
}

/** The name as stored: trimmed, 1..80 characters, or a 400 naming the field. */
function blockName(raw: string): string {
  const name = raw.trim();
  if (name.length < 1 || name.length > NAME_MAX) {
    throw new BadRequestException(`name: blocket behöver ett namn på högst ${NAME_MAX} tecken.`);
  }
  return name;
}

async function membersOf(tx: PrismaClient, blockId: string): Promise<string[]> {
  const rows = await tx.teachingRequirement.findMany({
    where: { blockId },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return rows.map((row) => row.id);
}

/**
 * The block's whole membership, written as asked: rows not named leave, rows
 * named join, in one UPDATE each.
 *
 * The joining UPDATE takes only rows still in no block, so a row another
 * request put in a block between the read and the write is not taken from it;
 * its count says so, and the answer is the 409 a concurrent write gets
 * everywhere else.
 */
async function setMembers(
  tx: PrismaClient,
  block: { id: string; academicYearId: string },
  requested: readonly string[],
): Promise<string[]> {
  const wanted = [...new Set(requested)].sort();
  await tx.teachingRequirement.updateMany({
    where: { blockId: block.id, ...(wanted.length > 0 ? { id: { notIn: wanted } } : {}) },
    data: { blockId: null },
  });
  if (wanted.length === 0) return [];

  const rows = await tx.teachingRequirement.findMany({
    where: { id: { in: wanted } },
    select: {
      id: true,
      academicYearId: true,
      blockId: true,
      subject: { select: { name: true } },
      studentGroup: { select: { name: true } },
      block: { select: { name: true } },
    },
  });
  const found = new Set(rows.map((row) => row.id));
  const unknown = wanted.filter((id) => !found.has(id));
  if (unknown.length > 0) {
    throw new BadRequestException(
      `requirementIds: ${unknown.length === 1 ? 'en post finns' : `${unknown.length} poster finns`} inte i skolan.`,
    );
  }
  const otherYear = rows.filter((row) => row.academicYearId !== block.academicYearId);
  if (otherYear.length > 0) {
    throw new BadRequestException(
      `requirementIds: ${named(otherYear)} hör till ett annat läsår än blocket.`,
    );
  }
  const elsewhere = rows.filter((row) => row.blockId !== null && row.blockId !== block.id);
  if (elsewhere.length > 0) {
    const [first] = elsewhere;
    throw new ConflictException({
      message:
        `${named([first])} ligger redan i blocket "${first.block?.name ?? ''}". ` +
        'Ta den ur det blocket först.',
      code: REQUIREMENT_IN_ANOTHER_BLOCK,
    });
  }
  const joining = rows.filter((row) => row.blockId === null).map((row) => row.id);
  if (joining.length > 0) {
    const { count } = await tx.teachingRequirement.updateMany({
      where: { id: { in: joining }, blockId: null },
      data: { blockId: block.id },
    });
    if (count !== joining.length) throw writeConflict();
  }
  return wanted;
}

/**
 * The block's lessons, every member at once.
 *
 * The members have one shape (the trigger holds it), so the PATCH is merged
 * over the first member's and the same write fits every member. Each member's
 * teachers are judged before anything is written; a REFUSE is the 409 the
 * judge throws, and nothing is written. Then ONE UPDATE over the block, which
 * the trigger judges at its end with every member changed.
 */
async function setLessons(
  tx: PrismaClient,
  user: AuthenticatedUser,
  blockId: string,
  dto: UpdateTeachingBlockDto,
): Promise<StaffingWarning[]> {
  const members = await tx.teachingRequirement.findMany({
    where: { blockId },
    select: {
      id: true,
      academicYearId: true,
      subjectId: true,
      studentGroupId: true,
      teacherId: true,
      coTeacherId: true,
      lessonsPerWeek: true,
      minutesPerLesson: true,
      lessonLengths: true,
    },
    orderBy: { id: 'asc' },
  });
  if (members.length === 0) {
    throw new BadRequestException('lessonsPerWeek: blocket har inga poster att ändra lektionerna på.');
  }
  const resolved = mergeLessonShape(members[0]!, dto);
  const warnings: StaffingWarning[] = [];
  for (const member of members) {
    warnings.push(
      ...(await enforceRequirementWrite(tx, {
        viewer: user,
        schoolId: requireSchoolId(user),
        academicYearId: member.academicYearId,
        requirementId: member.id,
        subjectId: member.subjectId,
        studentGroupId: member.studentGroupId,
        before: { teacherId: member.teacherId, coTeacherId: member.coTeacherId },
        patch: { ...resolved.shape },
      })),
    );
  }
  if (Object.keys(resolved.write).length > 0) {
    await tx.teachingRequirement.updateMany({ where: { blockId }, data: resolved.write });
  }
  return warnings;
}

function named(rows: { subject: { name: string }; studentGroup: { name: string } }[]): string {
  return rows.map((row) => requirementName(row.subject.name, row.studentGroup.name)).join(', ');
}

/** A name the year already has is said as such; everything else as everywhere. */
function rethrowBlockError(error: unknown, name: string | undefined): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002' &&
    name !== undefined
  ) {
    throw new ConflictException({
      message: `Läsåret har redan ett block som heter "${name}".`,
      code: TEACHING_BLOCK_NAME_TAKEN,
    });
  }
  rethrowPrismaError(error);
}
