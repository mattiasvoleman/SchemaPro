import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { RoomTypesService } from './room-types.service';

const TYPE_ID = '77777777-7777-4777-8777-777777777777';
const OTHER_TYPE_ID = '78787878-7878-4878-8878-787878787878';

const schoolless = () => ({ ...testUser(), schoolId: undefined });

const prismaError = (code: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError(`Simulated ${code}`, {
    code,
    clientVersion: Prisma.prismaVersion.client,
  });

describe('RoomTypesService', () => {
  let service: RoomTypesService;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new RoomTypesService(prisma as unknown as PrismaService);
  });

  describe('list', () => {
    it('runs under the caller and returns usage counts the delete guard needs', async () => {
      tx.roomType.findMany.mockResolvedValue([]);

      await service.list(testUser());

      expect(prisma.withRls).toHaveBeenCalledWith(
        expect.objectContaining({ userId: testUser().userId }),
        expect.any(Function),
      );
      expect(tx.roomType.findMany).toHaveBeenCalledWith({
        orderBy: { name: 'asc' },
        include: { _count: { select: { rooms: true, subjects: true } } },
      });
    });
  });

  describe('create', () => {
    it('stamps the tenant from the principal and trims the name', async () => {
      tx.roomType.create.mockResolvedValue({ id: TYPE_ID });

      await service.create({ name: '  Hemkunskapssal ' }, testUser());

      expect(tx.roomType.create).toHaveBeenCalledWith({
        data: { schoolId: testUser().schoolId, name: 'Hemkunskapssal' },
      });
    });

    it('rejects a school-less principal before touching the database', async () => {
      await expect(
        service.create({ name: 'Textilslöjd' }, schoolless()),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('maps a name the school already uses (P2002) to 409', async () => {
      tx.roomType.create.mockRejectedValue(prismaError('P2002'));

      await expect(
        service.create({ name: 'Hemkunskapssal' }, testUser()),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('update', () => {
    it('renames without clearing anything when the name is omitted', async () => {
      tx.roomType.update.mockResolvedValue({ id: TYPE_ID });

      await service.update(TYPE_ID, {}, testUser());

      expect(tx.roomType.update).toHaveBeenCalledWith({
        where: { id: TYPE_ID },
        data: {},
      });
    });

    it('trims a renamed type', async () => {
      tx.roomType.update.mockResolvedValue({ id: TYPE_ID });

      await service.update(TYPE_ID, { name: ' Trä- och metallslöjd ' }, testUser());

      expect(tx.roomType.update).toHaveBeenCalledWith({
        where: { id: TYPE_ID },
        data: { name: 'Trä- och metallslöjd' },
      });
    });

    it('maps an unknown or cross-tenant id (P2025) to 404', async () => {
      tx.roomType.update.mockRejectedValue(prismaError('P2025'));

      await expect(
        service.update(TYPE_ID, { name: 'Kemisal' }, testUser()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('remove', () => {
    /**
     * The type as the delete guard's own query gets it back from Prisma.
     *
     * `_count` carries only the relations the include names, and a count that
     * selects nothing is refused, as Prisma refuses a `select` with no truthy
     * field in it. A stub that hands back both counts whatever was asked would
     * let a guard that stopped counting subjects delete a type four subjects
     * still require.
     */
    const givenType = (counts: { rooms: number; subjects: number }) => {
      tx.roomType.findUnique.mockImplementation(
        ({
          where,
          include,
        }: {
          where?: { id?: string };
          include?: { _count?: boolean | { select?: Record<string, boolean> } };
        }) => {
          if (where?.id === undefined) {
            throw new Error('Prisma: findUnique needs a unique field in `where`.');
          }
          if (where.id !== TYPE_ID) return Promise.resolve(null);

          const row: Record<string, unknown> = { id: TYPE_ID, name: 'Kemisal' };
          const count = include?._count;
          if (count) {
            const selection =
              typeof count === 'object' && count.select
                ? count.select
                : { rooms: true, subjects: true };
            const fields = (Object.keys(selection) as Array<keyof typeof counts>)
              .filter((field) => selection[field]);
            if (fields.length === 0) {
              throw new Error('Prisma: a `select` needs at least one truthy value.');
            }
            row['_count'] = Object.fromEntries(
              fields.map((field) => [field, counts[field]]),
            );
          }
          return Promise.resolve(row);
        },
      );
    };

    /** The whole sentence the admin reads, so a half-built one fails too. */
    const refusal = (usage: string) =>
      new BadRequestException(
        `Salstypen används av ${usage} och kan inte tas bort. Byt typ på dem först.`,
      );

    it('deletes a type nothing references', async () => {
      givenType({ rooms: 0, subjects: 0 });

      await expect(service.remove(TYPE_ID, testUser())).resolves.toEqual({
        id: TYPE_ID,
      });
      expect(tx.roomType.delete).toHaveBeenCalledWith({ where: { id: TYPE_ID } });
    });

    it('refuses when rooms still use it, naming the rooms and nothing else', async () => {
      givenType({ rooms: 3, subjects: 0 });

      await expect(service.remove(TYPE_ID, testUser())).rejects.toThrow(
        refusal('3 sal(ar)'),
      );
      expect(tx.roomType.delete).not.toHaveBeenCalled();
    });

    it('refuses when a subject requires it — the case that breaks scheduling', async () => {
      // A subject pointing at a deleted type would leave the requirement
      // unsatisfiable and surface as "No room satisfies capacity/type".
      givenType({ rooms: 0, subjects: 2 });

      await expect(service.remove(TYPE_ID, testUser())).rejects.toThrow(
        refusal('2 ämne(n)'),
      );
      expect(tx.roomType.delete).not.toHaveBeenCalled();
    });

    it('names both when rooms and subjects reference it', async () => {
      givenType({ rooms: 1, subjects: 4 });

      await expect(service.remove(TYPE_ID, testUser())).rejects.toThrow(
        refusal('1 sal(ar) och 4 ämne(n)'),
      );
    });

    it('is idempotent for an unknown id', async () => {
      givenType({ rooms: 0, subjects: 0 });

      await expect(service.remove(OTHER_TYPE_ID, testUser())).resolves.toEqual({
        id: OTHER_TYPE_ID,
      });
      expect(tx.roomType.delete).not.toHaveBeenCalled();
    });
  });
});
