import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import { recordedReads } from '../../test/utils/recorded-reads';
import type { PrismaService } from '../database/prisma.service';
import { MAX_ORDERS_PER_DAY, SCHOOL_EXPORT_CODES, SchoolExportService } from './school-export.service';

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const EXPORT = '44444444-4444-4444-8444-444444444444';
const PUPIL = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-11-05T12:00:00.000Z');

describe('SchoolExportService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let service: SchoolExportService;

  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] }).setSystemTime(NOW);
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new SchoolExportService(prisma as unknown as PrismaService);
  });

  afterEach(() => jest.useRealTimers());

  const row = (over: object = {}) => ({
    id: EXPORT, status: 'READY', requestedAt: NOW, startedAt: NOW, finishedAt: NOW, expiresAt: new Date(NOW.getTime() + 3_600_000), byteSize: BigInt(10),
    sha256: 'a'.repeat(64), files: [{ path: 'README.txt', rows: 0, bytes: 5 }], heldOut: { people: 1, links: 0 }, errorClass: null, requestedById: ADMIN, ...over,
  });

  describe('who may', () => {
    it.each([
      ['a schemaläggare', { adminProfile: 'SCHEMALAGGARE' as const }],
      ['the expedition', { adminProfile: 'EXPEDITION' as const }],
      ['a läsare', { adminProfile: 'LASARE' as const }],
      ['an administrator with no profile', { adminProfile: undefined }],
      ['the huvudman\'s reader', { huvudman: { id: 'h', name: 'Kommunen', memberId: 'm', role: 'PLANERARE', firstName: 'a', lastName: 'b' } as never, userId: undefined }],
      ['a login with no person at the school', { userId: undefined }],
    ])('refuses %s every route, by name, before the database is asked', async (_who, over) => {
      const user = testUser(over);
      for (const call of [() => service.list(user), () => service.order(user), () => service.withdraw(EXPORT, user), () => service.openFile(EXPORT, user)]) {
        await expect(call()).rejects.toMatchObject({ response: { code: SCHOOL_EXPORT_CODES.decides } });
      }
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it.each(['FULL', 'REKTOR'] as const)('lets %s list', async (adminProfile) => {
      await expect(service.list(testUser({ adminProfile }))).resolves.toEqual([]);
    });
  });

  describe('list', () => {
    it('says who ordered, whether the file can still be fetched, and nothing of a person but a name', async () => {
      tx.schoolExport.findMany.mockResolvedValue([
        row(),
        row({ id: 'b', status: 'READY', expiresAt: new Date(NOW.getTime() - 1) }),
        row({ id: 'c', status: 'FAILED', byteSize: null, sha256: null, expiresAt: null, errorClass: 'RequesterGone', requestedById: null, files: null, heldOut: null }),
      ]);
      tx.user.findMany.mockResolvedValue([{ id: ADMIN, firstName: 'Rek', lastName: 'Tor' }]);
      const [a, b, c] = await service.list(testUser());
      expect(a).toMatchObject({ id: EXPORT, byteSize: 10, fetchable: true, requestedBy: { id: ADMIN, name: 'Rek Tor' } });
      expect(b).toMatchObject({ fetchable: false });
      expect(c).toMatchObject({ fetchable: false, requestedBy: null, errorClass: 'RequesterGone', byteSize: null });
      expect(tx.schoolExport.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { requestedAt: 'desc' }, take: 20 }));
    });
  });

  describe('order', () => {
    it('creates the order in the caller\'s school and name and answers it as the list does', async () => {
      tx.schoolExport.count.mockResolvedValue(0);
      tx.schoolExport.create.mockResolvedValue({ id: EXPORT });
      tx.schoolExport.findMany.mockResolvedValue([row({ status: 'QUEUED', byteSize: null, sha256: null, expiresAt: null })]);
      const placed = await service.order(testUser());
      expect(tx.schoolExport.create).toHaveBeenCalledWith({ data: { schoolId: SCHOOL, requestedById: ADMIN }, select: { id: true } });
      expect(placed).toMatchObject({ id: EXPORT, status: 'QUEUED', fetchable: false });
      // The day's count is the school's last 24 hours.
      expect(tx.schoolExport.count).toHaveBeenCalledWith({ where: { requestedAt: { gt: new Date(NOW.getTime() - 24 * 3_600_000) } } });
    });

    it('refuses a fourth order in a day with 429, and an order while one is in hand with 409', async () => {
      tx.schoolExport.count.mockResolvedValue(MAX_ORDERS_PER_DAY);
      await expect(service.order(testUser())).rejects.toMatchObject({ status: 429, response: { code: SCHOOL_EXPORT_CODES.tooMany } });
      expect(tx.schoolExport.create).not.toHaveBeenCalled();

      tx.schoolExport.count.mockResolvedValue(0);
      tx.schoolExport.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('x', { code: 'P2002', clientVersion: '7' }));
      await expect(service.order(testUser())).rejects.toMatchObject({ status: 409, response: { code: SCHOOL_EXPORT_CODES.inHand } });
    });

    it('lets any other error through as it is', async () => {
      tx.schoolExport.count.mockResolvedValue(0);
      tx.schoolExport.create.mockRejectedValue(new Error('connection lost'));
      await expect(service.order(testUser())).rejects.toThrow('connection lost');
    });
  });

  describe('withdraw', () => {
    it('deletes the order, or says there is none', async () => {
      tx.schoolExport.deleteMany.mockResolvedValue({ count: 1 });
      await expect(service.withdraw(EXPORT, testUser())).resolves.toBeUndefined();
      expect(tx.schoolExport.deleteMany).toHaveBeenCalledWith({ where: { id: EXPORT } });
      tx.schoolExport.deleteMany.mockResolvedValue({ count: 0 });
      await expect(service.withdraw(EXPORT, testUser())).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('openFile', () => {
    const ready = (over: object = {}) => ({
      id: EXPORT, status: 'READY', expiresAt: new Date(NOW.getTime() + 3_600_000), byteSize: BigInt(6), sha256: createHash('sha256').update(Buffer.from('abcdef')).digest('hex'),
      chunkCount: 2, readAbout: { PEOPLE: [PUPIL], ATTENDANCE: [PUPIL, ADMIN] }, finishedAt: NOW, school: { slug: 'prov-skolan' }, ...over,
    });

    it('is not found, gone, or not ready, by name', async () => {
      tx.schoolExport.findUnique.mockResolvedValue(null);
      await expect(service.openFile(EXPORT, testUser())).rejects.toMatchObject({ status: 404 });
      tx.schoolExport.findUnique.mockResolvedValue(ready({ expiresAt: new Date(NOW.getTime() - 1) }));
      await expect(service.openFile(EXPORT, testUser())).rejects.toMatchObject({ status: 410, response: { code: SCHOOL_EXPORT_CODES.expired } });
      tx.schoolExport.findUnique.mockResolvedValue(ready({ status: 'EXPIRED' }));
      await expect(service.openFile(EXPORT, testUser())).rejects.toMatchObject({ status: 410 });
      tx.schoolExport.findUnique.mockResolvedValue(ready({ status: 'RUNNING', byteSize: null, sha256: null, chunkCount: null }));
      await expect(service.openFile(EXPORT, testUser())).rejects.toMatchObject({ status: 409, response: { code: SCHOOL_EXPORT_CODES.notReady } });
      expect(recordedReads(tx)).toEqual([]);
    });

    it('records the fetch per kind, naming the persons the file holds rows about, before a piece is read', async () => {
      tx.schoolExport.findUnique.mockResolvedValue(ready());
      await service.openFile(EXPORT, testUser({ channel: 'WEB' }));
      expect(recordedReads(tx)).toEqual([
        { kind: 'PEOPLE', channel: 'WEB', ids: [PUPIL] },
        { kind: 'ATTENDANCE', channel: 'WEB', ids: [PUPIL, ADMIN] },
      ]);
      expect(tx.schoolExportChunk.findMany).not.toHaveBeenCalled();
    });

    it('sends the pieces in order, eight to a read, and checks the length and the SHA-256 at the end', async () => {
      tx.schoolExport.findUnique.mockResolvedValue(ready());
      tx.schoolExportChunk.findMany.mockResolvedValue([
        { seq: 0, bytes: Buffer.from('abc') },
        { seq: 1, bytes: Buffer.from('def') },
      ]);
      const opened = await service.openFile(EXPORT, testUser());
      expect(opened).toMatchObject({ byteSize: 6, chunkCount: 2, filename: 'rastra-skolexport-prov-skolan-2026-11-05.zip' });
      const got: string[] = [];
      for await (const piece of opened.pieces()) got.push(piece.toString());
      expect(got).toEqual(['abc', 'def']);
      expect(tx.schoolExportChunk.findMany).toHaveBeenCalledTimes(1);
      expect(tx.schoolExportChunk.findMany).toHaveBeenCalledWith({ where: { exportId: EXPORT, seq: { gte: 0, lt: 8 } }, orderBy: { seq: 'asc' }, select: { seq: true, bytes: true } });
    });

    it('says the file is gone when a piece has vanished, and when the pieces are not the file', async () => {
      tx.schoolExport.findUnique.mockResolvedValue(ready());
      tx.schoolExportChunk.findMany.mockResolvedValue([{ seq: 0, bytes: Buffer.from('abc') }]);
      const cut = await service.openFile(EXPORT, testUser());
      await expect((async () => { for await (const _ of cut.pieces()) void _; })()).rejects.toMatchObject({ status: 410, response: { code: SCHOOL_EXPORT_CODES.incomplete } });

      tx.schoolExportChunk.findMany.mockResolvedValue([{ seq: 0, bytes: Buffer.from('abc') }, { seq: 1, bytes: Buffer.from('xyz') }]);
      const wrong = await service.openFile(EXPORT, testUser());
      await expect((async () => { for await (const _ of wrong.pieces()) void _; })()).rejects.toMatchObject({ status: 410, response: { code: SCHOOL_EXPORT_CODES.incomplete } });

      tx.schoolExportChunk.findMany.mockResolvedValue([]);
      const none = await service.openFile(EXPORT, testUser());
      await expect((async () => { for await (const _ of none.pieces()) void _; })()).rejects.toMatchObject({ status: 410 });
    });
  });
});
