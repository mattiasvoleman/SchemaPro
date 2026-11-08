import { Prisma, type PrismaClient } from '@prisma/client';
import { createTxMock, type TxMock } from '../../test/utils/prisma-mock';
import { rawSql } from '../../test/utils/locking-read';
import { clashCount, clashRows, flagAfterPublication, toClashResponse, type ClashRow } from './external-clashes';

const SERIES = '44444444-4444-4444-8444-444444444441';
const OTHER_SERIES = '44444444-4444-4444-8444-444444444442';
const SCHOOL_ID = '33333333-3333-4333-8333-333333333333';

const clash = (patch: Partial<ClashRow> = {}): ClashRow => ({
  seriesId: SERIES,
  dayId: '55555555-5555-4555-8555-555555555551',
  organisation: 'Idrottsföreningen',
  targetName: 'Gymnastiksalen',
  startsAt: new Date('2027-02-02T17:00:00.000Z'),
  endsAt: new Date('2027-02-02T19:00:00.000Z'),
  lesson: 'Idrott 7A',
  ...patch,
});

describe('the days of external bookings that stand in a room with a lesson', () => {
  let tx: TxMock;
  const client = () => tx as unknown as PrismaClient;

  beforeEach(() => {
    tx = createTxMock();
  });

  describe('clashRows', () => {
    it('reads the clashes of the whole school, up to 500, when no series is named', async () => {
      tx.$queryRaw.mockResolvedValue([clash()]);

      await expect(clashRows(client(), null)).resolves.toEqual([clash()]);

      const call = tx.$queryRaw.mock.calls[0]!;
      expect(call[1]).toBe(Prisma.empty);
      expect(call[2]).toBe(500);
      const sql = rawSql(call);
      expect(sql).toContain('"CalendarLessons"');
      expect(sql).toContain(`"status" IN ('SCHEDULED', 'COMPLETED')`);
      expect(sql).toContain(`d."status" IN ('PENDING', 'APPROVED')`);
      expect(sql).toContain('d."endsAt" > now()');
    });

    it('narrows to the series named, as an array of uuids, with the limit asked for', async () => {
      await clashRows(client(), [SERIES, OTHER_SERIES], 5);

      const call = tx.$queryRaw.mock.calls[0]!;
      expect(call[1]).not.toBe(Prisma.empty);
      expect((call[1] as Prisma.Sql).values).toEqual([[SERIES, OTHER_SERIES]]);
      expect((call[1] as Prisma.Sql).strings.join('?')).toContain('"externalBookingId" = ANY(');
      expect(call[2]).toBe(5);
    });
  });

  describe('clashCount', () => {
    it('counts the distinct days that clash', async () => {
      tx.$queryRaw.mockResolvedValue([{ days: 4 }]);

      await expect(clashCount(client())).resolves.toBe(4);
      expect(rawSql(tx.$queryRaw.mock.calls[0]!)).toContain('count(DISTINCT d."id")');
    });

    it('counts none when the statement answers nothing', async () => {
      tx.$queryRaw.mockResolvedValue([]);

      await expect(clashCount(client())).resolves.toBe(0);
    });
  });

  describe('toClashResponse', () => {
    it('names the day on the school’s clock, and the instants as ISO strings', () => {
      expect(toClashResponse(clash(), 'Europe/Stockholm')).toEqual({
        seriesId: SERIES,
        dayId: '55555555-5555-4555-8555-555555555551',
        organisation: 'Idrottsföreningen',
        targetName: 'Gymnastiksalen',
        date: '2027-02-02',
        startsAt: '2027-02-02T17:00:00.000Z',
        endsAt: '2027-02-02T19:00:00.000Z',
        lesson: 'Idrott 7A',
      });
    });

    it('puts a day that starts after midnight at the school on the school’s date, not UTC’s', () => {
      const late = clash({ startsAt: new Date('2027-02-02T23:30:00.000Z'), endsAt: new Date('2027-02-03T00:30:00.000Z') });

      expect(toClashResponse(late, 'Europe/Stockholm').date).toBe('2027-02-03');
      expect(toClashResponse(late, 'UTC').date).toBe('2027-02-02');
    });
  });

  describe('flagAfterPublication', () => {
    let notifications: { notifyUsers: jest.Mock };

    beforeEach(() => {
      notifications = { notifyUsers: jest.fn().mockResolvedValue(2) };
    });

    it('tells nobody when no day clashes, and looks for no one to tell', async () => {
      tx.$queryRaw.mockResolvedValue([{ days: 0 }]);

      await expect(flagAfterPublication(client(), notifications, SCHOOL_ID)).resolves.toBe(0);

      expect(tx.user.findMany).not.toHaveBeenCalled();
      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });

    it('tells the administrators who write Drift, once, with a number and nothing else in the meta', async () => {
      tx.$queryRaw.mockResolvedValue([{ days: 3 }]);
      tx.user.findMany.mockResolvedValue([{ id: 'admin-1' }, { id: 'admin-2' }]);

      await expect(flagAfterPublication(client(), notifications, SCHOOL_ID)).resolves.toBe(3);

      expect(tx.user.findMany).toHaveBeenCalledWith({
        where: { role: 'SCHOOL_ADMIN', isActive: true, adminProfile: { in: ['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION'] } },
        select: { id: true },
      });
      expect(notifications.notifyUsers).toHaveBeenCalledTimes(1);
      const [passedTx, notice] = notifications.notifyUsers.mock.calls[0]!;
      expect(passedTx).toBe(tx);
      expect(notice).toEqual({
        schoolId: SCHOOL_ID,
        userIds: ['admin-1', 'admin-2'],
        type: 'EXTERNAL_BOOKING_CLASH',
        meta: { days: 3 },
        email: {
          subject: 'External bookings clash with lessons / Externa bokningar krockar med lektioner',
          body: expect.stringContaining('3 day(s) of external bookings'),
        },
      });
      // The hirer is not a user, and a notice goes on as e-mail and push: no name, no contact.
      expect(notice.email.body).toContain('3 dag(ar) av externa bokningar');
      expect(JSON.stringify(notice)).not.toMatch(/organisation|contact|phone/i);
    });

    it('leaves the läsare out, since they write nothing', async () => {
      tx.$queryRaw.mockResolvedValue([{ days: 1 }]);
      tx.user.findMany.mockResolvedValue([{ id: 'admin-1' }]);

      await flagAfterPublication(client(), notifications, SCHOOL_ID);

      expect(tx.user.findMany.mock.calls[0]![0].where.adminProfile.in).not.toContain('LASARE');
    });

    it('answers how many clash and sends nothing when no administrator is there to tell', async () => {
      tx.$queryRaw.mockResolvedValue([{ days: 2 }]);
      tx.user.findMany.mockResolvedValue([]);

      await expect(flagAfterPublication(client(), notifications, SCHOOL_ID)).resolves.toBe(2);

      expect(notifications.notifyUsers).not.toHaveBeenCalled();
    });
  });
});
