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
import { SubjectsService } from './subjects.service';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const SUBJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROOM_TYPE_ID = '88888888-8888-4888-8888-888888888888';

const prismaError = (code: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError(`Simulated ${code}`, {
    code,
    clientVersion: Prisma.prismaVersion.client,
  });

describe('SubjectsService', () => {
  let service: SubjectsService;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new SubjectsService(prisma as unknown as PrismaService);
  });

  describe('create', () => {
    it('stamps the tenant from the principal and answers with the stored row', async () => {
      const row = { id: SUBJECT_ID, name: 'Matematik' };
      tx.subject.create.mockResolvedValue(row);
      const user = testUser();

      await expect(service.create({ name: 'Matematik' }, user)).resolves.toBe(row);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.subject.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          name: 'Matematik',
          code: null,
          color: null,
          requiredRoomTypeId: null,
          // A subject nobody mapped is outside the national timplan and still
          // undervisning: today's behaviour for every existing school.
          nationalCode: null,
          countsTowardTimplan: true,
        },
      });
      // No code given, so the reference table is not consulted at all.
      expect(tx.nationalSubject.findUnique).not.toHaveBeenCalled();
    });

    it('keeps the code, the colour and the room type it was given', async () => {
      /*
       * `requiredRoomTypeId` is the one room rule the optimiser applies to a
       * subject school-wide. Dropped on the way in, kemi is stored without it
       * and lands in any classroom on the next run, with nothing on the
       * subject page to say why.
       */
      tx.subject.create.mockResolvedValue({ id: SUBJECT_ID });

      await service.create(
        {
          name: 'Kemi',
          code: 'KE',
          color: '#aa3300',
          requiredRoomTypeId: ROOM_TYPE_ID,
        },
        testUser(),
      );

      expect(tx.subject.create).toHaveBeenCalledWith({
        data: {
          schoolId: SCHOOL_ID,
          name: 'Kemi',
          code: 'KE',
          color: '#aa3300',
          requiredRoomTypeId: ROOM_TYPE_ID,
          nationalCode: null,
          countsTowardTimplan: true,
        },
      });
    });

    describe('the national code', () => {
      it('looks the code up in the reference table inside the transaction, then writes it', async () => {
        tx.nationalSubject.findUnique.mockResolvedValue({ code: 'KE' });
        tx.subject.create.mockResolvedValue({ id: SUBJECT_ID });

        await service.create({ name: 'Kemi', nationalCode: 'KE' }, testUser());

        expect(tx.nationalSubject.findUnique).toHaveBeenCalledWith({
          where: { code: 'KE' },
          select: { code: true },
        });
        expect(tx.subject.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ nationalCode: 'KE' }),
        });
      });

      it('refuses an unknown code with a 400 that names the field, before any write', async () => {
        // The FK would refuse it too, as a 409 about "a record" — this is what
        // gives the admin the field and the value instead.
        tx.nationalSubject.findUnique.mockResolvedValue(null);

        await expect(
          service.create({ name: 'Kemi', nationalCode: 'KEMI' }, testUser()),
        ).rejects.toMatchObject({
          constructor: BadRequestException,
          message: expect.stringMatching(/nationalCode.*"KEMI"/),
        });
        expect(tx.subject.create).not.toHaveBeenCalled();
      });

      it('folds case and whitespace into the code the table holds', async () => {
        // NationalSubjects.code is ^[A-Z][A-Z0-9_]*$, so "ma" can only have
        // meant MA; the FK is case-exact and would have refused it.
        tx.nationalSubject.findUnique.mockResolvedValue({ code: 'MA' });
        tx.subject.create.mockResolvedValue({ id: SUBJECT_ID });

        await service.create({ name: 'Matte', nationalCode: ' ma ' }, testUser());

        expect(tx.nationalSubject.findUnique).toHaveBeenCalledWith(
          expect.objectContaining({ where: { code: 'MA' } }),
        );
        expect(tx.subject.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ nationalCode: 'MA' }),
        });
      });

      it('reads an empty string as no mapping, not as a code to look up', async () => {
        tx.subject.create.mockResolvedValue({ id: SUBJECT_ID });

        await service.create({ name: 'Mentorstid', nationalCode: '' }, testUser());

        expect(tx.nationalSubject.findUnique).not.toHaveBeenCalled();
        expect(tx.subject.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ nationalCode: null }),
        });
      });

      it('writes countsTowardTimplan false when told so', async () => {
        tx.subject.create.mockResolvedValue({ id: SUBJECT_ID });

        await service.create(
          { name: 'Resurs', countsTowardTimplan: false },
          testUser(),
        );

        expect(tx.subject.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ countsTowardTimplan: false }),
        });
      });
    });

    it('rejects a principal with no school before opening a transaction', async () => {
      await expect(
        service.create({ name: 'Matematik' }, testUser({ schoolId: undefined })),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('maps a duplicate subject (P2002) to 409', async () => {
      tx.subject.create.mockRejectedValue(prismaError('P2002'));

      await expect(
        service.create({ name: 'Matematik' }, testUser()),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('update', () => {
    it('writes by id under the caller’s RLS context and answers with the row', async () => {
      const row = { id: SUBJECT_ID, name: 'Fysik' };
      tx.subject.update.mockResolvedValue(row);
      const user = testUser();

      await expect(
        service.update(SUBJECT_ID, { name: 'Fysik' }, user),
      ).resolves.toBe(row);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.subject.update).toHaveBeenCalledWith({
        where: { id: SUBJECT_ID },
        data: { name: 'Fysik' },
      });
    });

    // Each field on its own, because each is its own way to lose an edit: a
    // PATCH whose one field is dropped saves nothing and still answers 200.
    it.each([
      ['name', { name: 'Fysik' }],
      ['code', { code: 'FY' }],
      ['color', { color: '#0055ff' }],
      ['requiredRoomTypeId', { requiredRoomTypeId: ROOM_TYPE_ID }],
      ['countsTowardTimplan', { countsTowardTimplan: false }],
    ])('a PATCH naming only %s writes it', async (_field, patch) => {
      tx.subject.update.mockResolvedValue({ id: SUBJECT_ID });

      await service.update(SUBJECT_ID, patch, testUser());

      expect(tx.subject.update).toHaveBeenCalledWith({
        where: { id: SUBJECT_ID },
        data: patch,
      });
      expect(tx.nationalSubject.findUnique).not.toHaveBeenCalled();
    });

    it('a PATCH naming a national code looks it up and writes it', async () => {
      tx.nationalSubject.findUnique.mockResolvedValue({ code: 'FY' });
      tx.subject.update.mockResolvedValue({ id: SUBJECT_ID });

      await service.update(SUBJECT_ID, { nationalCode: 'fy' }, testUser());

      expect(tx.nationalSubject.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { code: 'FY' } }),
      );
      expect(tx.subject.update).toHaveBeenCalledWith({
        where: { id: SUBJECT_ID },
        data: { nationalCode: 'FY' },
      });
    });

    it('refuses an unknown national code on a PATCH without touching the row', async () => {
      tx.nationalSubject.findUnique.mockResolvedValue(null);

      await expect(
        service.update(SUBJECT_ID, { nationalCode: 'XX' }, testUser()),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.subject.update).not.toHaveBeenCalled();
    });

    it('clears the optionals with an explicit null, which is not the same as leaving them out', async () => {
      tx.subject.update.mockResolvedValue({ id: SUBJECT_ID });

      await service.update(
        SUBJECT_ID,
        { code: null, color: null, requiredRoomTypeId: null, nationalCode: null },
        testUser(),
      );

      expect(tx.subject.update).toHaveBeenCalledWith({
        where: { id: SUBJECT_ID },
        data: { code: null, color: null, requiredRoomTypeId: null, nationalCode: null },
      });
      // Clearing a mapping is not a code to look up.
      expect(tx.nationalSubject.findUnique).not.toHaveBeenCalled();
    });

    it('maps P2025 (unknown or cross-tenant id) to 404', async () => {
      tx.subject.update.mockRejectedValue(prismaError('P2025'));

      await expect(
        service.update(SUBJECT_ID, { name: 'Fysik' }, testUser()),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    it('deletes by id under the caller’s RLS context', async () => {
      tx.subject.delete.mockResolvedValue({ id: SUBJECT_ID });
      const user = testUser();

      await expect(service.remove(SUBJECT_ID, user)).resolves.toBeUndefined();

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.subject.delete).toHaveBeenCalledWith({
        where: { id: SUBJECT_ID },
      });
    });

    it('maps P2025 (unknown or cross-tenant id) to 404', async () => {
      tx.subject.delete.mockRejectedValue(prismaError('P2025'));

      await expect(service.remove(SUBJECT_ID, testUser())).rejects.toThrow(
        NotFoundException,
      );
    });

    it('asks which decided plans hold the subject before deleting it', async () => {
      tx.subject.delete.mockResolvedValue({ id: SUBJECT_ID });

      await service.remove(SUBJECT_ID, testUser());

      expect(tx.localTimplan.findMany).toHaveBeenCalledWith({
        where: { status: 'DECIDED', entries: { some: { subjectId: SUBJECT_ID } } },
        select: { name: true },
        orderBy: { name: 'asc' },
      });
    });

    it('409s a subject that decided plans contain, naming every one, and deletes nothing', async () => {
      tx.localTimplan.findMany.mockResolvedValue([
        { name: 'Grundskolan 2024' },
        { name: 'Anpassad 2023' },
      ]);

      const error = await service.remove(SUBJECT_ID, testUser()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      const body = (error as ConflictException).getResponse() as { code: string; message: string };
      expect(body.code).toBe('TIMPLAN_IS_DECIDED');
      expect(body.message).toContain(
        'de beslutade lokala timplanerna "Grundskolan 2024" och "Anpassad 2023"',
      );
      expect(body.message).toContain('Ta bort de beslutade timplanerna först');
      expect(tx.subject.delete).not.toHaveBeenCalled();
    });

    it('turns the trigger’s refusal — a plan decided after the question — into the same 409', async () => {
      const message =
        'TIMPLAN_IS_DECIDED: lokal timplan "Grundskolan 2024" är beslutad och dess poster kan inte ändras';
      tx.subject.delete.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError(`Database error. Code: \`TP409\`. Message: \`${message}\``, {
          code: 'P2039',
          clientVersion: Prisma.prismaVersion.client,
          meta: {
            driverAdapterError: {
              cause: { originalCode: 'TP409', originalMessage: message, detail: 'localTimplanId=x' },
            },
          },
        }),
      );

      const error = await service.remove(SUBJECT_ID, testUser()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'TIMPLAN_IS_DECIDED',
        message: expect.stringContaining('den beslutade lokala timplanen "Grundskolan 2024"'),
      });
    });
  });
});
