import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

const ADMIN_PROFILES = ['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION', 'LASARE'];
const YEAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/**
 * Vad kom in's route: who may reach it and what a request must be. The mocks stand in for the database, so these hold
 * the role gate, the validation and the shape of the answer, and say nothing of which rows a role reads or whether a
 * count is right: src/intake/intake.spec.ts holds the rules and scripts/test/probe-intake.ts holds the counts against a
 * real database under row security.
 */
describe('/api/v1/intake (e2e)', () => {
  let harness: TestHarness;
  const http = () => request(harness.app.getHttpServer());

  beforeAll(async () => {
    harness = await createTestApp();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    harness.tx['academicYear']!['findFirst']!.mockResolvedValue({ id: YEAR, name: '2026/2027', isActive: true, gradeNumbering: 'NIOARIG' });
    harness.tx['academicYear']!['count']!.mockResolvedValue(1);
    harness.tx['subject']!['count']!.mockResolvedValue(8);
    harness.tx['room']!['count']!.mockResolvedValue(7);
    harness.tx['rast']!['count']!.mockResolvedValue(2);
    harness.tx['user']!['count']!.mockResolvedValue(10);
    harness.tx['teachingRequirement']!['count']!.mockResolvedValue(30);
    harness.tx['teacherEmployment']!['count']!.mockResolvedValue(10);
    harness.tx['staffingPolicy']!['findUnique']!.mockResolvedValue(null);
    // What the school has turned on and set up beyond what Generera asks: no row of any of them is "off", as it is for a school that never touched them.
    for (const model of ['lunchSetting', 'absenceWatchSetting', 'ackSetting', 'publicationSettings', 'coverSettings']) {
      harness.tx[model]!['findUnique']!.mockResolvedValue(null);
    }
    harness.tx['frameTime']!['findMany']!.mockResolvedValue([{ minGradeLevel: 7, maxGradeLevel: 9 }]);
    harness.tx['studentGroup']!['findMany']!.mockResolvedValue([]);
    harness.tx['studentGroup']!['count']!.mockResolvedValue(0);
    harness.tx.$queryRaw.mockResolvedValue([]);
  });

  it.each(['TEACHER', 'STUDENT', 'GUARDIAN'])('refuses %s: the school\'s base data is the administrators\'', async (role) => {
    await http().get('/api/v1/intake').set('x-test-user', asUser({ role: role as never })).expect(403);
    expect(harness.tx['academicYear']!['findFirst']).not.toHaveBeenCalled();
    expect(harness.tx['room']!['count']).not.toHaveBeenCalled();
  });

  it('refuses nobody-in-particular without a token', async () => {
    await http().get('/api/v1/intake').expect(401);
  });

  it('lets every administrator profile read it, the läsare and a profile without HR-läs included', async () => {
    for (const adminProfile of ADMIN_PROFILES) {
      const response = await http().get('/api/v1/intake').set('x-test-user', asUser({ adminProfile: adminProfile as never, hrRead: false })).expect(200);
      expect(response.body.year).toEqual({ id: YEAR, name: '2026/2027', isActive: true });
    }
  });

  it('answers one shape: fifteen areas, each with what it found, whether it waits for a year and every gap it has, and the three counts', async () => {
    const response = await http().get('/api/v1/intake').set('x-test-user', asUser({})).expect(200);
    expect(Object.keys(response.body).sort()).toEqual(['areas', 'hard', 'info', 'soft', 'year']);
    expect(response.body.areas.map((area: { area: string }) => area.area)).toEqual([
      'YEAR',
      'SUBJECTS',
      'ROOMS',
      'FRAME_TIMES',
      'RASTS',
      'BREAKS',
      'LUNCH',
      'SUPERVISION',
      'CLASSES',
      'TEACHING_GROUPS',
      'PEOPLE',
      'TIMPLAN',
      'REQUIREMENTS',
      'STAFFING',
      'SWITCHES',
    ]);
    for (const area of response.body.areas) {
      expect(Object.keys(area).sort()).toEqual(['area', 'found', 'gaps', 'waitsForYear']);
      expect(typeof area.found).toBe('object');
      for (const gap of area.gaps) {
        expect(Object.keys(gap).sort()).toEqual(['code', 'count', 'items', 'level', 'more']);
      }
    }
  });

  it('holds no person: nothing in the answer is a name, an address or a number of a post', async () => {
    harness.tx['studentGroup']!['findMany']!.mockImplementation(async (args: { where: { kind: string } }) =>
      args.where.kind === 'CLASS' ? [{ name: 'Förberedelse', gradeLevel: null }] : [{ name: 'En74' }],
    );
    const response = await http().get('/api/v1/intake').set('x-test-user', asUser({})).expect(200);
    expect(JSON.stringify(response.body)).toContain('Förberedelse');
    expect(JSON.stringify(response.body)).not.toMatch(/@|employmentPercent|firstName|lastName|personnummer/i);
  });

  it('takes no year: it reads the active one, whatever a query names', async () => {
    await http().get('/api/v1/intake').set('x-test-user', asUser({})).expect(200);
    await http().get('/api/v1/intake?academicYearId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').set('x-test-user', asUser({})).expect(200);
    for (const call of harness.tx['academicYear']!['findFirst']!.mock.calls) expect(call[0]).toMatchObject({ where: { isActive: true } });
    expect(harness.tx['academicYear']!['findFirst']).toHaveBeenCalledTimes(2);
  });

  it('has no write: every other verb is refused as no route', async () => {
    for (const verb of ['post', 'put', 'patch', 'delete'] as const) {
      await http()[verb]('/api/v1/intake').set('x-test-user', asUser({})).send({}).expect(404);
    }
  });
});
