import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import {
  REQUIREMENT_IN_ANOTHER_BLOCK,
  TEACHING_BLOCK_NAME_TAKEN,
  TeachingBlocksService,
} from './teaching-blocks.service';

const YEAR = '11111111-1111-4111-8111-111111111111';
const OTHER_YEAR = '22222222-2222-4222-8222-222222222222';
const BLOCK = '33333333-3333-4333-8333-333333333333';
const OTHER_BLOCK = '44444444-4444-4444-8444-444444444444';
const TY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FR = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const row = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  academicYearId: YEAR,
  blockId: null,
  subject: { name: { [TY]: 'Tyska', [FR]: 'Franska', [SP]: 'Spanska' }[id] ?? 'Ämne' },
  studentGroup: { name: { [TY]: 'Ty7', [FR]: 'Fr7', [SP]: 'Sp7' }[id] ?? 'Grupp' },
  block: null,
  ...overrides,
});

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: Prisma.prismaVersion.client,
  });

/** The trigger's refusal as @prisma/adapter-pg hands it over (P2039 + cause). */
const tb409 = () =>
  new Prisma.PrismaClientKnownRequestError('Database error', {
    code: 'P2039',
    clientVersion: Prisma.prismaVersion.client,
    meta: {
      driverAdapterError: {
        cause: {
          originalCode: 'TB409',
          originalMessage:
            'BLOCK_MEMBERS_DIFFER: timplansposterna i blocket "Språkval åk 7" har inte samma lektioner och veckor',
          detail: `teachingBlockId=${BLOCK} requirementId=${FR} otherRequirementId=${TY}`,
        },
      },
    },
  });

describe('TeachingBlocksService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let service: TeachingBlocksService;
  const admin = testUser();

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new TeachingBlocksService(prisma as unknown as PrismaService);
    tx.teachingBlock.create.mockResolvedValue({ id: BLOCK, academicYearId: YEAR, name: 'Språkval åk 7' });
    tx.teachingRequirement.updateMany.mockImplementation(
      async ({ where }: { where: { id?: { in?: string[] } } }) => ({ count: where.id?.in?.length ?? 0 }),
    );
  });

  describe('create', () => {
    it('writes the block in the caller’s school with its name trimmed, and joins the rows in one UPDATE', async () => {
      tx.teachingRequirement.findMany.mockResolvedValue([row(TY), row(FR)]);

      const block = await service.create(
        { academicYearId: YEAR, name: '  Språkval åk 7 ', requirementIds: [FR, TY, FR] },
        admin,
      );

      expect(tx.teachingBlock.create).toHaveBeenCalledWith({
        data: { schoolId: admin.schoolId, academicYearId: YEAR, name: 'Språkval åk 7' },
        select: { id: true, academicYearId: true, name: true },
      });
      expect(block).toEqual({
        id: BLOCK,
        academicYearId: YEAR,
        name: 'Språkval åk 7',
        requirementIds: [TY, FR].sort(),
      });
      const joins = tx.teachingRequirement.updateMany.mock.calls.filter(
        ([args]) => (args as { data: { blockId: string | null } }).data.blockId === BLOCK,
      );
      expect(joins).toEqual([
        [{ where: { id: { in: [TY, FR].sort() }, blockId: null }, data: { blockId: BLOCK } }],
      ]);
    });

    it('writes no member and reads no row for a block created empty', async () => {
      const block = await service.create({ academicYearId: YEAR, name: 'Elevens val åk 8' }, admin);

      expect(block.requirementIds).toEqual([]);
      expect(tx.teachingRequirement.findMany).not.toHaveBeenCalled();
    });

    it.each(['', '   ', 'x'.repeat(81)])('refuses the name %j with a 400 naming the field', async (name) => {
      await expect(service.create({ academicYearId: YEAR, name }, admin)).rejects.toThrow(
        /^name: /,
      );
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('says a name the year already has as TEACHING_BLOCK_NAME_TAKEN', async () => {
      tx.teachingBlock.create.mockRejectedValue(p2002());

      const error = await service
        .create({ academicYearId: YEAR, name: 'Språkval åk 7' }, admin)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toEqual({
        message: 'Läsåret har redan ett block som heter "Språkval åk 7".',
        code: TEACHING_BLOCK_NAME_TAKEN,
      });
    });

    it('turns the trigger’s TB409 into the 409 BLOCK_MEMBERS_DIFFER naming the block', async () => {
      tx.teachingRequirement.findMany.mockResolvedValue([row(TY), row(FR)]);
      tx.teachingRequirement.updateMany.mockImplementation(
        async ({ data }: { data: { blockId: string | null } }) => {
          if (data.blockId !== null) throw tb409();
          return { count: 0 };
        },
      );

      const error = await service
        .create({ academicYearId: YEAR, name: 'Språkval åk 7', requirementIds: [TY, FR] }, admin)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictException);
      const body = (error as ConflictException).getResponse() as Record<string, string>;
      expect(body.code).toBe('BLOCK_MEMBERS_DIFFER');
      expect(body.teachingBlockId).toBe(BLOCK);
      expect(body.message).toContain('blocket "Språkval åk 7"');
    });
  });

  describe('membership', () => {
    beforeEach(() => {
      tx.$queryRaw = jest.fn().mockResolvedValue([{ id: BLOCK, academicYearId: YEAR, name: 'Språkval åk 7' }]);
    });

    it('lets the rows not named leave before the named ones join', async () => {
      tx.teachingRequirement.findMany.mockResolvedValue([row(TY, { blockId: BLOCK }), row(SP)]);

      const block = await service.update(BLOCK, { requirementIds: [TY, SP] }, admin);

      expect(tx.teachingRequirement.updateMany.mock.calls).toEqual([
        [{ where: { blockId: BLOCK, id: { notIn: [TY, SP].sort() } }, data: { blockId: null } }],
        [{ where: { id: { in: [SP] }, blockId: null }, data: { blockId: BLOCK } }],
      ]);
      expect(block.requirementIds).toEqual([TY, SP].sort());
    });

    it('empties the block when no row is named', async () => {
      const block = await service.update(BLOCK, { requirementIds: [] }, admin);

      expect(tx.teachingRequirement.updateMany.mock.calls).toEqual([
        [{ where: { blockId: BLOCK }, data: { blockId: null } }],
      ]);
      expect(block.requirementIds).toEqual([]);
    });

    it('locks the block row before it reads anything, and answers 404 for a block that is not there', async () => {
      tx.$queryRaw = jest.fn().mockResolvedValue([]);

      await expect(service.update(BLOCK, { name: 'Nytt namn' }, admin)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      const sql = ((tx.$queryRaw as jest.Mock).mock.calls[0][0] as readonly string[]).join('?');
      expect(sql.replace(/\s+/g, ' ').trim()).toBe(
        'SELECT "id", "academicYearId", "name" FROM "TeachingBlocks" WHERE "id" = ?::uuid FOR UPDATE',
      );
      expect(tx.teachingBlock.update).not.toHaveBeenCalled();
    });

    it('renames without touching the members when none are named', async () => {
      tx.teachingBlock.update.mockResolvedValue({ id: BLOCK, academicYearId: YEAR, name: 'Moderna språk åk 7' });
      tx.teachingRequirement.findMany.mockResolvedValue([{ id: TY }, { id: FR }]);

      const block = await service.update(BLOCK, { name: 'Moderna språk åk 7' }, admin);

      expect(block).toEqual({
        id: BLOCK,
        academicYearId: YEAR,
        name: 'Moderna språk åk 7',
        requirementIds: [TY, FR],
      });
      expect(tx.teachingRequirement.updateMany).not.toHaveBeenCalled();
    });

    it('refuses a row that is in another block, naming the row and that block', async () => {
      tx.teachingRequirement.findMany.mockResolvedValue([
        row(TY, { blockId: OTHER_BLOCK, block: { name: 'Elevens val åk 7' } }),
      ]);

      const error = await service
        .update(BLOCK, { requirementIds: [TY] }, admin)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toEqual({
        message: 'Tyska för Ty7 ligger redan i blocket "Elevens val åk 7". Ta den ur det blocket först.',
        code: REQUIREMENT_IN_ANOTHER_BLOCK,
      });
    });

    it('refuses a row of another year, and an id that is no row of the school', async () => {
      tx.teachingRequirement.findMany.mockResolvedValueOnce([row(TY, { academicYearId: OTHER_YEAR })]);
      await expect(service.update(BLOCK, { requirementIds: [TY] }, admin)).rejects.toThrow(
        'requirementIds: Tyska för Ty7 hör till ett annat läsår än blocket.',
      );

      tx.teachingRequirement.findMany.mockResolvedValueOnce([]);
      await expect(service.update(BLOCK, { requirementIds: [TY] }, admin)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('answers a row another request took meanwhile as a write conflict', async () => {
      tx.teachingRequirement.findMany.mockResolvedValue([row(TY), row(FR)]);
      tx.teachingRequirement.updateMany.mockImplementation(
        async ({ data }: { data: { blockId: string | null } }) => ({ count: data.blockId === null ? 0 : 1 }),
      );

      const error = await service
        .update(BLOCK, { requirementIds: [TY, FR] }, admin)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ConflictException);
      expect(((error as ConflictException).getResponse() as { code: string }).code).toBe('WRITE_CONFLICT');
    });
  });

  it('deletes the block and leaves the rows to the key', async () => {
    await service.remove(BLOCK, admin);

    expect(tx.teachingBlock.delete).toHaveBeenCalledWith({ where: { id: BLOCK } });
    expect(tx.teachingRequirement.updateMany).not.toHaveBeenCalled();
  });
});
