import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import type { CreateRoomLoanDto } from './dto/sharing.dto';
import { MAX_LOAN_DAYS, ROOM_LOAN_WINDOW_INVALID, RoomLoansService, windowProblem } from './room-loans.service';

/**
 * Salslån (Delade lokaler och lärare, 20261217090000). The database holds
 * the loan to its sides (four functions, RLS sections 278–279) and to its
 * checks; this is what the service adds: a window refused with a sentence
 * before the database is asked, the borrower's own room for the loan found
 * or named (a request makes none: the owner's approval does, by the name
 * passed on), one request per window, and the two lists the school reads.
 */

const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';
const ROLLER = '40000000-0000-4000-8000-000000000004';
const NOT_SIBLING = '70000000-0000-4000-8000-000000000007';
const HALL = '50000000-0000-4000-8000-000000000005';
const SLOJD = '51000000-0000-4000-8000-000000000051';
const LOCAL_HALL = '60000000-0000-4000-8000-000000000006';
const OWN_ROOM = '61000000-0000-4000-8000-000000000061';
const NEW_LOCAL = '62000000-0000-4000-8000-000000000062';
const LOAN = '80000000-0000-4000-8000-000000000008';
const TYPE = '90000000-0000-4000-8000-000000000009';

const time = (clock: string) => new Date(`1970-01-01T${clock}:00.000Z`);
const date = (day: string) => new Date(`${day}T00:00:00.000Z`);

const loanRow = (overrides: Record<string, unknown> = {}) => ({
  id: LOAN,
  status: 'APPROVED',
  dayOfWeek: 2,
  startTime: time('10:00'),
  endTime: time('11:30'),
  startDate: date('2030-08-19'),
  endDate: date('2031-06-13'),
  note: 'Idrott åk 7',
  createdAt: new Date('2030-05-01T08:00:00.000Z'),
  decidedAt: new Date('2030-05-02T08:00:00.000Z'),
  endedAt: null,
  roomId: HALL,
  ownerSchoolId: ROLLER,
  borrowerSchoolId: SCHOOL_ID,
  localRoomName: null,
  ...overrides,
});

const dto = (overrides: Partial<CreateRoomLoanDto> = {}): CreateRoomLoanDto => ({
  roomId: HALL,
  windows: [{ dayOfWeek: 2, startTime: '10:00', endTime: '11:30' }],
  startDate: '2030-08-19',
  endDate: '2031-06-13',
  ...overrides,
});

/** The adapter's form of a database refusal of an SQLSTATE PostgreSQL does not define. */
const refusal = (state: string, message: string) =>
  new Prisma.PrismaClientKnownRequestError(`Database error. Code: \`${state}\`. Message: \`${message}\``, {
    code: 'P2039',
    clientVersion: 'test',
    meta: { driverAdapterError: { cause: { originalCode: state, originalMessage: message } } },
  });

const sqlText = (call: unknown[]): string => (call[0] as Prisma.Sql).strings.join('?');
const sqlValues = (call: unknown[]): unknown[] => (call[0] as Prisma.Sql).values;

describe('RoomLoansService', () => {
  let prisma: PrismaMock;
  let tx: TxMock;
  let service: RoomLoansService;
  let lendable: Array<{ school_id: string; room_id: string; name: string; capacity: number | null; room_type_name: string | null }>;
  let raw: jest.Mock;
  let exec: jest.Mock;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new RoomLoansService(prisma as unknown as PrismaService);
    lendable = [
      { school_id: ROLLER, room_id: HALL, name: 'Roller hall', capacity: 60, room_type_name: 'Idrottshall' },
      { school_id: ROLLER, room_id: SLOJD, name: 'Slöjd', capacity: null, room_type_name: null },
    ];
    // What the database's functions answer; app.room_loan_* a fresh id.
    raw = jest.fn(async (sql: Prisma.Sql) => {
      const text = sql.strings.join('?');
      if (text.includes('app.sibling_schools()')) return [{ school_id: ROLLER, name: 'RLS Roller' }];
      if (text.includes('app.lendable_rooms()')) return lendable;
      return [{ id: LOAN }];
    });
    tx.$queryRaw = raw;
    // The decisions return void and go through $executeRaw.
    exec = jest.fn().mockResolvedValue(1);
    tx.$executeRaw = exec;
  });

  /** The calls to the four acting functions, in order. */
  const acts = () => [...raw.mock.calls, ...exec.mock.calls].filter((call) => /app\.room_loan_/.test(sqlText(call)));

  describe('windowProblem', () => {
    it('lets a window that ends after it starts through, over at most 400 days', () => {
      expect(windowProblem(dto())).toBeNull();
      expect(windowProblem(dto({ startDate: '2030-08-19', endDate: '2031-09-23' }))).toBeNull();
      expect(MAX_LOAN_DAYS).toBe(400);
    });

    it('refuses a window that ends when or before it starts', () => {
      expect(windowProblem(dto({ windows: [{ dayOfWeek: 1, startTime: '10:00', endTime: '10:00' }] }))).toMatch(/sluta efter/);
      expect(windowProblem(dto({ windows: [{ dayOfWeek: 1, startTime: '10:00:00', endTime: '09:59' }] }))).toMatch(/sluta efter/);
    });

    it('refuses dates the wrong way round and more than 400 days', () => {
      expect(windowProblem(dto({ startDate: '2031-06-13', endDate: '2030-08-19' }))).toMatch(/före/);
      expect(windowProblem(dto({ startDate: '2030-08-19', endDate: '2031-09-24' }))).toMatch(/400 dagar/);
    });

    it('refuses the same time twice', () => {
      const twice = dto({
        windows: [
          { dayOfWeek: 2, startTime: '10:00', endTime: '11:00' },
          { dayOfWeek: 2, startTime: '10:00:00', endTime: '12:00' },
        ],
      });
      expect(windowProblem(twice)).toMatch(/två gånger/);
      const other = dto({
        windows: [
          { dayOfWeek: 2, startTime: '10:00', endTime: '11:00' },
          { dayOfWeek: 3, startTime: '10:00', endTime: '11:00' },
        ],
      });
      expect(windowProblem(other)).toBeNull();
    });
  });

  describe('list', () => {
    it('lists the rooms the school lends by its own room, and those it borrows by its local room and the owner\'s name', async () => {
      tx.roomLoan.findMany
        .mockResolvedValueOnce([
          loanRow({ id: 'lent-1', ownerSchoolId: SCHOOL_ID, borrowerSchoolId: ROLLER, roomId: OWN_ROOM, status: 'PENDING', decidedAt: null, note: null, room: { id: OWN_ROOM, name: 'Aulan' } }),
        ])
        .mockResolvedValueOnce([loanRow({ localRoom: { id: LOCAL_HALL, name: 'Roller hall (lånad)' } })]);

      const view = await service.list(testUser());

      expect(tx.roomLoan.findMany.mock.calls[0][0]).toMatchObject({ where: { ownerSchoolId: SCHOOL_ID } });
      expect(tx.roomLoan.findMany.mock.calls[1][0]).toMatchObject({ where: { borrowerSchoolId: SCHOOL_ID } });
      expect(view).toEqual({
        lent: [
          {
            id: 'lent-1',
            status: 'PENDING',
            dayOfWeek: 2,
            startTime: '10:00',
            endTime: '11:30',
            startDate: '2030-08-19',
            endDate: '2031-06-13',
            note: null,
            createdAt: '2030-05-01T08:00:00.000Z',
            decidedAt: null,
            endedAt: null,
            room: { id: OWN_ROOM, name: 'Aulan' },
            school: { id: ROLLER, name: 'RLS Roller' },
            ownerRoomName: null,
          },
        ],
        borrowed: [
          {
            id: LOAN,
            status: 'APPROVED',
            dayOfWeek: 2,
            startTime: '10:00',
            endTime: '11:30',
            startDate: '2030-08-19',
            endDate: '2031-06-13',
            note: 'Idrott åk 7',
            createdAt: '2030-05-01T08:00:00.000Z',
            decidedAt: '2030-05-02T08:00:00.000Z',
            endedAt: null,
            room: { id: LOCAL_HALL, name: 'Roller hall (lånad)' },
            school: { id: ROLLER, name: 'RLS Roller' },
            ownerRoomName: 'Roller hall',
          },
        ],
      });
    });

    it('keeps an approved loan of its room to a school that has left the huvudman, unnamed, so the owner can end it', async () => {
      tx.roomLoan.findMany
        .mockResolvedValueOnce([loanRow({ ownerSchoolId: SCHOOL_ID, borrowerSchoolId: NOT_SIBLING, room: { id: OWN_ROOM, name: 'Aulan' } })])
        .mockResolvedValueOnce([]);

      const view = await service.list(testUser());

      expect(view.lent).toEqual([expect.objectContaining({ id: LOAN, status: 'APPROVED', school: { id: NOT_SIBLING, name: null } })]);
      expect(view.borrowed).toEqual([]);
      expect(raw.mock.calls.some((call) => sqlText(call).includes('app.lendable_rooms()'))).toBe(false);
    });

    it('leaves out a borrowed room whose owner is no longer another school of the huvudman', async () => {
      tx.roomLoan.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([loanRow({ ownerSchoolId: NOT_SIBLING, localRoom: { id: LOCAL_HALL, name: 'Roller hall (lånad)' } })]);

      await expect(service.list(testUser())).resolves.toEqual({ lent: [], borrowed: [] });
    });

    it('names a request not yet approved by the room its approval makes, with no id', async () => {
      tx.roomLoan.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          loanRow({ status: 'PENDING', decidedAt: null, localRoom: null, localRoomName: 'Roller hall (RLS Roller)' }),
          loanRow({ id: 'declined', status: 'DECLINED', localRoom: null, localRoomName: null, roomId: SLOJD }),
        ]);

      const view = await service.list(testUser());

      expect(view.borrowed.map((loan) => loan.room)).toEqual([
        { id: null, name: 'Roller hall (RLS Roller)' },
        // No name of its own: the owner's name for the room.
        { id: null, name: 'Slöjd' },
      ]);
    });

    it('says nothing of the owner\'s name for a room the owner no longer offers', async () => {
      lendable = [];
      tx.roomLoan.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([loanRow({ localRoom: { id: LOCAL_HALL, name: 'Roller hall (lånad)' } })]);

      const view = await service.list(testUser());

      expect(view.borrowed[0]).toMatchObject({ ownerRoomName: null, school: { id: ROLLER } });
    });
  });

  describe('rooms', () => {
    it('groups the rooms to ask for by school, with the school\'s own room for one it borrowed before', async () => {
      // The latest loan that has a room first: an older one's room is not the school's room for the hall now.
      tx.roomLoan.findMany.mockResolvedValue([
        { roomId: HALL, localRoomId: LOCAL_HALL },
        { roomId: HALL, localRoomId: OWN_ROOM },
      ]);

      await expect(service.rooms(testUser())).resolves.toEqual([
        {
          id: ROLLER,
          name: 'RLS Roller',
          rooms: [
            { id: HALL, name: 'Roller hall', capacity: 60, roomTypeName: 'Idrottshall', localRoomId: LOCAL_HALL },
            { id: SLOJD, name: 'Slöjd', capacity: null, roomTypeName: null, localRoomId: null },
          ],
        },
      ]);
      expect(tx.roomLoan.findMany).toHaveBeenCalledWith({
        where: { borrowerSchoolId: SCHOOL_ID, localRoomId: { not: null } },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        select: { roomId: true, localRoomId: true },
      });
    });

    it('leaves out a school that offers no room', async () => {
      lendable = [];
      await expect(service.rooms(testUser())).resolves.toEqual([]);
    });
  });

  describe('request', () => {
    it('refuses a window the database would refuse with a 400 and a sentence, before any transaction', async () => {
      const call = service.request(dto({ windows: [{ dayOfWeek: 1, startTime: '11:00', endTime: '10:00' }] }), testUser());

      await expect(call).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        service.request(dto({ startDate: '2031-06-13', endDate: '2030-08-19' }), testUser()),
      ).rejects.toMatchObject({ response: { code: ROOM_LOAN_WINDOW_INVALID } });
      expect(prisma.withRls).not.toHaveBeenCalled();
      expect(raw).not.toHaveBeenCalled();
    });

    it('refuses a room that is not one to ask for with a 404, making nothing', async () => {
      const call = service.request(dto({ roomId: NEW_LOCAL }), testUser());

      await expect(call).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.request(dto({ roomId: NEW_LOCAL }), testUser())).rejects.toMatchObject({
        response: { code: 'ROOM_LOAN_ROOM_NOT_FOUND' },
      });
      expect(tx.room.create).not.toHaveBeenCalled();
      expect(acts()).toHaveLength(0);
    });

    it('holds the loan by the room the school had for it, and makes none', async () => {
      tx.roomLoan.findMany.mockResolvedValue([{ roomId: HALL, localRoomId: LOCAL_HALL }]);

      await service.request(dto({ localRoomName: 'Ett namn', localRoomTypeId: TYPE }), testUser());

      expect(tx.room.create).not.toHaveBeenCalled();
      expect(acts()).toHaveLength(1);
      expect(sqlValues(acts()[0]!)).toEqual([HALL, LOCAL_HALL, null, null, 2, '10:00', '11:30', '2030-08-19', '2031-06-13', null]);
    });

    it('names the room the request gives, and passes it on for the database to judge', async () => {
      tx.roomLoan.findMany.mockResolvedValue([{ roomId: HALL, localRoomId: LOCAL_HALL }]);

      await service.request(dto({ localRoomId: OWN_ROOM }), testUser());

      expect(tx.room.create).not.toHaveBeenCalled();
      expect(sqlValues(acts()[0]!).slice(0, 4)).toEqual([HALL, OWN_ROOM, null, null]);
    });

    it('makes no room the first time: the approval makes it, by the name and room type passed on', async () => {
      await service.request(dto({ localRoomTypeId: TYPE, note: '  Idrott åk 7  ' }), testUser());

      expect(tx.room.create).not.toHaveBeenCalled();
      // No name: the database names it after the room and its school.
      expect(sqlValues(acts()[0]!)).toEqual([HALL, null, null, TYPE, 2, '10:00', '11:30', '2030-08-19', '2031-06-13', 'Idrott åk 7']);

      await service.request(dto({ roomId: SLOJD, localRoomName: '  Slöjden hos Roller  ' }), testUser());

      expect(sqlValues(acts()[1]!).slice(0, 4)).toEqual([SLOJD, null, 'Slöjden hos Roller', null]);
    });

    it('answers a room type that is not the school\'s own with the database\'s 404', async () => {
      raw.mockImplementation(async (sql: Prisma.Sql) => {
        const text = sql.strings.join('?');
        if (text.includes('app.sibling_schools()')) return [{ school_id: ROLLER, name: 'RLS Roller' }];
        if (text.includes('app.lendable_rooms()')) return lendable;
        throw refusal('RL404', 'ROOM_LOAN_LOCAL_ROOM_TYPE_NOT_FOUND');
      });

      await expect(service.request(dto({ localRoomTypeId: TYPE }), testUser())).rejects.toMatchObject({
        status: 404,
        response: { code: 'ROOM_LOAN_LOCAL_ROOM_TYPE_NOT_FOUND', message: expect.stringContaining('salstyper') },
      });
    });

    it('asks once per window, with a blank note as none', async () => {
      tx.roomLoan.findMany.mockResolvedValue([{ roomId: HALL, localRoomId: LOCAL_HALL }]);

      await service.request(
        dto({
          note: '   ',
          windows: [
            { dayOfWeek: 2, startTime: '10:00', endTime: '11:30' },
            { dayOfWeek: 4, startTime: '13:00:00', endTime: '14:00:00' },
          ],
        }),
        testUser(),
      );

      expect(acts().map(sqlValues)).toEqual([
        [HALL, LOCAL_HALL, null, null, 2, '10:00', '11:30', '2030-08-19', '2031-06-13', null],
        [HALL, LOCAL_HALL, null, null, 4, '13:00:00', '14:00:00', '2030-08-19', '2031-06-13', null],
      ]);
      expect(sqlText(acts()[0]!)).toContain('app.room_loan_request(');
      expect(prisma.withRls).toHaveBeenCalledTimes(1);
    });

    it('answers a refusal of the database\'s by its code', async () => {
      tx.roomLoan.findMany.mockResolvedValue([{ roomId: HALL, localRoomId: LOCAL_HALL }]);
      raw.mockImplementation(async (sql: Prisma.Sql) => {
        const text = sql.strings.join('?');
        if (text.includes('app.sibling_schools()')) return [{ school_id: ROLLER, name: 'RLS Roller' }];
        if (text.includes('app.lendable_rooms()')) return lendable;
        throw refusal('RL409', 'ROOM_LOAN_LOCAL_ROOM_IS_ANOTHER');
      });

      await expect(service.request(dto(), testUser())).rejects.toMatchObject({
        status: 409,
        response: { code: 'ROOM_LOAN_LOCAL_ROOM_IS_ANOTHER' },
      });
    });

    it('needs a person to ask for it', async () => {
      await expect(service.request(dto(), testUser({ userId: undefined }))).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.withRls).not.toHaveBeenCalled();
    });
  });

  describe('decide, withdraw and revoke', () => {
    beforeEach(() => {
      tx.roomLoan.findMany.mockResolvedValue([]);
    });

    it.each([
      ['approves', (s: RoomLoansService) => s.decide(LOAN, true, testUser()), 'app.room_loan_decide(', [LOAN, true]],
      ['declines', (s: RoomLoansService) => s.decide(LOAN, false, testUser()), 'app.room_loan_decide(', [LOAN, false]],
      ['withdraws', (s: RoomLoansService) => s.withdraw(LOAN, testUser()), 'app.room_loan_withdraw(', [LOAN]],
      ['revokes', (s: RoomLoansService) => s.revoke(LOAN, testUser()), 'app.room_loan_revoke(', [LOAN]],
    ])('%s through its own function, and answers the lists read after it', async (_what, act, fn, values) => {
      await expect(act(service)).resolves.toEqual({ lent: [], borrowed: [] });

      expect(exec).toHaveBeenCalledTimes(1);
      expect(acts()).toHaveLength(1);
      expect(sqlText(acts()[0]!)).toContain(fn);
      expect(sqlValues(acts()[0]!)).toEqual(values);
      expect(prisma.withRls).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['RL403', 'ROOM_LOAN_NOT_YOURS', 403],
      ['RL404', 'ROOM_LOAN_NOT_FOUND', 404],
      ['RL409', 'ROOM_LOAN_ALREADY_DECIDED', 409],
      ['RL400', 'ROOM_LOAN_DECISION_MISSING', 400],
    ])('answers %s as %s', async (state, code, status) => {
      exec.mockRejectedValue(refusal(state, code));

      await expect(service.decide(LOAN, true, testUser())).rejects.toMatchObject({ status, response: { code } });
    });

    it('answers an approval over another approved loan as the 409 ROOM_LOAN_OVERLAP', async () => {
      exec.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('conflicting key value violates exclusion constraint "RoomLoans_a_room_is_lent_once"', {
          code: 'P2010',
          clientVersion: 'test',
          meta: { driverAdapterError: { cause: { originalCode: '23P01', originalMessage: 'conflicting key value violates exclusion constraint "RoomLoans_a_room_is_lent_once"' } } },
        }),
      );

      await expect(service.decide(LOAN, true, testUser())).rejects.toMatchObject({
        status: 409,
        response: { code: 'ROOM_LOAN_OVERLAP' },
      });
    });

    it('needs a person to act', async () => {
      await expect(service.revoke(LOAN, testUser({ userId: undefined }))).rejects.toBeInstanceOf(ForbiddenException);
      expect(acts()).toHaveLength(0);
    });
  });
});
