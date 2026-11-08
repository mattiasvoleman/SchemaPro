import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import {
  isSharedGradeRefusal,
  SCHOOL_PART_NAME_TAKEN,
  SCHOOL_PART_OVERLAPS,
  SCHOOL_PART_SPAN_INVALID,
  SCHOOL_PART_TEXT_INVALID,
  SchoolPartsService,
} from './school-parts.service';

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const LOW = { id: 'low', name: 'Lågstadiet', account: '4010', gradeFrom: 0, gradeTo: 3 };
const MID = { id: 'mid', name: 'Mellanstadiet', account: '4020', gradeFrom: 4, gradeTo: 6 };

const known = (code: string, meta: Record<string, unknown> = {}, message = 'x') =>
  new Prisma.PrismaClientKnownRequestError(message, { code, clientVersion: 'test', meta });

describe('SchoolPartsService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let service: SchoolPartsService;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new SchoolPartsService(prisma as unknown as PrismaService);
    tx.schoolPart.findMany.mockResolvedValue([MID, LOW]);
  });

  const codeOf = async (promise: Promise<unknown>): Promise<unknown> => {
    try {
      await promise;
    } catch (error) {
      return (error as { response?: { code?: string } }).response?.code ?? error;
    }
    return 'resolved';
  };

  it("lists the school's skoldelar in årskurs order", async () => {
    await expect(service.list(testUser())).resolves.toEqual([LOW, MID]);
    expect(tx.schoolPart.findMany).toHaveBeenCalledWith({ where: { schoolId: SCHOOL }, select: { id: true, name: true, account: true, gradeFrom: true, gradeTo: true } });
  });

  describe('create', () => {
    it('makes a skoldel for the caller\'s school, with the text trimmed', async () => {
      tx.schoolPart.create.mockResolvedValue({ id: 'high', name: 'Högstadiet', account: '4030', gradeFrom: 7, gradeTo: 9 });
      await expect(service.create({ name: '  Högstadiet ', account: ' 4030 ', gradeFrom: 7, gradeTo: 9 }, testUser())).resolves.toMatchObject({ id: 'high' });
      expect(tx.schoolPart.create).toHaveBeenCalledWith(expect.objectContaining({ data: { schoolId: SCHOOL, name: 'Högstadiet', account: '4030', gradeFrom: 7, gradeTo: 9 } }));
    });

    it('names the skoldel that already holds an årskurs, and writes nothing', async () => {
      const refused = await service.create({ name: 'Sex', account: '1', gradeFrom: 3, gradeTo: 5 }, testUser()).catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(ConflictException);
      expect((refused as ConflictException).getResponse()).toMatchObject({ code: SCHOOL_PART_OVERLAPS, message: expect.stringContaining('"Lågstadiet" (F–3)') });
      expect(tx.schoolPart.create).not.toHaveBeenCalled();
    });

    it('refuses a name the school already has, a blank or too long name or konto, a control character, and a backwards span', async () => {
      expect(await codeOf(service.create({ name: 'Lågstadiet', account: '1', gradeFrom: 7, gradeTo: 9 }, testUser()))).toBe(SCHOOL_PART_NAME_TAKEN);
      expect(await codeOf(service.create({ name: '  ', account: '1', gradeFrom: 7, gradeTo: 9 }, testUser()))).toBe(SCHOOL_PART_TEXT_INVALID);
      expect(await codeOf(service.create({ name: 'x'.repeat(101), account: '1', gradeFrom: 7, gradeTo: 9 }, testUser()))).toBe(SCHOOL_PART_TEXT_INVALID);
      expect(await codeOf(service.create({ name: 'Hög', account: '4\t0', gradeFrom: 7, gradeTo: 9 }, testUser()))).toBe(SCHOOL_PART_TEXT_INVALID);
      expect(await codeOf(service.create({ name: 'Hög', account: '9'.repeat(31), gradeFrom: 7, gradeTo: 9 }, testUser()))).toBe(SCHOOL_PART_TEXT_INVALID);
      expect(await codeOf(service.create({ name: 'Hög', account: '1', gradeFrom: 9, gradeTo: 7 }, testUser()))).toBe(SCHOOL_PART_SPAN_INVALID);
      expect(tx.schoolPart.create).not.toHaveBeenCalled();
    });

    it('counts characters, not bytes: 100 letters å are a name', async () => {
      tx.schoolPart.create.mockResolvedValue(LOW);
      await expect(service.create({ name: 'å'.repeat(100), account: 'å'.repeat(30), gradeFrom: 7, gradeTo: 9 }, testUser())).resolves.toBeDefined();
    });

    it('answers a second writer\'s name and årskurs the way the checks would have', async () => {
      tx.schoolPart.create.mockRejectedValueOnce(known('P2002'));
      expect(await codeOf(service.create({ name: 'Hög', account: '1', gradeFrom: 7, gradeTo: 9 }, testUser()))).toBe(SCHOOL_PART_NAME_TAKEN);
      tx.schoolPart.create.mockRejectedValueOnce(known('P2010', { driverAdapterError: { cause: { originalCode: '23P01' } } }));
      expect(await codeOf(service.create({ name: 'Hög', account: '1', gradeFrom: 7, gradeTo: 9 }, testUser()))).toBe(SCHOOL_PART_OVERLAPS);
      tx.schoolPart.create.mockRejectedValueOnce(new Error('boom'));
      await expect(service.create({ name: 'Hög', account: '1', gradeFrom: 7, gradeTo: 9 }, testUser())).rejects.toThrow('boom');
    });
  });

  describe('update', () => {
    it('changes what is sent and keeps the rest, and may keep its own årskurser and name', async () => {
      tx.schoolPart.update.mockResolvedValue({ ...LOW, account: '4011' });
      await service.update('low', { account: '4011' }, testUser());
      expect(tx.schoolPart.update).toHaveBeenCalledWith({ where: { id: 'low' }, data: { account: '4011', gradeFrom: 0, gradeTo: 3 }, select: expect.anything() });
      await service.update('low', { name: 'Lågstadiet', gradeFrom: 0, gradeTo: 2 }, testUser());
      expect(tx.schoolPart.update).toHaveBeenLastCalledWith({ where: { id: 'low' }, data: { name: 'Lågstadiet', gradeFrom: 0, gradeTo: 2 }, select: expect.anything() });
    });

    it('refuses to grow into another skoldel, to take its name, or to run backwards, and answers 404 for none', async () => {
      expect(await codeOf(service.update('low', { gradeTo: 4 }, testUser()))).toBe(SCHOOL_PART_OVERLAPS);
      expect(await codeOf(service.update('low', { name: 'Mellanstadiet' }, testUser()))).toBe(SCHOOL_PART_NAME_TAKEN);
      expect(await codeOf(service.update('mid', { gradeFrom: 7 }, testUser()))).toBe(SCHOOL_PART_SPAN_INVALID);
      expect(await codeOf(service.update('low', { name: '' }, testUser()))).toBe(SCHOOL_PART_TEXT_INVALID);
      expect(await codeOf(service.update('low', { account: '\u0001' }, testUser()))).toBe(SCHOOL_PART_TEXT_INVALID);
      await expect(service.update('nobody', { account: '1' }, testUser())).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.schoolPart.update).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('removes a skoldel, and answers 404 for one that is not there or that row security hides', async () => {
      tx.schoolPart.deleteMany.mockResolvedValueOnce({ count: 1 });
      await expect(service.remove('low', testUser())).resolves.toBeUndefined();
      expect(tx.schoolPart.deleteMany).toHaveBeenCalledWith({ where: { id: 'low' } });
      tx.schoolPart.deleteMany.mockResolvedValueOnce({ count: 0 });
      await expect(service.remove('low', testUser())).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('isSharedGradeRefusal', () => {
    it('knows the exclusion by its code, by its name and by the adapter\'s message, and nothing else', () => {
      expect(isSharedGradeRefusal(known('P2010', { driverAdapterError: { cause: { originalCode: '23P01' } } }))).toBe(true);
      expect(isSharedGradeRefusal(known('P2010', {}, 'conflicting key value violates exclusion constraint "SchoolParts_no_shared_grade"'))).toBe(true);
      expect(isSharedGradeRefusal(known('P2039', {}, 'Code: `23P01`'))).toBe(true);
      expect(isSharedGradeRefusal(known('P2002'))).toBe(false);
      expect(isSharedGradeRefusal(new Error('SchoolParts_no_shared_grade'))).toBe(false);
    });
  });
});
