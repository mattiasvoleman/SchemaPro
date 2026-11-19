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
    it('stamps the tenant from the principal and answers with the stored row, its factor a number', async () => {
      // Prisma hands NUMERIC(4,3) back as a Decimal; the answer carries a number.
      const row = { id: SUBJECT_ID, name: 'Matematik', loadFactor: new Prisma.Decimal('1.000') };
      tx.subject.create.mockResolvedValue(row);
      const user = testUser();

      await expect(service.create({ name: 'Matematik' }, user)).resolves.toEqual({
        id: SUBJECT_ID,
        name: 'Matematik',
        loadFactor: 1,
      });

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
          // The minutes as they are: what every subject reads under MINUTES.
          loadFactor: 1,
          // No ämnesfördelning: school rules are off until a school sets them.
          maxLessonsPerDay: null,
          minDaysBetween: null,
          // No placement rule: a subject is unmarked until a school marks it.
          notFirstInDay: false,
          notLastInDay: false,
          // Its own behörighet, until a school says "som i ett annat ämne".
          qualificationSubjectId: null,
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
      tx.roomType.findFirst.mockResolvedValue({ id: ROOM_TYPE_ID });

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
          loadFactor: 1,
          maxLessonsPerDay: null,
          minDaysBetween: null,
          notFirstInDay: false,
          notLastInDay: false,
          qualificationSubjectId: null,
        },
      });
    });

    it('writes the two placement marks it was given (Placeringsregler, regel 1)', async () => {
      tx.subject.create.mockResolvedValue({ id: SUBJECT_ID, name: 'Idrott', loadFactor: new Prisma.Decimal('1.000'), notFirstInDay: true, notLastInDay: true });

      const answer = await service.create({ name: 'Idrott', notFirstInDay: true, notLastInDay: true }, testUser());

      expect(tx.subject.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ notFirstInDay: true, notLastInDay: true }),
      });
      // The answer carries them under exactly these names, from the stored row.
      expect(answer).toMatchObject({ notFirstInDay: true, notLastInDay: true });
    });

    it('writes one mark and leaves the other unmarked', async () => {
      tx.subject.create.mockResolvedValue({ id: SUBJECT_ID, loadFactor: new Prisma.Decimal('1.000') });

      await service.create({ name: 'Idrott', notLastInDay: true }, testUser());

      expect(tx.subject.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ notFirstInDay: false, notLastInDay: true }),
      });
    });

    it('refuses a required room type that is not one of the school’s own, and writes no subject', async () => {
      // The single-column key accepts any school's type. Under RLS the lookup
      // shows the school its own types only, so another school's reads as none.
      tx.roomType.findFirst.mockResolvedValue(null);

      const run = service.create({ name: 'Kemi', requiredRoomTypeId: ROOM_TYPE_ID }, testUser());

      await expect(run).rejects.toThrow(BadRequestException);
      await expect(run).rejects.toMatchObject({ status: 400, response: { code: 'ROOM_TYPE_NOT_FOUND', message: expect.stringContaining('salstyper') } });
      expect(tx.roomType.findFirst).toHaveBeenCalledWith({
        where: { id: ROOM_TYPE_ID },
        select: { id: true },
      });
      expect(tx.subject.create).not.toHaveBeenCalled();
    });

    it('asks nothing of the room types for a subject that requires none', async () => {
      tx.subject.create.mockResolvedValue({ id: SUBJECT_ID });

      await service.create({ name: 'Matematik' }, testUser());
      await service.create({ name: 'Matematik', requiredRoomTypeId: null }, testUser());

      expect(tx.roomType.findFirst).not.toHaveBeenCalled();
    });

    it('writes the ämnesfördelning it is given', async () => {
      tx.subject.create.mockResolvedValue({ id: SUBJECT_ID });

      await service.create({ name: 'Idrott', maxLessonsPerDay: 1, minDaysBetween: 2 }, testUser());

      expect(tx.subject.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ maxLessonsPerDay: 1, minDaysBetween: 2 }),
      });
    });

    it('writes the factor it is given', async () => {
      tx.subject.create.mockResolvedValue({ id: SUBJECT_ID, loadFactor: new Prisma.Decimal('0.7') });

      await expect(service.create({ name: 'Slöjd', loadFactor: 0.7 }, testUser())).resolves.toMatchObject({
        loadFactor: 0.7,
      });
      expect(tx.subject.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ loadFactor: 0.7 }),
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
      const row = { id: SUBJECT_ID, name: 'Fysik', loadFactor: new Prisma.Decimal('1.25') };
      tx.subject.update.mockResolvedValue(row);
      const user = testUser();

      await expect(
        service.update(SUBJECT_ID, { name: 'Fysik' }, user),
      ).resolves.toEqual({ id: SUBJECT_ID, name: 'Fysik', loadFactor: 1.25 });

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
      ['loadFactor', { loadFactor: 0.7 }],
      ['maxLessonsPerDay', { maxLessonsPerDay: 1 }],
      ['minDaysBetween', { minDaysBetween: 2 }],
      // Null is how the dialog clears a rule, and it must reach the column.
      ['maxLessonsPerDay as null', { maxLessonsPerDay: null }],
      ['minDaysBetween as null', { minDaysBetween: null }],
      // Placeringsregler, regel 1: each mark on its own, and cleared with false.
      ['notFirstInDay', { notFirstInDay: true }],
      ['notLastInDay', { notLastInDay: true }],
      ['notFirstInDay as false', { notFirstInDay: false }],
      ['notLastInDay as false', { notLastInDay: false }],
    ])('a PATCH naming only %s writes it', async (field, patch) => {
      tx.subject.update.mockResolvedValue({ id: SUBJECT_ID });
      tx.roomType.findFirst.mockResolvedValue({ id: ROOM_TYPE_ID });

      await service.update(SUBJECT_ID, patch, testUser());

      expect(tx.subject.update).toHaveBeenCalledWith({
        where: { id: SUBJECT_ID },
        data: patch,
      });
      expect(tx.nationalSubject.findUnique).not.toHaveBeenCalled();
      // The room types are asked about the one field that names one, and no other.
      expect(tx.roomType.findFirst).toHaveBeenCalledTimes(field === 'requiredRoomTypeId' ? 1 : 0);
    });

    it('refuses a PATCH naming a required room type that is not one of the school’s own', async () => {
      tx.roomType.findFirst.mockResolvedValue(null);

      const run = service.update(SUBJECT_ID, { requiredRoomTypeId: ROOM_TYPE_ID }, testUser());

      await expect(run).rejects.toThrow(BadRequestException);
      await expect(run).rejects.toMatchObject({ status: 400, response: { code: 'ROOM_TYPE_NOT_FOUND', message: expect.stringContaining('salstyper') } });
      expect(tx.subject.update).not.toHaveBeenCalled();
    });

    it('clears the required room type without asking the room types', async () => {
      tx.subject.update.mockResolvedValue({ id: SUBJECT_ID });

      await service.update(SUBJECT_ID, { requiredRoomTypeId: null }, testUser());

      expect(tx.roomType.findFirst).not.toHaveBeenCalled();
      expect(tx.subject.update).toHaveBeenCalledWith({
        where: { id: SUBJECT_ID },
        data: { requiredRoomTypeId: null },
      });
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

  describe('behörighet som i ett annat ämne (qualificationSubjectId)', () => {
    const SO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const SO_WS = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const KEMI = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

    /** The subjects of the school as the three questions read them. */
    const school = (rows: Record<string, { id: string; name: string; qualificationSubjectId: string | null }>) => {
      tx.subject.findFirst.mockImplementation(({ where }: { where: { id: string } }) =>
        Promise.resolve(rows[where.id] ?? null),
      );
      // The service asks the heirs in name order (orderBy name asc), as the database answers.
      tx.subject.findMany.mockImplementation(({ where }: { where: { qualificationSubjectId: string } }) =>
        Promise.resolve(
          Object.values(rows)
            .filter((row) => row.qualificationSubjectId === where.qualificationSubjectId)
            .sort((a, b) => a.name.localeCompare(b.name, 'sv')),
        ),
      );
    };
    const so = { id: SO, name: 'SO', qualificationSubjectId: null };
    const soWs = { id: SO_WS, name: 'SO WS', qualificationSubjectId: null };

    const refusal = async (promise: Promise<unknown>) => {
      const error = await promise.then(
        () => null,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ConflictException);
      return (error as ConflictException).getResponse() as { code: string; message: string; params?: Record<string, string> };
    };

    it('writes the source a subject is created with, after asking that it is the school’s and inherits from nobody', async () => {
      school({ [SO]: so });
      tx.subject.create.mockResolvedValue({ id: SO_WS });

      await service.create({ name: 'SO WS', qualificationSubjectId: SO }, testUser());

      expect(tx.subject.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: SO } }));
      expect(tx.subject.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ qualificationSubjectId: SO }),
      });
    });

    it('refuses a source that is not one of the school’s own with a 400, and writes nothing', async () => {
      school({});

      const error = await service.create({ name: 'SO WS', qualificationSubjectId: SO }, testUser()).then(
        () => null,
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).getResponse()).toMatchObject({
        code: 'SUBJECT_QUALIFICATION_SOURCE_NOT_FOUND',
      });
      expect(tx.subject.create).not.toHaveBeenCalled();
    });

    it('refuses a source that itself inherits (a chain), naming both subjects, on create and on update', async () => {
      school({ [SO]: { ...so, qualificationSubjectId: KEMI }, [KEMI]: { id: KEMI, name: 'Kemi', qualificationSubjectId: null } });

      const onCreate = await refusal(service.create({ name: 'SO WS', qualificationSubjectId: SO }, testUser()));
      expect(onCreate.code).toBe('SUBJECT_QUALIFICATION_SOURCE_INHERITS');
      expect(onCreate.message).toBe(
        'Ämnet "SO" har själv behörighet som i "Kemi". Välj "Kemi" i stället: behörighet följer bara ett steg.',
      );
      expect(onCreate.params).toEqual({ sourceId: SO });

      const onUpdate = await refusal(service.update(SO_WS, { qualificationSubjectId: SO }, testUser()));
      expect(onUpdate.code).toBe('SUBJECT_QUALIFICATION_SOURCE_INHERITS');
      expect(onUpdate.params).toEqual({ subjectId: SO_WS, sourceId: SO });
      expect(tx.subject.create).not.toHaveBeenCalled();
      expect(tx.subject.update).not.toHaveBeenCalled();
    });

    it('refuses a subject pointed at itself, before anything is read', async () => {
      school({ [SO]: so });

      const body = await refusal(service.update(SO, { qualificationSubjectId: SO }, testUser()));

      expect(body.code).toBe('SUBJECT_QUALIFICATION_IS_ITSELF');
      expect(body.message).toBe(
        'Ett ämne kan inte ta sin behörighet från sig självt. Välj ett annat ämne, eller lämna fältet tomt.',
      );
      expect(tx.subject.findFirst).not.toHaveBeenCalled();
      expect(tx.subject.update).not.toHaveBeenCalled();
    });

    it('refuses a subject that others inherit from taking a pointer of its own, naming who uses it', async () => {
      // SO is SO WS's source; making SO inherit from Kemi would chain Kemi ← SO ← SO WS.
      school({
        [SO]: so,
        [KEMI]: { id: KEMI, name: 'Kemi', qualificationSubjectId: null },
        [SO_WS]: { ...soWs, qualificationSubjectId: SO },
      });

      const body = await refusal(service.update(SO, { qualificationSubjectId: KEMI }, testUser()));

      expect(body.code).toBe('SUBJECT_QUALIFICATION_IS_INHERITED');
      expect(body.message).toBe(
        'Ämnet "SO WS" har behörighet som i det här ämnet, så det kan inte självt ta sin behörighet från ett annat. Ta bort det andra ämnets val först.',
      );
      expect(body.params).toEqual({ subjectId: SO, inheritorId: SO_WS });
      expect(tx.subject.update).not.toHaveBeenCalled();
    });

    it('says "ämnena" and names each when several use the subject', async () => {
      school({
        [SO]: so,
        [KEMI]: { id: KEMI, name: 'Kemi', qualificationSubjectId: null },
        [SO_WS]: { ...soWs, qualificationSubjectId: SO },
        'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee': { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', name: 'SO Fördjupning', qualificationSubjectId: SO },
      });

      const body = await refusal(service.update(SO, { qualificationSubjectId: KEMI }, testUser()));

      expect(body.message).toContain('Ämnena "SO Fördjupning" och "SO WS" har behörighet som i det här ämnet');
      expect(body.message).toContain('Ta bort de andra ämnenas val först.');
    });

    it('writes a valid pointer on update, clears it with null, and leaves it alone when absent', async () => {
      school({ [SO]: so, [SO_WS]: soWs });
      tx.subject.update.mockResolvedValue({ id: SO_WS });

      await service.update(SO_WS, { qualificationSubjectId: SO }, testUser());
      expect(tx.subject.update).toHaveBeenLastCalledWith({ where: { id: SO_WS }, data: { qualificationSubjectId: SO } });

      // Null is a decision: back to the subject's own rows, and nothing is asked.
      tx.subject.findFirst.mockClear();
      await service.update(SO_WS, { qualificationSubjectId: null }, testUser());
      expect(tx.subject.update).toHaveBeenLastCalledWith({ where: { id: SO_WS }, data: { qualificationSubjectId: null } });
      expect(tx.subject.findFirst).not.toHaveBeenCalled();

      // Absent leaves it as it is, and asks nothing.
      await service.update(SO_WS, { name: 'SO arbetspass' }, testUser());
      expect(tx.subject.update).toHaveBeenLastCalledWith({ where: { id: SO_WS }, data: { name: 'SO arbetspass' } });
      expect(tx.subject.findFirst).not.toHaveBeenCalled();
    });

    it('answers the database’s own refusal (QS409), met by a writer that did not ask, with the same 409', async () => {
      // Two writers at once: each asked first and saw no chain; the trigger sees it.
      const triggerRefusal = new Prisma.PrismaClientKnownRequestError('Invalid `prisma.subject.update()` invocation: Code: `QS409`', {
        code: 'P2039',
        clientVersion: Prisma.prismaVersion.client,
        meta: {
          driverAdapterError: {
            cause: {
              originalCode: 'QS409',
              originalMessage: 'SUBJECT_QUALIFICATION_SOURCE_INHERITS: ämnet har själv behörighet som i ett annat ämne',
              detail: `subjectId=${SO_WS} sourceId=${SO} sourceSourceId=${KEMI}`,
            },
          },
        },
      });
      school({ [SO]: so, [SO_WS]: soWs });
      tx.subject.update.mockRejectedValue(triggerRefusal);

      const body = await refusal(service.update(SO_WS, { qualificationSubjectId: SO }, testUser()));

      expect(body.code).toBe('SUBJECT_QUALIFICATION_SOURCE_INHERITS');
      expect(body.params).toEqual({ subjectId: SO_WS, sourceId: SO });
    });

    it('reads the other reason token of the same SQLSTATE as the other 409', async () => {
      const triggerRefusal = new Prisma.PrismaClientKnownRequestError('Code: `QS409`', {
        code: 'P2039',
        clientVersion: Prisma.prismaVersion.client,
        meta: {
          driverAdapterError: {
            cause: {
              originalCode: 'QS409',
              originalMessage: 'SUBJECT_QUALIFICATION_IS_INHERITED: ett annat ämne har behörighet som i det här ämnet',
              detail: `subjectId=${SO} inheritorId=${SO_WS}`,
            },
          },
        },
      });
      school({ [SO]: so, [KEMI]: { id: KEMI, name: 'Kemi', qualificationSubjectId: null } });
      tx.subject.update.mockRejectedValue(triggerRefusal);

      const body = await refusal(service.update(SO, { qualificationSubjectId: KEMI }, testUser()));

      expect(body.code).toBe('SUBJECT_QUALIFICATION_IS_INHERITED');
      expect(body.params).toEqual({ subjectId: SO, inheritorId: SO_WS });
    });
  });

  describe('remove', () => {
    // The auto-vivifying mock would hand back a model proxy for `$queryRaw`,
    // which is not callable.
    let queryRaw: jest.Mock;
    beforeEach(() => {
      queryRaw = jest.fn().mockResolvedValue([]);
      Object.assign(tx, { $queryRaw: queryRaw });
    });

    it('locks the plans holding the subject, in id order, before the cascade can lock their entries', async () => {
      tx.subject.delete.mockResolvedValue({ id: SUBJECT_ID });

      await service.remove(SUBJECT_ID, testUser());

      expect(queryRaw).toHaveBeenCalledTimes(1);
      const [strings, ...values] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
      const sql = strings.join('?').replace(/\s+/g, ' ');
      expect(sql).toContain('FROM "LocalTimplans" p');
      expect(sql).toContain('e."subjectId" = ?::uuid');
      expect(sql).toMatch(/ORDER BY p\."id" FOR SHARE/);
      expect(values).toEqual([SUBJECT_ID]);
      expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.localTimplan.findMany.mock.invocationCallOrder[0],
      );
      expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.subject.delete.mock.invocationCallOrder[0],
      );
    });

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
