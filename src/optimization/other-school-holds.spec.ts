import { createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaClient } from '@prisma/client';
import { HOLD_CODES, holdId, readOtherSchoolHolds } from './other-school-holds';
import { OTHER_SCHOOL_TEACHER_CODE } from './stored-conflicts';

/**
 * The other schools' hold on this school, as the reservations the generator
 * sends: read through the database's narrow functions and the loans' arms,
 * nothing for a school without another school of its huvudman.
 */

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const NORRA = '44444444-4444-4444-8444-444444444444';
const YEAR = '99999999-9999-4999-8999-999999999999';
const ANNA = 'a0000000-0000-4000-8000-000000000001';
const HALL = 'b0000000-0000-4000-8000-000000000002';
const LOCAL = 'c0000000-0000-4000-8000-000000000003';

const time = (clock: string) => new Date(`1970-01-01T${clock}:00.000Z`);
const date = (day: string) => new Date(`${day}T00:00:00.000Z`);

const loan = (patch: Record<string, unknown>) => ({
  status: 'APPROVED',
  ownerSchoolId: SCHOOL,
  borrowerSchoolId: NORRA,
  roomId: HALL,
  localRoomId: 'd0000000-0000-4000-8000-000000000004',
  dayOfWeek: 2,
  startTime: time('10:00'),
  endTime: time('11:30'),
  startDate: date('2030-08-19'),
  endDate: date('2031-06-13'),
  ...patch,
});

describe('readOtherSchoolHolds', () => {
  let tx: TxMock;
  const read = (options?: { teachers?: boolean }) =>
    readOtherSchoolHolds(tx as unknown as PrismaClient, YEAR, SCHOOL, options);

  beforeEach(() => {
    tx = createTxMock();
    tx.academicYear.findUnique.mockResolvedValue({ startDate: date('2030-08-15'), endDate: date('2031-06-15') });
  });

  it('reads no teacher’s times for a school without another school of its huvudman, and holds nothing with no loan', async () => {
    tx.$queryRaw.mockResolvedValueOnce([]);
    await expect(read()).resolves.toEqual({ holds: [] });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.roomLoan.findMany).toHaveBeenCalledTimes(1);
  });

  it('keeps an approved loan of its room for an owner with no other school left, until it ends it', async () => {
    // No sibling: the borrower has left the huvudman, and so may the owner
    // have. The owner's arm still shows the approved loan.
    tx.$queryRaw.mockResolvedValueOnce([]);
    tx.roomLoan.findMany.mockResolvedValue([loan({ borrowerSchoolId: 'f0000000-0000-4000-8000-00000000000f' })]);
    const { holds } = await read();
    expect(holds.map((hold) => [hold.kind, hold.resourceId, hold.dayOfWeek, hold.startTime, hold.endTime, hold.schools])).toEqual([
      ['ROOM_LENT', HALL, 2, '10:00:00', '11:30:00', ['en skola som har lämnat huvudmannen']],
    ]);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('holds a shared teacher at the other school’s lessons, the walk counted and on the grid', async () => {
    tx.$queryRaw
      .mockResolvedValueOnce([{ school_id: NORRA, name: 'Norraskolan' }])
      .mockResolvedValueOnce([
        {
          teacher_id: ANNA,
          school_id: NORRA,
          day_of_week: 2,
          start_time: time('10:02'),
          end_time: time('10:58'),
          recurrence: 'ODD_WEEKS',
          start_date: date('2030-09-02'),
          end_date: date('2030-12-20'),
          travel_minutes: 15,
        },
      ]);
    const { holds } = await read();
    expect(holds).toEqual([
      {
        holdId: holdId(SCHOOL, 'TEACHER_BUSY', ANNA, 2, '09:45:00', '11:15:00'),
        kind: 'TEACHER_BUSY',
        resourceKind: 'TEACHER',
        resourceId: ANNA,
        dayOfWeek: 2,
        startTime: '09:45:00',
        endTime: '11:15:00',
        schools: ['Norraskolan'],
        walked: true,
      },
    ]);
    // The year's own dates bound the read.
    const sql = (tx.$queryRaw.mock.calls[1]![0] as { values: unknown[] }).values;
    expect(sql).toEqual(['2030-08-15', '2031-06-15']);
  });

  it('closes a lent room in its approved windows, and the borrowed room outside them', async () => {
    tx.$queryRaw.mockResolvedValueOnce([{ school_id: NORRA, name: 'Norraskolan' }]).mockResolvedValueOnce([]);
    tx.roomLoan.findMany.mockResolvedValue([
      loan({}),
      loan({ status: 'PENDING', dayOfWeek: 3 }),
      // Every Thursday of the year, from 2030-08-15 (a Thursday) on.
      loan({
        ownerSchoolId: NORRA,
        borrowerSchoolId: SCHOOL,
        roomId: 'e0000000-0000-4000-8000-000000000005',
        localRoomId: LOCAL,
        dayOfWeek: 4,
        startDate: date('2030-08-15'),
        endDate: date('2031-06-15'),
      }),
    ]);
    const { holds } = await read();
    const lent = holds.filter((hold) => hold.kind === 'ROOM_LENT');
    expect(lent.map((hold) => [hold.resourceId, hold.dayOfWeek, hold.startTime, hold.endTime, hold.schools])).toEqual([
      [HALL, 2, '10:00:00', '11:30:00', ['Norraskolan']],
    ]);
    const borrowed = holds.filter((hold) => hold.kind === 'ROOM_BORROWED');
    expect(borrowed.every((hold) => hold.resourceId === LOCAL && hold.schools[0] === 'Norraskolan')).toBe(true);
    expect(borrowed.filter((hold) => hold.dayOfWeek === 4).map((hold) => `${hold.startTime}-${hold.endTime}`)).toEqual([
      '00:00:00-10:00:00',
      '11:30:00-23:59:00',
    ]);
    expect(borrowed.filter((hold) => hold.dayOfWeek !== 4)).toHaveLength(4);
  });

  it('closes a borrowed room whose loans are all pending or ended all week', async () => {
    tx.$queryRaw.mockResolvedValueOnce([{ school_id: NORRA, name: 'Norraskolan' }]).mockResolvedValueOnce([]);
    tx.roomLoan.findMany.mockResolvedValue([
      // Waiting beside an approval that gave it the room, and one withdrawn since.
      loan({ status: 'PENDING', ownerSchoolId: NORRA, borrowerSchoolId: SCHOOL, localRoomId: LOCAL }),
      loan({ status: 'WITHDRAWN', ownerSchoolId: NORRA, borrowerSchoolId: SCHOOL, localRoomId: LOCAL, dayOfWeek: 3 }),
    ]);
    const { holds } = await read();
    expect(holds.map((hold) => [hold.kind, hold.dayOfWeek, hold.startTime, hold.endTime])).toEqual(
      [1, 2, 3, 4, 5].map((day) => ['ROOM_BORROWED', day, '00:00:00', '23:59:00']),
    );
  });

  it('holds nothing for a request not yet approved: the approval makes the school\'s room', async () => {
    tx.$queryRaw.mockResolvedValueOnce([{ school_id: NORRA, name: 'Norraskolan' }]).mockResolvedValueOnce([]);
    tx.roomLoan.findMany.mockResolvedValue([loan({ status: 'PENDING', ownerSchoolId: NORRA, borrowerSchoolId: SCHOOL, localRoomId: null })]);
    await expect(read()).resolves.toEqual({ holds: [] });
  });

  it('holds a room lent to a school that has left the huvudman until the owner ends the loan, naming it so', async () => {
    tx.$queryRaw.mockResolvedValueOnce([{ school_id: NORRA, name: 'Norraskolan' }]).mockResolvedValueOnce([]);
    tx.roomLoan.findMany.mockResolvedValue([loan({ borrowerSchoolId: 'f0000000-0000-4000-8000-00000000000f' })]);
    const { holds } = await read();
    expect(holds.map((hold) => [hold.kind, hold.resourceId, hold.schools])).toEqual([
      ['ROOM_LENT', HALL, ['en skola som har lämnat huvudmannen']],
    ]);
  });

  it('sends a teacher’s block that the walk carries past midnight as ending at 23:59', async () => {
    tx.$queryRaw
      .mockResolvedValueOnce([{ school_id: NORRA, name: 'Norraskolan' }])
      .mockResolvedValueOnce([
        {
          teacher_id: ANNA,
          school_id: NORRA,
          day_of_week: 3,
          start_time: time('23:00'),
          end_time: time('23:50'),
          recurrence: 'ALL_WEEKS',
          start_date: date('2030-08-15'),
          end_date: date('2031-06-15'),
          travel_minutes: 15,
        },
      ]);
    const { holds } = await read();
    expect(holds.map((hold) => [hold.kind, hold.dayOfWeek, hold.startTime, hold.endTime])).toEqual([['TEACHER_BUSY', 3, '22:45:00', '23:59:00']]);
  });

  it('reads no teacher for the room optimisation', async () => {
    tx.$queryRaw.mockResolvedValueOnce([{ school_id: NORRA, name: 'Norraskolan' }]);
    await read({ teachers: false });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('gives a hold the same id each time, shaped as a uuid', () => {
    const id = holdId(SCHOOL, 'ROOM_LENT', HALL, 2, '10:00:00', '11:30:00');
    expect(id).toBe(holdId(SCHOOL, 'ROOM_LENT', HALL, 2, '10:00:00', '11:30:00'));
    expect(id).not.toBe(holdId(SCHOOL, 'ROOM_LENT', HALL, 3, '10:00:00', '11:30:00'));
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('names the teacher line by the code the stored conflicts name teachers for', () => {
    expect(HOLD_CODES.TEACHER_BUSY).toBe(OTHER_SCHOOL_TEACHER_CODE);
  });
});
