import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { Role } from '../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../src/auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../src/database/prisma.service';
import { applyChanges, type StoredChange } from '../src/integration/ss12000-sync/apply';
import { createTestApp, type TestHarness } from './utils/test-app';

/**
 * Skyddad identitet (20270107090000), against a database with the RLS
 * fixtures (scripts/test/run-rls-tests.sh first): every file of people
 * Rastra writes, built as the product builds it — the gateway's own exports
 * through the real gateway, and the web's files by the web's own builders
 * (web/lib/*.ts, loaded as they are), fed by the same gateway and the same
 * database under row security — for the fixtures' school 'rls-skyddad-school':
 *
 *   P1, a pupil the register marked, and G1, his guardian (not marked);
 *   G2, a guardian marked by hand, and P2, her child (not marked);
 *   T1, a teacher marked by hand; T2, P4 and G3, nobody marked.
 *
 * P1 and G1 are in no file, nor is G2; the link P2–G2 is held out; T1 is in
 * no file but SCB's, which says how many it keeps. Then the SS12000 sync's
 * own apply marks P4 under the sync principal, and P4 and G3 leave the files
 * too; the administrator's apply of the register's "Ingen" brings them back.
 *
 * Runs only with SKYDDAD_DATABASE_URL (the API role's URL of such a
 * database); CI's Database job sets it, the e2e job skips it.
 */

const DATABASE = process.env['SKYDDAD_DATABASE_URL'];
const FULL = '00000000-0000-4000-8000-e50000000001';
const P4_REGISTER_ID = 'e5000000-0000-4000-8000-000000000014';

// The web's builders read the gateway through lib/api; here it is the real
// gateway, asked as the school's full administrator.
let mockGet: (path: string) => Promise<unknown> = () => Promise.reject(new Error('the gateway is not up'));
jest.mock('@/lib/api', () => ({ api: { get: (path: string) => mockGet(path) } }), { virtual: true });
jest.mock('@/lib/csv-export', () => jest.requireActual('../web/lib/csv-export'), { virtual: true });
jest.mock('@/lib/protected-people', () => jest.requireActual('../web/lib/protected-people'), { virtual: true });
jest.mock('@/lib/lesson-lengths', () => jest.requireActual('../web/lib/lesson-lengths'), { virtual: true });

type Person = { id: string; role: string; email: string; firstName: string; lastName: string; isActive: boolean; studentGroupId: string | null };
type HeldOut = { content: string | null; heldOut: number; unit?: string };
/* eslint-disable @typescript-eslint/no-explicit-any */
const web = {
  csv: jest.requireActual('../web/lib/csv-export') as any,
  marks: jest.requireActual('../web/lib/protected-people') as any,
  guardians: jest.requireActual('../web/lib/guardians-csv-export') as any,
  duties: jest.requireActual('../web/lib/duties-csv-export') as any,
  requirements: jest.requireActual('../web/lib/requirements-csv-export') as any,
};
/* eslint-enable @typescript-eslint/no-explicit-any */

const maybe = DATABASE ? describe : describe.skip;

maybe('Skyddad identitet: a marked pupil and his guardian are in no file (a real database)', () => {
  let harness: TestHarness;
  let prisma: PrismaService;
  let admin: AuthenticatedUser;
  let school: string;
  let year: string;
  const http = () => harness.app.getHttpServer();

  beforeAll(async () => {
    process.env['DATABASE_URL'] = DATABASE;
    prisma = new PrismaService();
    await prisma.$connect();
    harness = await createTestApp({ configure: (builder) => builder.overrideProvider(PrismaService).useValue(prisma) });
    const row = await prisma.withVerifiedSubject(FULL, (db) =>
      db.user.findFirst({ where: { authId: FULL }, select: { id: true, schoolId: true } }),
    );
    if (!row) throw new Error('rls-skyddad-school is not planted: run scripts/test/run-rls-tests.sh first');
    school = row.schoolId;
    admin = { authId: FULL, role: Role.SCHOOL_ADMIN, userId: row.id, schoolId: school, adminProfile: 'FULL', hrRead: false };
    mockGet = async (path) => {
      const answer = await request(http()).get(path).set('x-test-user', JSON.stringify(admin));
      if (answer.status !== 200) throw new Error(`${path}: ${answer.status} ${JSON.stringify(answer.body)}`);
      return answer.body;
    };
    year = (await prisma.withRls(admin, (tx) => tx.academicYear.findFirst({ where: { schoolId: school, isActive: true }, select: { id: true } })))!.id;
  });

  afterAll(async () => {
    await harness?.close();
    await prisma?.$disconnect();
  });

  /** Every file of people, as an administrator downloads it today. */
  async function everyFile(): Promise<Record<string, HeldOut>> {
    const people = (await mockGet('/api/v1/users')) as Person[];
    const { groups, subjects, requirements } = await prisma.withRls(admin, async (tx) => ({
      groups: await tx.studentGroup.findMany({ where: { schoolId: school, academicYearId: year }, select: { id: true, name: true, kind: true, academicYearId: true } }),
      subjects: await tx.subject.findMany({ where: { schoolId: school }, select: { id: true, name: true, code: true } }),
      requirements: await tx.teachingRequirement.findMany({ where: { schoolId: school, academicYearId: year } }),
    }));
    const className = (id: string | null) => groups.find((group) => group.id === id)?.name ?? '';
    const qualifications = await mockGet('/api/v1/teacher-qualifications');
    const memberships = await mockGet('/api/v1/student-groups/memberships');
    const scb = (await mockGet(`/api/v1/staffing/scb-file?academicYearId=${year}`)) as { text: string; protectedInFile: number };
    const { withoutMarked } = web.marks;
    return {
      'elever.csv': await withoutMarked(people, 'STUDENT', (kept: Person[]) => web.csv.studentsToCsv(kept, className)),
      'larare.csv': await withoutMarked(people, 'TEACHER', (kept: Person[]) => web.csv.teachersToCsv(kept)),
      'behorigheter.csv': await withoutMarked(people, 'TEACHER', (kept: Person[]) =>
        web.csv.teacherQualificationsToCsv(qualifications, kept, subjects),
      ),
      'uppdrag.csv': await withoutMarked(people, 'TEACHER', (kept: Person[]) => web.duties.teacherDutiesCsvFor(year, kept, subjects, groups)),
      'undervisningsgrupper.csv': await withoutMarked(people, 'STUDENT', (kept: Person[]) =>
        web.csv.membershipsToCsv(groups.filter((group) => group.kind === 'TEACHING_GROUP'), kept, memberships),
      ),
      'timplansposter.csv': await web.requirements.requirementsCsvWithoutMarked(requirements, groups, subjects, people),
      'vardnadshavare.csv': await web.guardians.guardiansCsvFor(),
      'scb.txt': { content: scb.text, heldOut: scb.protectedInFile, unit: 'kept' },
    };
  }

  const emails = (...names: string[]) => names.map((name) => `${name}@example.invalid`);
  const named = (files: Record<string, HeldOut>, email: string) =>
    Object.entries(files)
      .filter(([, file]) => (file.content ?? '').toLowerCase().includes(email))
      .map(([name]) => name);

  it('names neither the marked pupil nor his guardian, nor a marked guardian, in any file, and the rest as before', async () => {
    const files = await everyFile();

    for (const email of emails('sk-p1', 'sk-g1', 'sk-g2')) expect({ email, files: named(files, email) }).toEqual({ email, files: [] });
    // P1 is a pupil, also in a teaching group: neither file has him; the names are gone with the addresses.
    for (const file of Object.values(files)) expect(file.content ?? '').not.toMatch(/Elev Ett|Vårdnadshavare (Ett|Två)/);
    // The marked teacher is in SCB's file alone, which keeps every teacher and counts the marked.
    expect(named(files, 'sk-t1@example.invalid')).toEqual([]);
    expect(files['scb.txt']!.content).toContain('Lärare Ett');
    expect(files['scb.txt']!.heldOut).toBe(1);

    // The unmarked are where they were: P2 (a marked guardian's child) is a pupil like any other.
    expect(files['elever.csv']!.content).toContain('sk-p2@example.invalid');
    expect(files['elever.csv']!.content).toContain('sk-p4@example.invalid');
    expect(files['larare.csv']!.content).toContain('sk-t2@example.invalid');
    expect(files['vardnadshavare.csv']!.content).toContain('sk-g3@example.invalid');
    expect(files['undervisningsgrupper.csv']!.content).toContain('sk-p4@example.invalid');
    expect(files['timplansposter.csv']!.content).toContain('sk-t2@example.invalid');

    // And each says how many it held out: P1 (P3 has left); T1; the links P1–G1 and P2–G2.
    expect(files['elever.csv']!.heldOut).toBe(2);
    expect(files['larare.csv']!.heldOut).toBe(1);
    expect(files['vardnadshavare.csv']).toMatchObject({ heldOut: 2, unit: 'links' });
  });

  it("holds out a pupil the sync marks, by the sync's own apply under its principal, until the register lifts it", async () => {
    const p4 = await prisma.withRls(admin, (tx) => tx.user.findFirst({ where: { schoolId: school, ss12000Id: P4_REGISTER_ID }, select: { id: true } }));
    expect(p4).not.toBeNull();
    const change = (op: 'ADD' | 'END'): StoredChange => ({
      id: randomUUID(), seq: 0, entity: 'PROTECTION', op, externalId: null, localId: null,
      after: { personExternalId: P4_REGISTER_ID, userLocalId: p4!.id }, protectedIdentity: false,
    });
    try {
      const marked = await prisma.withSyncPrincipal(school, (tx) => applyChanges(tx, school, [change('ADD')], new Date()));
      expect(marked.skipped).toEqual([]);

      const files = await everyFile();
      for (const email of emails('sk-p4', 'sk-g3')) expect({ email, files: named(files, email) }).toEqual({ email, files: [] });
      expect(files['vardnadshavare.csv']!.heldOut).toBe(3);
      const marks = (await mockGet('/api/v1/person-protections')) as Array<{ userId: string; source: string }>;
      expect(marks).toContainEqual({ userId: p4!.id, source: 'SS12000' });
    } finally {
      // The register says "Ingen": the administrator's apply lifts the sync's mark.
      await prisma.withRls(admin, (tx) => applyChanges(tx, school, [change('END')], new Date()));
    }
    const after = await everyFile();
    expect(after['elever.csv']!.content).toContain('sk-p4@example.invalid');
    expect(after['vardnadshavare.csv']!.content).toContain('sk-g3@example.invalid');
  });

  it('holds out a pupil marked by hand through the gateway, and lets them back when the mark is removed', async () => {
    const p2 = await prisma.withRls(admin, (tx) => tx.user.findFirst({ where: { schoolId: school, email: 'sk-p2@example.invalid' }, select: { id: true } }));
    const as = (verb: 'put' | 'delete') => request(http())[verb](`/api/v1/person-protections/${p2!.id}`).set('x-test-user', JSON.stringify(admin));
    try {
      expect((await as('put')).body).toEqual({ userId: p2!.id, source: 'MANUAL' });
      const files = await everyFile();
      expect(named(files, 'sk-p2@example.invalid')).toEqual([]);
    } finally {
      expect((await as('delete')).status).toBe(200);
    }
    expect(named(await everyFile(), 'sk-p2@example.invalid')).toEqual(['elever.csv', 'undervisningsgrupper.csv']);
  });
});
