import { createTxMock } from '../../test/utils/prisma-mock';
import { readPublishedSittings, snapshotSittings } from './published-grundschema';

const time = (value: string): Date => new Date(`1970-01-01T${value}:00.000Z`);
const day = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

const publication = { id: 'pub-1', schoolId: 'school-1', academicYearId: 'year-1' };

describe('a publication’s meals', () => {
  describe('snapshotSittings', () => {
    it('writes nothing for a year that has no meal', async () => {
      const tx = createTxMock();
      tx['lunchSitting']!['findMany']!.mockResolvedValue([]);

      await expect(snapshotSittings(tx as never, publication)).resolves.toBe(0);
      expect(tx['publishedLunchSitting']!['createMany']).not.toHaveBeenCalled();
    });

    it('keeps the weeks each meal holds, so a class that eats at two times has both rows', async () => {
      const tx = createTxMock();
      const autumn = { studentGroupId: '4A', dayOfWeek: 2, startTime: time('11:00'), endTime: time('11:30'), startDate: null, endDate: day('2026-12-20') };
      const spring = { studentGroupId: '4A', dayOfWeek: 2, startTime: time('11:30'), endTime: time('12:00'), startDate: day('2027-01-11'), endDate: null };
      tx['lunchSitting']!['findMany']!.mockResolvedValue([autumn, spring]);
      tx['publishedLunchSitting']!['createMany']!.mockResolvedValue({ count: 2 });

      await expect(snapshotSittings(tx as never, publication)).resolves.toBe(2);

      expect(tx['publishedLunchSitting']!['createMany']).toHaveBeenCalledWith({
        data: [
          { schoolId: 'school-1', publicationId: 'pub-1', academicYearId: 'year-1', ...autumn },
          { schoolId: 'school-1', publicationId: 'pub-1', academicYearId: 'year-1', ...spring },
        ],
      });
    });

    it('asks for the dates, and for the year’s meals in an order that puts the whole läsår and the earliest first', async () => {
      const tx = createTxMock();
      tx['lunchSitting']!['findMany']!.mockResolvedValue([]);

      await snapshotSittings(tx as never, publication);

      expect(tx['lunchSitting']!['findMany']).toHaveBeenCalledWith({
        where: { academicYearId: 'year-1' },
        select: { studentGroupId: true, dayOfWeek: true, startTime: true, endTime: true, startDate: true, endDate: true },
        orderBy: [{ studentGroupId: 'asc' }, { dayOfWeek: 'asc' }, { startDate: { sort: 'asc', nulls: 'first' } }],
      });
    });
  });

  describe('readPublishedSittings', () => {
    it('returns each meal with its weeks, and drops a meal whose class is gone', async () => {
      const tx = createTxMock();
      const autumn = { studentGroupId: '4A', dayOfWeek: 2, startTime: time('11:00'), endTime: time('11:30'), startDate: null, endDate: day('2026-12-20') };
      const spring = { studentGroupId: '4A', dayOfWeek: 2, startTime: time('11:30'), endTime: time('12:00'), startDate: day('2027-01-11'), endDate: null };
      const gone = { studentGroupId: '4Z', dayOfWeek: 2, startTime: time('11:00'), endTime: time('11:30'), startDate: null, endDate: null };
      tx['publishedLunchSitting']!['findMany']!.mockResolvedValue([autumn, spring, gone]);
      tx['studentGroup']!['findMany']!.mockResolvedValue([{ id: '4A' }]);

      await expect(readPublishedSittings(tx as never, 'pub-1')).resolves.toEqual([autumn, spring]);
      expect(tx['publishedLunchSitting']!['findMany']).toHaveBeenCalledWith({
        where: { publicationId: 'pub-1' },
        select: { studentGroupId: true, dayOfWeek: true, startTime: true, endTime: true, startDate: true, endDate: true },
        orderBy: [{ studentGroupId: 'asc' }, { dayOfWeek: 'asc' }, { startDate: { sort: 'asc', nulls: 'first' } }],
      });
    });

    it('reads nothing of the classes when the publication has no meal', async () => {
      const tx = createTxMock();
      tx['publishedLunchSitting']!['findMany']!.mockResolvedValue([]);

      await expect(readPublishedSittings(tx as never, 'pub-1')).resolves.toEqual([]);
      expect(tx['studentGroup']!['findMany']).not.toHaveBeenCalled();
    });
  });
});
