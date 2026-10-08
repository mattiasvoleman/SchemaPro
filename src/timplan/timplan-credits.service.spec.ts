import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  createPrismaMock,
  createTxMock,
  testUser,
  type PrismaMock,
  type TxMock,
} from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { CreateTimplanCreditDto, UpdateTimplanCreditDto } from './dto/timplan-credit.dto';
import { TimplanCreditsService } from './timplan-credits.service';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const YEAR_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_YEAR_ID = '45454545-4545-4545-8545-454545454545';
const GROUP_ID = '55555555-5555-4555-8555-555555555555';
const SUBJECT_ID = '99999999-9999-4999-8999-999999999999';
const CREDIT_ID = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';

const YEAR = {
  id: YEAR_ID,
  name: '2026/27',
  startDate: new Date('2026-08-17T00:00:00.000Z'),
  endDate: new Date('2027-06-11T00:00:00.000Z'),
};

const stored = (overrides: Record<string, unknown> = {}) => ({
  id: CREDIT_ID,
  academicYearId: YEAR_ID,
  date: new Date('2026-09-25T00:00:00.000Z'),
  minutes: 300,
  subjectId: SUBJECT_ID,
  studentGroupId: null,
  minGradeLevel: 7,
  maxGradeLevel: 9,
  name: 'Friluftsdag',
  note: null,
  academicYear: YEAR,
  ...overrides,
});

/** What Prisma hands back for a write: the select's columns of the data. */
const echo = (base: Record<string, unknown>) => (args: { data: Record<string, unknown> }) =>
  Promise.resolve({ ...base, ...args.data, id: CREDIT_ID });

describe('TimplanCreditsService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let service: TimplanCreditsService;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new TimplanCreditsService(prisma as unknown as PrismaService);
    tx.academicYear.findUnique.mockResolvedValue(YEAR);
    tx.studentGroup.findUnique.mockResolvedValue({ academicYearId: YEAR_ID, name: '7A' });
    tx.subject.findUnique.mockResolvedValue({ id: SUBJECT_ID });
    tx.timplanCredit.create.mockImplementation(echo({}));
  });

  const body = (overrides: Record<string, unknown> = {}) =>
    ({
      academicYearId: YEAR_ID,
      date: '2026-09-25',
      minutes: 300,
      subjectId: SUBJECT_ID,
      minGradeLevel: 7,
      maxGradeLevel: 9,
      name: '  Friluftsdag ',
      note: '   ',
      ...overrides,
    }) as CreateTimplanCreditDto;

  describe('create', () => {
    it('writes the decision under the caller’s RLS, trimmed, a blank note as none, and answers dates as days', async () => {
      const user = testUser();
      await expect(service.create(body(), user)).resolves.toEqual({
        id: CREDIT_ID,
        academicYearId: YEAR_ID,
        date: '2026-09-25',
        minutes: 300,
        subjectId: SUBJECT_ID,
        studentGroupId: null,
        minGradeLevel: 7,
        maxGradeLevel: 9,
        name: 'Friluftsdag',
        note: null,
      });
      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      expect(tx.timplanCredit.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            schoolId: SCHOOL_ID,
            academicYearId: YEAR_ID,
            date: new Date('2026-09-25T00:00:00.000Z'),
            minutes: 300,
            subjectId: SUBJECT_ID,
            studentGroupId: null,
            minGradeLevel: 7,
            maxGradeLevel: 9,
            name: 'Friluftsdag',
            note: null,
          },
        }),
      );
    });

    it('takes no subject as undervisningstid without one, and no scope as the whole school', async () => {
      await service.create(body({ subjectId: null, minGradeLevel: undefined, maxGradeLevel: undefined }), testUser());
      expect(tx.timplanCredit.create.mock.calls[0]![0].data).toMatchObject({
        subjectId: null,
        studentGroupId: null,
        minGradeLevel: null,
        maxGradeLevel: null,
      });
      expect(tx.subject.findUnique).not.toHaveBeenCalled();
    });

    it.each([
      ['the day before the year', '2026-08-16'],
      ['the day after it', '2027-06-12'],
    ])('400s %s with TIMPLAN_CREDIT_OUTSIDE_YEAR, naming the field and the bounds', async (_label, date) => {
      const error = await service.create(body({ date }), testUser()).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'TIMPLAN_CREDIT_OUTSIDE_YEAR',
        message: `date: ${date} ligger utanför läsåret 2026/27 (2026-08-17–2027-06-11).`,
      });
      expect(tx.timplanCredit.create).not.toHaveBeenCalled();
    });

    it('takes the year’s first and last day', async () => {
      await service.create(body({ date: '2026-08-17' }), testUser());
      await service.create(body({ date: '2027-06-11' }), testUser());
      expect(tx.timplanCredit.create).toHaveBeenCalledTimes(2);
    });

    it('400s a group of another läsår, and one RLS hides', async () => {
      tx.studentGroup.findUnique.mockResolvedValueOnce({ academicYearId: OTHER_YEAR_ID, name: '8A' });
      const scoped = body({ studentGroupId: GROUP_ID, minGradeLevel: undefined, maxGradeLevel: undefined });
      const error = await service.create(scoped, testUser()).catch((thrown: unknown) => thrown);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'TIMPLAN_CREDIT_GROUP_OF_ANOTHER_YEAR',
        message: 'studentGroupId: 8A hör till ett annat läsår än 2026/27.',
      });
      tx.studentGroup.findUnique.mockResolvedValueOnce(null);
      await expect(service.create(scoped, testUser())).rejects.toThrow('studentGroupId: gruppen finns inte.');
      expect(tx.timplanCredit.create).not.toHaveBeenCalled();
    });

    it('400s a subject or a year RLS hides, naming the field', async () => {
      tx.subject.findUnique.mockResolvedValueOnce(null);
      await expect(service.create(body(), testUser())).rejects.toThrow('subjectId: ämnet finns inte.');
      tx.academicYear.findUnique.mockResolvedValueOnce(null);
      await expect(service.create(body(), testUser())).rejects.toThrow('academicYearId: läsåret finns inte.');
    });

    it.each([
      ['a group and a span together', { studentGroupId: GROUP_ID }, 'studentGroupId: '],
      ['half a span', { maxGradeLevel: undefined }, 'minGradeLevel och maxGradeLevel anges tillsammans'],
      ['a span upside down', { minGradeLevel: 9, maxGradeLevel: 7 }, 'minGradeLevel: åk 9 ligger efter åk 7'],
    ])('400s %s with TIMPLAN_CREDIT_SCOPE before reading anything', async (_label, overrides, message) => {
      const error = await service.create(body(overrides), testUser()).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(BadRequestException);
      const response = (error as BadRequestException).getResponse() as { code: string; message: string };
      expect(response.code).toBe('TIMPLAN_CREDIT_SCOPE');
      expect(response.message).toContain(message);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('answers a key the read could not see coming with a 400 naming the field', async () => {
      tx.timplanCredit.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('Foreign key constraint violated on the constraint: `TimplanCredits_subjectId_schoolId_fkey`', {
          code: 'P2003',
          clientVersion: Prisma.prismaVersion.client,
        }),
      );
      await expect(service.create(body(), testUser())).rejects.toThrow(
        new BadRequestException('subjectId: finns inte i skolan.'),
      );
    });

    it('answers a CHECK reached past the DTO with a 400 naming the field', async () => {
      tx.timplanCredit.create.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError(
          'new row for relation "TimplanCredits" violates check constraint "TimplanCredits_minutes_is_sane"',
          { code: 'P2039', clientVersion: Prisma.prismaVersion.client },
        ),
      );
      await expect(service.create(body(), testUser())).rejects.toThrow(
        new BadRequestException('minutes: 1 till 600 minuter för dagen, i hela minuter.'),
      );
    });
  });

  describe('update', () => {
    beforeEach(() => {
      tx.timplanCredit.findUnique.mockResolvedValue(stored());
      tx.timplanCredit.update.mockImplementation(echo(stored({ academicYear: undefined })));
    });

    it('leaves the scope alone when the PATCH names none of it', async () => {
      await service.update(CREDIT_ID, { minutes: 240 }, testUser());
      expect(tx.timplanCredit.update.mock.calls[0]![0].data).toEqual({ minutes: 240 });
    });

    it('replaces the whole scope when it names any of it: a group clears the span', async () => {
      await service.update(CREDIT_ID, { studentGroupId: GROUP_ID }, testUser());
      expect(tx.timplanCredit.update.mock.calls[0]![0].data).toEqual({
        studentGroupId: GROUP_ID,
        minGradeLevel: null,
        maxGradeLevel: null,
      });
      expect(tx.studentGroup.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: GROUP_ID } }));
    });

    it('refuses half a span named alone rather than merging it with the stored half', async () => {
      const error = await service
        .update(CREDIT_ID, { minGradeLevel: 8 }, testUser())
        .catch((thrown: unknown) => thrown);
      expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'TIMPLAN_CREDIT_SCOPE' });
      expect(tx.timplanCredit.update).not.toHaveBeenCalled();
    });

    it('makes the credit the whole school’s when all three are null', async () => {
      await service.update(CREDIT_ID, { studentGroupId: null, minGradeLevel: null, maxGradeLevel: null }, testUser());
      expect(tx.timplanCredit.update.mock.calls[0]![0].data).toEqual({
        studentGroupId: null,
        minGradeLevel: null,
        maxGradeLevel: null,
      });
    });

    it('checks a new date against the credit’s own läsår', async () => {
      const error = await service.update(CREDIT_ID, { date: '2027-08-20' }, testUser()).catch((thrown: unknown) => thrown);
      expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'TIMPLAN_CREDIT_OUTSIDE_YEAR' });
    });

    it('asks nothing of a stored group or subject the PATCH does not touch', async () => {
      tx.timplanCredit.findUnique.mockResolvedValue(stored({ studentGroupId: GROUP_ID, minGradeLevel: null, maxGradeLevel: null }));
      tx.studentGroup.findUnique.mockResolvedValue({ academicYearId: OTHER_YEAR_ID, name: '8A' });
      await service.update(CREDIT_ID, { name: 'Friluftsdag höst', note: 'Beslut 2026-09-01' }, testUser());
      expect(tx.studentGroup.findUnique).not.toHaveBeenCalled();
      expect(tx.subject.findUnique).not.toHaveBeenCalled();
      expect(tx.timplanCredit.update.mock.calls[0]![0].data).toEqual({
        name: 'Friluftsdag höst',
        note: 'Beslut 2026-09-01',
      });
    });

    it('404s a credit RLS hides', async () => {
      tx.timplanCredit.findUnique.mockResolvedValue(null);
      await expect(service.update(CREDIT_ID, { minutes: 60 }, testUser())).rejects.toThrow(NotFoundException);
    });
  });

  describe('list and remove', () => {
    it('lists the year’s credits by date, and 404s a year RLS hides', async () => {
      tx.timplanCredit.findMany.mockResolvedValue([stored({ academicYear: undefined })]);
      await expect(service.list(YEAR_ID, testUser())).resolves.toMatchObject([{ id: CREDIT_ID, date: '2026-09-25' }]);
      expect(tx.timplanCredit.findMany.mock.calls[0]![0]).toMatchObject({
        where: { academicYearId: YEAR_ID },
        orderBy: [{ date: 'asc' }, { name: 'asc' }, { id: 'asc' }],
      });
      tx.academicYear.findUnique.mockResolvedValue(null);
      await expect(service.list(YEAR_ID, testUser())).rejects.toThrow('Läsåret finns inte.');
    });

    it('404s deleting a credit RLS hides', async () => {
      tx.timplanCredit.delete.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('not found', { code: 'P2025', clientVersion: Prisma.prismaVersion.client }),
      );
      await expect(service.remove(CREDIT_ID, testUser())).rejects.toThrow(NotFoundException);
    });
  });
});

describe('the credit DTOs mirror every CHECK', () => {
  const failing = async (cls: typeof CreateTimplanCreditDto | typeof UpdateTimplanCreditDto, body: object) =>
    (await validate(plainToInstance(cls, body))).map((error) => error.property).sort();
  const valid = {
    academicYearId: YEAR_ID,
    date: '2026-09-25',
    minutes: 300,
    name: 'Friluftsdag',
  };

  it.each([
    ['minutes 1 and 600 pass', { minutes: 1 }, []],
    ['600 passes', { minutes: 600 }, []],
    ['0', { minutes: 0 }, ['minutes']],
    ['601', { minutes: 601 }, ['minutes']],
    ['a fraction', { minutes: 30.5 }, ['minutes']],
    ['a date that does not exist', { date: '2026-02-30' }, ['date']],
    ['a timestamp', { date: '2026-09-25T00:00:00Z' }, ['date']],
    ['grade 13', { minGradeLevel: 7, maxGradeLevel: 13 }, ['maxGradeLevel']],
    ['grade -1', { minGradeLevel: -1, maxGradeLevel: 9 }, ['minGradeLevel']],
    ['a blank name', { name: '   ' }, ['name']],
    ['a tab-only name', { name: '\t' }, ['name']],
    ['an NBSP-only name', { name: '  ' }, ['name']],
    ['80 code points', { name: 'å'.repeat(80) }, []],
    ['81 code points', { name: 'å'.repeat(81) }, ['name']],
    ['a 500 note', { note: 'x'.repeat(500) }, []],
    ['a 501 note', { note: 'x'.repeat(501) }, ['note']],
    ['a null subject', { subjectId: null }, []],
    ['a subject that is no id', { subjectId: 'Idrott' }, ['subjectId']],
  ])('create: %s', async (_label, overrides, fields) => {
    await expect(failing(CreateTimplanCreditDto, { ...valid, ...overrides })).resolves.toEqual(fields);
  });

  it('PATCH refuses null on the NOT NULL fields and takes it on the scope', async () => {
    await expect(failing(UpdateTimplanCreditDto, { date: null, minutes: null, name: null })).resolves.toEqual([
      'date',
      'minutes',
      'name',
    ]);
    await expect(
      failing(UpdateTimplanCreditDto, { studentGroupId: null, minGradeLevel: null, maxGradeLevel: null, subjectId: null }),
    ).resolves.toEqual([]);
  });

  it('refuses academicYearId on a PATCH: a credit does not move year', async () => {
    // whitelist + forbidNonWhitelisted refuse the property at the pipe; here
    // it is simply not a property of the class.
    expect(Object.keys(plainToInstance(UpdateTimplanCreditDto, {}))).not.toContain('academicYearId');
  });
});
