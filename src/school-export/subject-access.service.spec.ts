import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import { readZip } from '../schedule-exchange/zip';
import type { PrismaService } from '../database/prisma.service';
import { SCHOOL_EXPORT_CODES } from './school-export.service';
import { MAX_EXTRACT_BYTES, SubjectAccessService } from './subject-access.service';

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const PUPIL = '55555555-5555-4555-8555-555555555555';
const GUARDIAN = '66666666-6666-4666-8666-666666666666';
const GUARDIAN_2 = '77777777-7777-4777-8777-777777777777';

describe('SubjectAccessService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let service: SubjectAccessService;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new SubjectAccessService(prisma as unknown as PrismaService);
    tx.user.findUnique.mockResolvedValue({ id: PUPIL });
    tx.school.findUniqueOrThrow.mockResolvedValue({ name: 'Provskolan' });
  });

  /** The protected persons of the school, as the marks query answers; every other statement answers nothing. */
  const textOf = (sql: unknown): string => (Array.isArray(sql) ? sql.join('?') : (((sql as { strings?: string[] }).strings ?? []).join('?')));
  const marks = (rows: Array<{ id: string; first: string; last: string; email: string }>) =>
    tx.$queryRaw.mockImplementation(async (sql: unknown) => (textOf(sql).includes('FROM "PersonProtections" p') ? rows : []));

  const unzip = (base64: string) => readZip(Buffer.from(base64, 'base64'), { maxEntryBytes: 1 << 26, maxTotalBytes: 1 << 27, maxEntries: 500 });

  it.each([
    ['a schemaläggare', { adminProfile: 'SCHEMALAGGARE' as const }],
    ['the expedition', { adminProfile: 'EXPEDITION' as const }],
    ['a läsare', { adminProfile: 'LASARE' as const }],
    ['the huvudman\'s reader', { huvudman: { id: 'h', name: 'K', memberId: 'm', role: 'PLANERARE', firstName: 'a', lastName: 'b' } as never, userId: undefined }],
  ])('refuses %s, before the database is asked', async (_who, over) => {
    await expect(service.extract(testUser(over), PUPIL, false)).rejects.toMatchObject({ response: { code: SCHOOL_EXPORT_CODES.decides } });
    expect(prisma.withRls).not.toHaveBeenCalled();
  });

  it('does not find a person the administrator\'s school does not hold', async () => {
    tx.user.findUnique.mockResolvedValue(null);
    await expect(service.extract(testUser({ schoolId: SCHOOL }), PUPIL, false)).rejects.toMatchObject({ status: 404 });
  });

  it('gives a zip of the seven data files and the manifest, named for the day and the first of the id, never the person', async () => {
    marks([]);
    const answer = await service.extract(testUser({ schoolId: SCHOOL }), PUPIL, false);
    expect(answer).toMatchObject({ contentType: 'application/zip', subjectIsMarked: false, relatedIncluded: 0, relatedHeldOut: 0 });
    expect(answer.filename).toMatch(/^registerutdrag-\d{4}-\d{2}-\d{2}-55555555\.zip$/);
    const files = unzip(answer.contentBase64);
    expect([...files.keys()].slice(0, 2)).toEqual(['README.txt', 'FORMAT.md']);
    expect([...files.keys()].filter((name) => name.startsWith('data/'))).toEqual([
      'data/personer.csv', 'data/kopplingar.csv', 'data/narvaro.csv', 'data/franvaroanmalningar.csv', 'data/ledigheter.csv', 'data/notiser.csv', 'data/laslogg.csv',
    ]);
    expect(files.has('csv/amnen.csv')).toBe(false);
    expect(JSON.parse(files.get('manifest.json')!.toString('utf8')).kind).toBe('registerutdrag');
    expect(files.get('README.txt')!.toString('utf8')).toContain('registerutdrag (GDPR artikel 15)');
  });

  it('brings a pupil\'s guardian when asked, and holds a protected one out and counts it', async () => {
    tx.guardianStudent.findMany.mockResolvedValue([
      { guardianId: GUARDIAN, studentId: PUPIL },
      { guardianId: GUARDIAN_2, studentId: PUPIL },
    ]);
    marks([{ id: GUARDIAN_2, first: 'Skyddad', last: 'Person', email: 'skyddad@x.example' }]);
    const answer = await service.extract(testUser({ schoolId: SCHOOL }), PUPIL, true);
    expect(answer).toMatchObject({ relatedIncluded: 1, relatedHeldOut: 1, subjectIsMarked: false });
    // The link query asks for both directions.
    expect(tx.guardianStudent.findMany).toHaveBeenCalledWith({ where: { OR: [{ studentId: PUPIL }, { guardianId: PUPIL }] }, select: { guardianId: true, studentId: true } });
    // The persons asked for are the pupil and the unmarked guardian: the personer query is given exactly those.
    const asked = (tx.$queryRaw.mock.calls as Array<[{ values?: unknown[] }]>).flatMap(([sql]) => sql.values ?? []).filter((v): v is string[] => Array.isArray(v) && v.length === 2);
    expect(asked.some((ids) => ids.includes(PUPIL) && ids.includes(GUARDIAN) && !ids.includes(GUARDIAN_2))).toBe(true);
  });

  it('gives a protected person their own data and no one else\'s, and says so', async () => {
    tx.guardianStudent.findMany.mockResolvedValue([{ guardianId: GUARDIAN, studentId: PUPIL }]);
    marks([{ id: PUPIL, first: 'Skyddad', last: 'Elev', email: 'elev@x.example' }]);
    const answer = await service.extract(testUser({ schoolId: SCHOOL }), PUPIL, true);
    expect(answer).toMatchObject({ subjectIsMarked: true, relatedIncluded: 0, relatedHeldOut: 1 });
    expect(unzip(answer.contentBase64).get('README.txt')!.toString('utf8')).toContain('Personen har en markering för skyddad identitet');
  });

  it('records the read per kind, in the läslogg, before the answer leaves, and fails if it cannot', async () => {
    marks([]);
    await service.extract(testUser({ schoolId: SCHOOL, channel: 'WEB' }), PUPIL, false);
    // A transaction of its own, after the build, for the records.
    const last = prisma.withRls.mock.calls.length - 1;
    expect(last).toBeGreaterThan(3);

    prisma.withRls.mockImplementation(async (_user: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(tx));
    tx.$executeRaw.mockRejectedValue(new Error('the log is down'));
    tx.$queryRaw.mockImplementation(async (sql: unknown) => {
      const text = textOf(sql);
      return text.includes('FROM "PersonProtections" p') ? [] : text.includes('FROM "Users" u LEFT JOIN') ? [{ id: PUPIL, role: 'STUDENT', first: 'a', last: 'b', email: 'e', phone: null, active: true, klass: null, created: 'c', deactivated: null, pseudonymised: null, profile: null, hr: false }] : [];
    });
    await expect(service.extract(testUser({ schoolId: SCHOOL }), PUPIL, false)).rejects.toThrow('the log is down');
  });

  it('keeps an extract to 64 MB', () => {
    expect(MAX_EXTRACT_BYTES).toBe(64 * 1024 * 1024);
  });
});
