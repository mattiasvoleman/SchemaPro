import {
  BadRequestException,
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
import { Role } from '../auth/enums/role.enum';
import { TeacherWorkRulesService } from './teacher-work-rules.service';
import type { UpsertTeacherWorkRuleDto } from './dto/teacher-work-rule.dto';

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
/** The acting teacher's own `Users.id`, as `testUser()` hands it out. */
const ME = '22222222-2222-4222-8222-222222222222';
const COLLEAGUE = '44444444-4444-4444-8444-444444444444';

describe('TeacherWorkRulesService', () => {
  let service: TeacherWorkRulesService;
  let tx: TxMock;
  let prisma: PrismaMock;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new TeacherWorkRulesService(prisma as unknown as PrismaService);
    // Whose rule may exist at all is a question about `Users.role`, which the
    // database cannot answer with a CHECK. Every happy path here is about a
    // teacher, so that is the default and the exceptions say so.
    tx.user.findUnique.mockResolvedValue({ role: 'TEACHER' });
  });

  const dto = (
    overrides: Partial<UpsertTeacherWorkRuleDto> = {},
  ): UpsertTeacherWorkRuleDto => ({
    lunchMinutes: 30,
    lunchStartTime: '10:30',
    lunchEndTime: '13:30',
    minDailyRestMinutes: 660,
    ...overrides,
  });

  /** What Prisma hands back for this table: @db.Time columns are `Date`s. */
  const storedRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'twr-1',
    schoolId: SCHOOL_ID,
    userId: ME,
    lunchMinutes: 30,
    lunchStartTime: new Date('1970-01-01T10:30:00.000Z'),
    lunchEndTime: new Date('1970-01-01T13:30:00.000Z'),
    minDailyRestMinutes: 660,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  });

  describe('list', () => {
    it('reads the school under RLS, ordered by teacher rather than by typing order', async () => {
      tx.teacherWorkRule.findMany.mockResolvedValue([storedRow()]);
      const user = testUser();

      await expect(service.list(user)).resolves.toEqual([
        {
          id: 'twr-1',
          userId: ME,
          lunchMinutes: 30,
          lunchStartTime: '10:30',
          lunchEndTime: '13:30',
          minDailyRestMinutes: 660,
        },
      ]);

      expect(prisma.withRls).toHaveBeenCalledWith(user, expect.any(Function));
      // No `where`. RLS confines the read to the caller's school, and a WHERE
      // clause here would be a second, weaker copy of that rule.
      expect(tx.teacherWorkRule.findMany).toHaveBeenCalledWith({
        orderBy: { userId: 'asc' },
      });
    });

    it('answers with the wall clock, never with a 1970 timestamp', async () => {
      // `@db.Time` comes out of Prisma as a `Date` at 1970-01-01, and a row
      // returned unchanged sends "1970-01-01T10:30:00.000Z" to a form that wants
      // "10:30" — the bug that drew the lunch card's inputs empty on every load.
      tx.teacherWorkRule.findMany.mockResolvedValue([storedRow()]);

      const answer = await service.list(testUser());

      expect(JSON.stringify(answer)).not.toContain('1970');
    });

    it('keeps an absent window absent instead of turning it into midnight', async () => {
      // A teacher with only a rest rule. "00:00" would be a window, and the
      // engine reads a window as somewhere the lunch MUST fall.
      tx.teacherWorkRule.findMany.mockResolvedValue([
        storedRow({ lunchMinutes: null, lunchStartTime: null, lunchEndTime: null }),
      ]);

      await expect(service.list(testUser())).resolves.toMatchObject([
        { lunchMinutes: null, lunchStartTime: null, lunchEndTime: null },
      ]);
    });

    it('refuses a principal carrying no school', async () => {
      await expect(
        service.list(testUser({ schoolId: undefined })),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('upsert', () => {
    it('writes the whole row for the named teacher, times parsed for @db.Time', async () => {
      tx.teacherWorkRule.upsert.mockResolvedValue(storedRow());

      await expect(service.upsert(ME, dto(), testUser())).resolves.toMatchObject({
        id: 'twr-1',
        lunchStartTime: '10:30',
        lunchEndTime: '13:30',
      });

      const data = {
        lunchMinutes: 30,
        lunchStartTime: new Date('1970-01-01T10:30:00.000Z'),
        lunchEndTime: new Date('1970-01-01T13:30:00.000Z'),
        minDailyRestMinutes: 660,
      };
      expect(tx.teacherWorkRule.upsert).toHaveBeenCalledWith({
        where: { userId: ME },
        create: { schoolId: SCHOOL_ID, userId: ME, ...data },
        update: data,
      });
    });

    it('turns an omitted rule into an explicit null, not into a dropped field', async () => {
      /*
       * The whole row is replaced on every PUT, so a field left out has to become
       * NULL. Dropped from `update` instead, it would keep whatever the row said
       * before — and a school that had just taken a teacher's rest rule away
       * would find it still being enforced, with nothing on screen saying so.
       */
      tx.teacherWorkRule.upsert.mockResolvedValue(storedRow());

      await service.upsert(
        ME,
        { minDailyRestMinutes: 660 } as UpsertTeacherWorkRuleDto,
        testUser(),
      );

      const call = tx.teacherWorkRule.upsert.mock.calls[0]?.[0] as {
        update: Record<string, unknown>;
      };
      expect(call.update).toEqual({
        lunchMinutes: null,
        lunchStartTime: null,
        lunchEndTime: null,
        minDailyRestMinutes: 660,
      });
    });

    describe('refuses half a lunch rule, whichever half is missing', () => {
      // Three fields, one meaning. 30 minutes with no window is a lunch the
      // solver may place at 07:00; a window with no length is a window nothing
      // has to happen in. The table refuses it too — this is the copy that can
      // say which field is missing.
      it.each([
        ['no window at all', { lunchStartTime: undefined, lunchEndTime: undefined }],
        ['no end', { lunchEndTime: undefined }],
        ['no start', { lunchStartTime: undefined }],
        ['no length', { lunchMinutes: undefined }],
        ['an explicit null in the middle', { lunchStartTime: null }],
      ])('%s', async (_label, overrides) => {
        await expect(
          service.upsert(ME, dto(overrides), testUser()),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(tx.teacherWorkRule.upsert).not.toHaveBeenCalled();
      });
    });

    it('accepts a window exactly as long as the break', async () => {
      tx.teacherWorkRule.upsert.mockResolvedValue(storedRow());

      await service.upsert(
        ME,
        dto({ lunchStartTime: '11:00', lunchEndTime: '11:30', lunchMinutes: 30 }),
        testUser(),
      );

      expect(tx.teacherWorkRule.upsert).toHaveBeenCalled();
    });

    it('names both numbers when the window cannot hold the break', async () => {
      // The admin has to be able to fix it without guessing which of the two
      // fields the rule is about.
      await expect(
        service.upsert(
          ME,
          dto({ lunchStartTime: '11:00', lunchEndTime: '11:20', lunchMinutes: 30 }),
          testUser(),
        ),
      ).rejects.toThrow(/20 minuter.*30 minuter/);
    });

    it('refuses a window that ends before it starts', async () => {
      await expect(
        service.upsert(
          ME,
          dto({ lunchStartTime: '13:30', lunchEndTime: '10:30' }),
          testUser(),
        ),
      ).rejects.toThrow(new BadRequestException('Lunchfönstret måste sluta efter att det börjat.'));
    });

    it('compares the window in minutes, so a seconds-long one is not a window', async () => {
      /*
       * The DTO's regex admits HH:MM:SS, and a lexical compare across the two
       * lengths reads "12:00" as before "12:00:30" — a thirty-second window,
       * accepted as one. The table's own CHECK is weaker here for the same
       * reason: `"lunchEndTime" > "lunchStartTime"` on a TIME(0) column is true
       * of it. The seconds are now refused outright one check earlier (below),
       * which is a narrower answer to the same request; it is still a 400.
       */
      await expect(
        service.upsert(
          ME,
          dto({ lunchStartTime: '12:00', lunchEndTime: '12:00:30', lunchMinutes: 5 }),
          testUser(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it.each([
      ['a second on the start', { lunchStartTime: '10:30:30', lunchEndTime: '11:00' }],
      ['a second on the end', { lunchStartTime: '10:30', lunchEndTime: '11:00:30' }],
    ])('refuses %s, where the width arithmetic cannot see it', async (_l, overrides) => {
      /*
       * The 500 this exists to stop. `minutesOf` splits on ':' and reads two
       * fields, so 10:30:30 measures as 10:30: the width came out as a whole
       * thirty minutes and both edges passed `% 5`. The table measures the same
       * window with EXTRACT(EPOCH …) and sees 1770 seconds against 1800, and a
       * CHECK violation is none of the codes rethrowPrismaError maps — so the
       * admin met a bare 500 instead of a sentence naming the field.
       */
      await expect(
        service.upsert(
          ME,
          dto({ ...overrides, lunchMinutes: 30 }),
          testUser(),
        ),
      ).rejects.toThrow(/hela minuter/);
      expect(tx.teacherWorkRule.upsert).not.toHaveBeenCalled();
    });

    it('still takes the zero seconds PostgREST sends, so a row round-trips', async () => {
      // The reason the DTO admits HH:MM:SS at all: the web reads this row back
      // from PostgREST, which writes the seconds out, and PUTs it again.
      tx.teacherWorkRule.upsert.mockResolvedValue(storedRow());

      await service.upsert(
        ME,
        dto({ lunchStartTime: '10:30:00', lunchEndTime: '13:30:00', lunchMinutes: 30 }),
        testUser(),
      );

      expect(tx.teacherWorkRule.upsert).toHaveBeenCalled();
    });

    it.each([
      ['a start off the solver grid', { lunchStartTime: '10:32' }],
      ['an end off it', { lunchEndTime: '13:31' }],
    ])('refuses %s', async (_label, overrides) => {
      // A window from 10:32 gives the solver a domain whose first legal start is
      // 10:35, so a school that wrote exactly `lunchMinutes` of room would have
      // none. The database does not check the window's edges — only this does.
      await expect(
        service.upsert(ME, dto(overrides), testUser()),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    describe('who may write whose row', () => {
      it('lets an admin write any teacher of their school', async () => {
        tx.teacherWorkRule.upsert.mockResolvedValue(storedRow({ userId: COLLEAGUE }));

        await service.upsert(COLLEAGUE, dto(), testUser());

        expect(tx.teacherWorkRule.upsert).toHaveBeenCalled();
      });

      it('lets a teacher write their own', async () => {
        tx.teacherWorkRule.upsert.mockResolvedValue(storedRow());

        await service.upsert(ME, dto(), testUser({ role: Role.TEACHER }));

        expect(tx.teacherWorkRule.upsert).toHaveBeenCalled();
      });

      it('refuses a teacher a colleague’s row, and says which rule that is', async () => {
        /*
         * An arbetstid is HARD, so writing one onto a colleague is refusing the
         * school's week in that colleague's name — an admin-only decision reached
         * from a teacher's session, the same escalation the availability policy
         * was narrowed to close.
         *
         * `teacher_work_rules_teacher_own` refuses it in the database too, and
         * that is what actually holds. This check exists because RLS answers by
         * matching no row, which Prisma reports as "record not found" — so the
         * teacher would be told their colleague does not exist.
         */
        await expect(
          service.upsert(COLLEAGUE, dto(), testUser({ role: Role.TEACHER })),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(tx.teacherWorkRule.upsert).not.toHaveBeenCalled();
      });

      it('names the missing identity rather than the ownership rule', async () => {
        // A principal with no `Users` row has no id to compare, and "you may only
        // change your own" would be true and unactionable.
        await expect(
          service.upsert(ME, dto(), testUser({ role: Role.TEACHER, userId: undefined })),
        ).rejects.toThrow(/No user identity/);
      });
    });

    describe('whose arbetstid may exist at all', () => {
      it('refuses a pupil and a guardian, because they teach nothing', async () => {
        // No last lesson for a rest to follow, and no day for a lunch to sit in.
        // `role` lives on `Users`, so a CHECK cannot ask this — only the service.
        for (const role of ['STUDENT', 'GUARDIAN']) {
          tx.teacherWorkRule.upsert.mockClear();
          tx.user.findUnique.mockResolvedValue({ role });

          await expect(
            service.upsert(COLLEAGUE, dto(), testUser()),
          ).rejects.toBeInstanceOf(BadRequestException);
          expect(tx.teacherWorkRule.upsert).not.toHaveBeenCalled();
        }
      });

      it('allows a teaching admin their own rule', async () => {
        // A teaching rektor carries role SCHOOL_ADMIN here, and
        // `TeachingRequirements.teacherId` will happily name them — so refusing
        // an admin would refuse the person most likely to be scheduled without a
        // lunch at all.
        tx.user.findUnique.mockResolvedValue({ role: 'SCHOOL_ADMIN' });
        tx.teacherWorkRule.upsert.mockResolvedValue(storedRow());

        await service.upsert(ME, dto(), testUser());

        expect(tx.teacherWorkRule.upsert).toHaveBeenCalled();
      });

      it('answers a teacher of another school as missing', async () => {
        // RLS hides them, so the lookup finds nothing — the same 404 a
        // nonexistent id gets. The composite (userId, schoolId) key is what
        // guarantees it rather than this read.
        tx.user.findUnique.mockResolvedValue(null);

        await expect(
          service.upsert(COLLEAGUE, dto(), testUser()),
        ).rejects.toBeInstanceOf(NotFoundException);
      });
    });

    it('answers a refusal from the database with its HTTP meaning, not a raw Prisma error', async () => {
      tx.teacherWorkRule.upsert.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Simulated P2003', {
          code: 'P2003',
          clientVersion: Prisma.prismaVersion.client,
        }),
      );

      await expect(service.upsert(ME, dto(), testUser())).rejects.toThrow(
        /references a record that does not exist/,
      );
    });
  });

  describe('remove', () => {
    it('deletes the teacher’s row, keyed on the teacher', async () => {
      await service.remove(ME, testUser());

      expect(tx.teacherWorkRule.delete).toHaveBeenCalledWith({
        where: { userId: ME },
      });
    });

    it('refuses a teacher a colleague’s row here too', async () => {
      // A rule a teacher can DELETE is a rule a teacher can take away, which is
      // the same escalation as writing over it — the reason the policy carries
      // the id test in USING and not only in WITH CHECK.
      await expect(
        service.remove(COLLEAGUE, testUser({ role: Role.TEACHER })),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(tx.teacherWorkRule.delete).not.toHaveBeenCalled();
    });

    it('answers a row that is not there with a 404', async () => {
      tx.teacherWorkRule.delete.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Simulated P2025', {
          code: 'P2025',
          clientVersion: Prisma.prismaVersion.client,
        }),
      );

      await expect(service.remove(ME, testUser())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
