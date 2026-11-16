import { randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { MasterLessonsService } from '../calendar/master-lessons.service';
import type { GradeNumbering } from '../common/grade-numbering';
import { blockPlacementsConflict, rethrowPrismaError } from '../common/utils/prisma-errors';
import { requireSchoolId } from '../common/utils/request-context';
import { parseTimeString } from '../common/utils/time';
import { PrismaService } from '../database/prisma.service';
import { lockYearForGrundschemaEdit } from '../optimization/regeneration-lock';
import { rostersOfYear } from '../year-rollover/projected-rosters';
import {
  blockFitOf,
  blockLengthsOf,
  blockShapeOf,
  firstRowWithTwoRoomsForOneMember,
} from './block-placement-fit';
import {
  blockPlacementViewOf,
  blockRowsKeyOf,
  blockVerdictsOf,
  demandOfBlockMembers,
  judgedRowsOfBlock,
  loadBlock,
  type BlockPlacementView,
  type BlockSlot,
  type BlockVerdictView,
  type LoadedBlock,
} from './block-placement-judge';
import type { ReplaceBlockPlacementsDto } from './dto/block-placements.dto';
import { clockText, judgePlacements, type JudgedPlacement } from './placement-judge';
import { blockPlacementRefusedConflict, blockPlacementsStaleConflict } from './placement-refusal';
import { RequirementPlacementsService } from './requirement-placements.service';

/** A parallel block's förläggningar as the API states them: the lessons, a verdict for each lesson and member, and the read's key. */
export interface BlockPlacementsResponse {
  placements: BlockPlacementView[];
  /** One verdict per lesson and member, in lesson order and, within a lesson, in the members' id order. */
  verdicts: BlockVerdictView[];
  /** The key of the lessons as read: a save that carries it as `baseKey` is refused (409) when the lessons have changed. */
  rowsKey: string;
  /** The block's lesson lengths, longest first, one per lesson: what the dialog offers, and how many lessons it can place of each. */
  lengths: number[];
}

const minutesOfClock = (time: string): number => {
  const [hours, minutes] = time.split(':');
  return Number(hours) * 60 + Number(minutes);
};

/**
 * Förlagda block, the gateway's side: a parallel block's förläggningar read, judged and replaced (see
 * block-placement-fit.ts for what makes a set of lessons fit a block, and block-placement-judge.ts for how a lesson is
 * judged: one row per member, in one call).
 *
 * The lessons are the block's, the class, the subject and the teachers the posts'. A lesson is written for the block
 * and every member sits it; a member that names a room has it, and a member that does not has its room chosen by the
 * engine at every Generera. The weeks are the block's and are set here, not by the request.
 */
@Injectable()
export class BlockPlacementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly masters: MasterLessonsService,
    private readonly posts: RequirementPlacementsService,
  ) {}

  /** One block's förläggningar with a verdict for each lesson and member, judged now: the week moves under a row between a save and a view. */
  async listOfBlock(id: string, user: AuthenticatedUser): Promise<BlockPlacementsResponse> {
    return this.prisma.withRls(user, async (tx) => {
      const block = await this.blockOf(tx, id);
      return this.responseOf(tx, user, block, block.rows);
    });
  }

  /**
   * Replaces the block's förläggningar with the request's list (empty removes them). Refused with 409, and nothing
   * written, for the first of: a read that is not the stored one (BLOCK_PLACEMENTS_STALE, when `baseKey` is
   * given), lessons that do not fit the block (BLOCK_PLACEMENTS_DO_NOT_FIT, with the rule and the lesson), and
   * the first lesson of the first member the week does not hold (BLOCK_PLACEMENT_REFUSED, with the lesson's
   * index, the reason and the member).
   *
   * Written beside other grundschema edits and never inside a rewrite of the year (the year's edit lock, 409
   * SCHEDULE_BUSY), as a post's förläggningar are. Changing a lesson moves nothing in the grundschema; it counts
   * from the next Generera.
   */
  async replace(id: string, dto: ReplaceBlockPlacementsDto, user: AuthenticatedUser): Promise<BlockPlacementsResponse> {
    try {
      return await this.prisma.withRls(user, async (tx) => {
        const first = await this.blockOf(tx, id);
        await lockYearForGrundschemaEdit(tx, first.academicYearId);
        // The block's row, as the trigger takes it (FOR NO KEY UPDATE) and before the rows are read: a second writer waits
        // here and then reads what the first committed, so the key below is the stored one.
        await tx.$queryRaw`SELECT "id" FROM "TeachingBlocks" WHERE "id" = ${id}::uuid FOR NO KEY UPDATE`;
        const block = await this.blockOf(tx, id);
        if (dto.baseKey !== undefined && dto.baseKey !== blockRowsKeyOf(block.rows)) throw blockPlacementsStaleConflict();

        const shape = blockShapeOf(block);
        const recurrence = shape?.recurrence ?? 'ALL_WEEKS';
        const wanted: BlockSlot[] = dto.placements.map((row) => ({
          dayOfWeek: row.dayOfWeek,
          startMinutes: minutesOfClock(row.startTime),
          minutes: row.minutes,
          recurrence,
          rooms: (row.rooms ?? []).map((room) => ({ requirementId: room.requirementId, roomId: room.roomId })),
        }));

        const twice = firstRowWithTwoRoomsForOneMember(wanted);
        if (twice >= 0) throw new BadRequestException(`placements: förläggning ${twice + 1} anger två salar för en post.`);
        await this.assertRoomsExist(tx, wanted);

        const fit = blockFitOf(block, wanted);
        if (fit !== null) {
          throw blockPlacementsConflict(fit.reason, { ...(fit.index !== null ? { index: fit.index } : {}), blockId: id });
        }

        const { verdicts } = await this.judge(tx, user, block, wanted);
        const refused = verdicts.find((verdict) => !verdict.ok);
        if (refused) throw blockPlacementRefusedConflict(refused);

        // The block's rows are replaced as one list: the old ones go (their room rows with them) and the new ones are one
        // INSERT, so the trigger, which judges the block's rows when each statement is done, sees the whole set. Flat
        // createMany, never a nested create (it drops schoolId at runtime).
        await tx.teachingBlockPlacement.deleteMany({ where: { blockId: id } });
        if (wanted.length > 0) {
          const ids = wanted.map(() => randomUUID());
          await tx.teachingBlockPlacement.createMany({
            data: wanted.map((slot, at) => ({
              id: ids[at]!,
              schoolId: block.schoolId,
              blockId: id,
              academicYearId: block.academicYearId,
              dayOfWeek: slot.dayOfWeek,
              startTime: parseTimeString(clockText(slot.startMinutes)),
              minutes: slot.minutes,
              recurrence: slot.recurrence,
            })),
          });
          const roomRows = wanted.flatMap((slot, at) =>
            slot.rooms.map((room) => ({
              schoolId: block.schoolId,
              placementId: ids[at]!,
              requirementId: room.requirementId,
              roomId: room.roomId,
            })),
          );
          if (roomRows.length > 0) await tx.teachingBlockPlacementRoom.createMany({ data: roomRows });
        }
        const written = await this.blockOf(tx, id);
        return {
          placements: written.rows.map((row) => blockPlacementViewOf(id, row)),
          verdicts: judgedRowsOfBlock(written, written.rows).origins.map((origin) => ({
            index: origin.index,
            requirementId: origin.requirementId,
            ok: true,
          })),
          rowsKey: blockRowsKeyOf(written.rows),
          lengths: blockLengthsOf(written),
        };
      });
    } catch (error) {
      rethrowPrismaError(error);
    }
  }

  private async blockOf(tx: PrismaClient, id: string): Promise<NonNullable<Awaited<ReturnType<typeof loadBlock>>>> {
    const block = await loadBlock(tx, id);
    if (!block) throw new NotFoundException('Blocket finns inte.');
    return block;
  }

  /**
   * A room the school does not have is the caller's mistake, said by name. Row-level security shows the school's own rooms
   * only, so another school's room reads as absent here, as it does to the foreign key.
   */
  private async assertRoomsExist(tx: PrismaClient, rows: readonly BlockSlot[]): Promise<void> {
    const ids = [...new Set(rows.flatMap((row) => row.rooms.map((room) => room.roomId)))];
    if (ids.length === 0) return;
    const found = new Set((await tx.room.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((room) => room.id));
    if (ids.some((roomId) => !found.has(roomId))) {
      throw new BadRequestException('placements: en sal finns inte i skolan.');
    }
  }

  private async responseOf(
    tx: PrismaClient,
    user: AuthenticatedUser,
    block: LoadedBlock & { academicYearId: string },
    rows: LoadedBlock['rows'],
  ): Promise<BlockPlacementsResponse> {
    const { verdicts } = await this.judge(tx, user, block, rows);
    return {
      placements: rows.map((row) => blockPlacementViewOf(block.id, row)),
      verdicts,
      rowsKey: blockRowsKeyOf(rows),
      lengths: blockLengthsOf(block),
    };
  }

  /**
   * The block's lessons judged against the kept lessons, the year's other förläggningar (the posts' and the other blocks')
   * and each other, one row per lesson and member in ONE call. The year's classes are read on the basis the hand edit uses
   * (a year not yet activated is judged on the pupils its activation would place, and a year two steps ahead is refused).
   */
  private async judge(
    tx: PrismaClient,
    user: AuthenticatedUser,
    block: LoadedBlock & { academicYearId: string },
    rows: readonly BlockSlot[],
  ): Promise<{ verdicts: BlockVerdictView[] }> {
    if (rows.length === 0 || block.members.length === 0) return { verdicts: [] };
    const schoolId = requireSchoolId(user);
    const year = await tx.academicYear.findUnique({
      where: { id: block.academicYearId },
      select: { isActive: true, predecessorId: true, gradeNumbering: true },
    });
    if (!year) throw new NotFoundException('Läsåret finns inte.');
    const basis = await rostersOfYear(tx, user, block.academicYearId, { isActive: year.isActive, predecessorId: year.predecessorId });
    const beside: JudgedPlacement[] = await this.posts.besideOf(tx, { id: block.id, academicYearId: block.academicYearId }, block.id);
    const locks = new Map(
      await Promise.all(
        block.members.map(async (member) => [member.id, await this.posts.locksOf(tx, { ...member, academicYearId: block.academicYearId })] as const),
      ),
    );
    const { judged, origins } = judgedRowsOfBlock(block, rows);
    const verdicts = await judgePlacements(tx, this.masters, {
      academicYearId: block.academicYearId,
      schoolId,
      gradeNumbering: year.gradeNumbering as GradeNumbering,
      basis,
      rows: judged,
      beside,
      demand: demandOfBlockMembers([{ block, rows }], (member) => locks.get(member.id) ?? []),
    });
    return { verdicts: blockVerdictsOf(verdicts, origins) };
  }
}
