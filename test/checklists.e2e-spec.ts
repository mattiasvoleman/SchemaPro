import { Prisma } from '@prisma/client';
import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

const BASE = '/api/v1/checklists';
const TEMPLATE = '44444444-4444-4444-8444-444444444444';
const GROUP = '55555555-5555-4555-8555-555555555555';
const PUPIL = '66666666-6666-4666-8666-666666666666';
const LIST = '77777777-7777-4777-8777-777777777777';
const CLASS = '88888888-8888-4888-8888-888888888888';
const PROOF = '99999999-9999-4999-8999-999999999999';
const GUARDIAN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SCHOOL = '33333333-3333-4333-8333-333333333333';

const admin = asUser({});
const teacher = asUser({ role: 'TEACHER' as never });
const lasare = asUser({ adminProfile: 'LASARE' as never });

/** A refusal the database raised, as the adapter reports a raw statement's (P2010). */
const refusal = (code: string, name = '') =>
  new Prisma.PrismaClientKnownRequestError(`Raw query failed. Code: \`${code}\`. Message: \`${name}\``, {
    code: 'P2010',
    clientVersion: 'test',
    meta: { driverAdapterError: { cause: { originalCode: code } } },
  });
const known = (code: string) => new Prisma.PrismaClientKnownRequestError(`Prisma error ${code}`, { code, clientVersion: 'test' });

const template = (over: Record<string, unknown> = {}) => ({ id: TEMPLATE, schoolId: SCHOOL, subjectId: null, title: 'Cirkelsågen', description: null, active: true, ...over });
const list = (over: Record<string, unknown> = {}) => ({
  id: LIST,
  schoolId: SCHOOL,
  studentGroupId: CLASS,
  groupName: '7A',
  title: 'Fotografering',
  body: 'Vi får fotografera i skolans kanaler.',
  createdById: '22222222-2222-4222-8222-222222222222',
  createdAt: new Date('2026-10-01T08:00:00Z'),
  closedAt: null,
  ...over,
});
const pupil = { id: PUPIL, firstName: 'Anna', lastName: 'Andersson', schoolId: SCHOOL, role: 'STUDENT', isActive: true, studentGroupId: CLASS, studentGroup: { name: '7A' } };
const rector = { id: '22222222-2222-4222-8222-222222222222', firstName: 'Ada', lastName: 'Rektor', schoolId: SCHOOL, role: 'SCHOOL_ADMIN', isActive: true, studentGroupId: null, studentGroup: null };

/**
 * Checklistor's routes: who may reach them and what a request must be. The mocks stand in for the database, so these
 * hold the role and area gates, the validation and the answers of the controller, and say nothing of row security:
 * the RLS sections of the migration (20270129091000) and the adapter probe say who reads and writes which row.
 */
describe('/api/v1/checklists (e2e)', () => {
  let harness: TestHarness;
  const http = () => request(harness.app.getHttpServer());
  const get = (path: string, as = admin) => http().get(`${BASE}${path}`).set('x-test-user', as);
  const post = (path: string, body: unknown, as = admin) => http().post(`${BASE}${path}`).set('x-test-user', as).send(body as object);
  const patch = (path: string, body: unknown, as = admin) => http().patch(`${BASE}${path}`).set('x-test-user', as).send(body as object);
  const tx = () => harness.tx;

  /** Answers $queryRaw by a fragment of its SQL. */
  function raw(answers: Record<string, unknown>): void {
    tx().$queryRaw.mockImplementation((strings: unknown) => {
      const sql = Array.isArray(strings) ? strings.join('?') : String((strings as { sql?: string }).sql ?? strings);
      for (const [fragment, answer] of Object.entries(answers)) if (sql.includes(fragment)) return Promise.resolve(answer);
      return Promise.resolve([]);
    });
  }

  /** What the database's functions say by default: Kvittens on, and the one pupil taught, visible and mentored. */
  function defaults(over: Record<string, unknown> = {}): void {
    raw({
      'app.ack_enabled()': [{ on: true, enabled: true }],
      'app.checklist_taught_ids()': [{ ids: [PUPIL] }],
      'app.checklist_visible_ids()': [{ ids: [PUPIL] }],
      'app.ack_mentee_ids()': [{ ids: [PUPIL] }],
      'app.checklist_protected_ids': [{ ids: [] }],
      'app.checklist_mentee_class_ids': [{ ids: [CLASS] }],
      ...over,
    });
  }

  /** The school's users, as findMany and findFirst find them by the conditions put in `where`. */
  function users(people: Array<Record<string, unknown>>): void {
    const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
      Object.entries(where).every(([key, cond]) => {
        if (cond !== null && typeof cond === 'object') return 'in' in cond ? (cond as { in: unknown[] }).in.includes(row[key]) : true;
        return row[key] === cond;
      });
    tx()['user']!['findMany']!.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => people.filter((p) => matches(p, where)));
    tx()['user']!['findFirst']!.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => people.find((p) => matches(p, where)) ?? null);
  }

  beforeAll(async () => {
    harness = await createTestApp();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    // The mocks are shared by every test of the file: forget what the last one stubbed.
    for (const model of ['instructionTemplate', 'instructionProof', 'consentList', 'consentEntry', 'consentAsk', 'user', 'studentGroup', 'studentGroupMember', 'masterLesson', 'subject', 'school', 'guardianStudent', 'ackRequest', 'ackReceipt']) {
      for (const method of ['findMany', 'findFirst', 'findUnique', 'create', 'createMany', 'update']) {
        const fn = tx()[model]![method]!;
        fn.mockReset();
        if (method === 'findMany') fn.mockResolvedValue([]);
      }
    }
    tx().$executeRaw.mockReset();
    tx().$executeRaw.mockResolvedValue(0);
    defaults();
    users([pupil, rector]);
    tx()['school']!['findUnique']!.mockResolvedValue({ timezone: 'Europe/Stockholm' });
  });

  // Every route, with a body that would pass if the caller were allowed.
  const ROUTES: Array<[string, 'get' | 'post' | 'patch', string, object?]> = [
    ['settings', 'get', '/settings'],
    ['templates', 'get', '/templates'],
    ['createTemplate', 'post', '/templates', { title: 'Cirkelsågen' }],
    ['updateTemplate', 'patch', `/templates/${TEMPLATE}`, { active: false }],
    ['groups', 'get', '/groups'],
    ['instructors', 'get', '/instructors'],
    ['roster', 'get', `/templates/${TEMPLATE}/roster?groupId=${GROUP}`],
    ['rosterForPaper', 'get', `/templates/${TEMPLATE}/roster/print?groupId=${GROUP}`],
    ['tick', 'post', '/proofs', { templateId: TEMPLATE, studentIds: [PUPIL] }],
    ['voidProof', 'post', `/proofs/${PROOF}/void`, { reason: 'Fel elev' }],
    ['lists', 'get', '/consent-lists'],
    ['createList', 'post', '/consent-lists', { classId: CLASS, title: 'Fotografering', body: 'Text' }],
    ['detail', 'get', `/consent-lists/${LIST}`],
    ['detailForPaper', 'get', `/consent-lists/${LIST}/print`],
    ['record', 'post', `/consent-lists/${LIST}/entries`, { studentIds: [PUPIL], kind: 'GRANTED' }],
    ['ask', 'post', `/consent-lists/${LIST}/ask`, {}],
    ['close', 'post', `/consent-lists/${LIST}/close`, {}],
    ['student', 'get', `/students/${PUPIL}`],
  ];
  const send = (verb: 'get' | 'post' | 'patch', path: string, body: object | undefined, as?: string) => {
    const req = http()[verb](`${BASE}${path}`);
    if (as) req.set('x-test-user', as);
    return body === undefined ? req : req.send(body);
  };

  describe('who may reach them', () => {
    it.each(['STUDENT', 'GUARDIAN'])('refuses %s every route, and opens no transaction for them', async (role) => {
      const as = asUser({ role: role as never });
      for (const [name, verb, path, body] of ROUTES) {
        const res = await send(verb, path, body, as);
        expect([name, res.status]).toEqual([name, 403]);
      }
      expect(harness.prisma.withRls).not.toHaveBeenCalled();
    });

    it('refuses a visitor with no token every route', async () => {
      for (const [name, verb, path, body] of ROUTES) {
        const res = await send(verb, path, body);
        expect([name, res.status]).toEqual([name, 401]);
      }
      expect(harness.prisma.withRls).not.toHaveBeenCalled();
    });

    it('refuses the huvudman’s member with no school every route', async () => {
      const member = JSON.stringify({ authId: '11111111-1111-4111-8111-111111111111', role: 'HUVUDMAN' });
      for (const [name, verb, path, body] of ROUTES) {
        const res = await send(verb, path, body, member);
        expect([name, res.status]).toEqual([name, 403]);
      }
    });

    it('lets a teacher into every route but the writing of templates', async () => {
      tx()['instructionTemplate']!['findFirst']!.mockResolvedValue(template());
      tx()['instructionProof']!['createMany']!.mockResolvedValue({ count: 1 });
      defaults({
        'app.checklist_void_proof': [{ at: new Date('2026-11-07T10:00:00Z') }],
        'app.checklist_close_list': [{ at: new Date('2026-11-07T10:00:00Z') }],
      });
      for (const [name, verb, path, body] of ROUTES) {
        const res = await send(verb, path, body, teacher);
        if (name === 'createTemplate' || name === 'updateTemplate') expect([name, res.status]).toEqual([name, 403]);
        else expect([name, res.status < 500, res.status === 403]).toEqual([name, true, false]);
      }
      expect(tx()['instructionTemplate']!['create']).not.toHaveBeenCalled();
      expect(tx()['instructionTemplate']!['update']).not.toHaveBeenCalled();
    });

    it('keeps the templates to the administrators: a teacher is refused the POST and the PATCH', async () => {
      await post('/templates', { title: 'Cirkelsågen' }, teacher).expect(403);
      await patch(`/templates/${TEMPLATE}`, { active: false }, teacher).expect(403);
      // Reading them is the teacher's, to know what to tick.
      tx()['instructionTemplate']!['findMany']!.mockResolvedValue([template()]);
      await get('/templates', teacher).expect(200);
    });

    it('lets every administrator profile read, those that write Drift write, and the läsare not', async () => {
      tx()['instructionTemplate']!['create']!.mockResolvedValue(template());
      for (const adminProfile of ['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION', 'LASARE']) {
        const as = asUser({ adminProfile: adminProfile as never });
        for (const path of ['/settings', '/templates', '/groups', '/instructors', '/consent-lists']) await get(path, as).expect(200);
      }
      for (const adminProfile of ['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION']) {
        await post('/templates', { title: 'Cirkelsågen' }, asUser({ adminProfile: adminProfile as never })).expect(201);
      }
    });

    it('answers the läsare’s every write with 403 AREA_NOT_YOURS, naming Drift, and writes nothing', async () => {
      for (const [name, verb, path, body] of ROUTES) {
        if (verb === 'get') continue;
        const res = await send(verb, path, body, lasare);
        expect([name, res.status, res.body.code]).toEqual([name, 403, 'AREA_NOT_YOURS']);
        expect(res.body.detail).toContain('Drift');
      }
      expect(harness.prisma.withRls).not.toHaveBeenCalled();
    });

    it('lets a läsare read a list and a pupil’s card, with nothing to write', async () => {
      tx()['consentList']!['findFirst']!.mockResolvedValue(list());
      const res = await get(`/consent-lists/${LIST}`, lasare).expect(200);
      expect(res.body.canClose).toBe(false);
      expect(res.body.rows).toEqual([expect.objectContaining({ studentId: PUPIL, canWrite: false })]);
      await get(`/students/${PUPIL}`, lasare).expect(200);
    });
  });

  describe('the templates', () => {
    it('lists the active templates with the name of their subject, and records no read', async () => {
      tx()['instructionTemplate']!['findMany']!.mockResolvedValue([template({ subjectId: 's-1' })]);
      tx()['subject']!['findMany']!.mockResolvedValue([{ id: 's-1', name: 'Slöjd' }]);
      const res = await get('/templates').expect(200);
      expect(res.body).toEqual([{ id: TEMPLATE, subjectId: 's-1', subjectName: 'Slöjd', title: 'Cirkelsågen', description: null, active: true }]);
      expect(tx()['instructionTemplate']!['findMany']).toHaveBeenCalledWith(expect.objectContaining({ where: { schoolId: SCHOOL, active: true } }));
      expect(tx().$executeRaw).not.toHaveBeenCalled();
    });

    it('lists the retired ones too when asked, and only for exactly includeRetired=true', async () => {
      await get('/templates?includeRetired=true').expect(200);
      expect(tx()['instructionTemplate']!['findMany']).toHaveBeenLastCalledWith(expect.objectContaining({ where: { schoolId: SCHOOL } }));
      await get('/templates?includeRetired=false').expect(200);
      expect(tx()['instructionTemplate']!['findMany']).toHaveBeenLastCalledWith(expect.objectContaining({ where: { schoolId: SCHOOL, active: true } }));
      await get('/templates?includeRetired=1').expect(200);
      expect(tx()['instructionTemplate']!['findMany']).toHaveBeenLastCalledWith(expect.objectContaining({ where: { schoolId: SCHOOL, active: true } }));
    });

    it('refuses a query parameter it does not know', async () => {
      await get('/templates?retired=true').expect(400);
      await get('/consent-lists?closed=true').expect(400);
    });

    it('writes a template with a trimmed title, and a blank description is none', async () => {
      tx()['instructionTemplate']!['create']!.mockResolvedValue(template());
      const res = await post('/templates', { title: '  Cirkelsågen  ', description: '   ' }).expect(201);
      expect(res.body).toMatchObject({ id: TEMPLATE, title: 'Cirkelsågen', active: true });
      expect(tx()['instructionTemplate']!['create']).toHaveBeenCalledWith({ data: { schoolId: SCHOOL, title: 'Cirkelsågen', description: null, subjectId: null } });
    });

    it('writes the description and the subject when they are given', async () => {
      tx()['instructionTemplate']!['create']!.mockResolvedValue(template({ description: 'Skydd och nödstopp', subjectId: GROUP }));
      await post('/templates', { title: 'Cirkelsågen', description: ' Skydd och nödstopp ', subjectId: GROUP }).expect(201);
      expect(tx()['instructionTemplate']!['create']).toHaveBeenCalledWith({ data: { schoolId: SCHOOL, title: 'Cirkelsågen', description: 'Skydd och nödstopp', subjectId: GROUP } });
    });

    it.each([
      ['no title', {}],
      ['a blank title', { title: '   ' }],
      ['a title of 121 characters', { title: 't'.repeat(121) }],
      ['a title that is not text', { title: 12 }],
      ['a description of 2001 characters', { title: 'T', description: 'd'.repeat(2001) }],
      ['a subject that is not an id', { title: 'T', subjectId: 'slöjd' }],
      ['a field it does not know', { title: 'T', active: false }],
    ])('refuses %s with a 400 before the database', async (_label, body) => {
      await post('/templates', body).expect(400);
      expect(tx()['instructionTemplate']!['create']).not.toHaveBeenCalled();
    });

    it('takes a title of 120 characters', async () => {
      tx()['instructionTemplate']!['create']!.mockResolvedValue(template());
      await post('/templates', { title: 't'.repeat(120) }).expect(201);
    });

    it('answers a moment the subject already has with 409 CHECKLIST_TEMPLATE_EXISTS, and an unknown subject with 422', async () => {
      tx()['instructionTemplate']!['create']!.mockRejectedValue(known('P2002'));
      const exists = await post('/templates', { title: 'Cirkelsågen' }).expect(409);
      expect(exists.body.code).toBe('CHECKLIST_TEMPLATE_EXISTS');
      tx()['instructionTemplate']!['create']!.mockRejectedValue(known('P2003'));
      const unknown = await post('/templates', { title: 'Cirkelsågen', subjectId: GROUP }).expect(422);
      expect(unknown.body.code).toBe('CHECKLIST_UNKNOWN_SUBJECT');
    });

    it('saves what is named, and null clears the description and the subject', async () => {
      tx()['instructionTemplate']!['update']!.mockResolvedValue(template({ active: false }));
      const res = await patch(`/templates/${TEMPLATE}`, { active: false }).expect(200);
      expect(res.body).toMatchObject({ id: TEMPLATE, active: false });
      expect(tx()['instructionTemplate']!['update']).toHaveBeenLastCalledWith({ where: { id_schoolId: { id: TEMPLATE, schoolId: SCHOOL } }, data: { active: false } });
      await patch(`/templates/${TEMPLATE}`, { description: null, subjectId: null, title: ' Ny ' }).expect(200);
      expect(tx()['instructionTemplate']!['update']).toHaveBeenLastCalledWith(expect.objectContaining({ data: { title: 'Ny', description: null, subjectId: null } }));
      await patch(`/templates/${TEMPLATE}`, {}).expect(200);
      expect(tx()['instructionTemplate']!['update']).toHaveBeenLastCalledWith(expect.objectContaining({ data: {} }));
    });

    it.each([
      ['an empty title', { title: '' }],
      ['a title of 121 characters', { title: 't'.repeat(121) }],
      ['a description of 2001 characters', { description: 'd'.repeat(2001) }],
      ['a subject that is not an id', { subjectId: 'slöjd' }],
      ['an active that is not a boolean', { active: 'yes' }],
      ['a field it does not know', { schoolId: SCHOOL }],
    ])('refuses a save with %s with a 400', async (_label, body) => {
      await patch(`/templates/${TEMPLATE}`, body).expect(400);
      expect(tx()['instructionTemplate']!['update']).not.toHaveBeenCalled();
    });

    it('refuses a template id that is not a uuid', async () => {
      await patch('/templates/not-an-id', { active: false }).expect(400);
      await get(`/templates/not-an-id/roster?groupId=${GROUP}`).expect(400);
    });

    it('answers 404 for a template that is not the school’s', async () => {
      tx()['instructionTemplate']!['update']!.mockRejectedValue(known('P2025'));
      const res = await patch(`/templates/${TEMPLATE}`, { active: false }).expect(404);
      expect(res.body.code).toBe('CHECKLIST_NOT_FOUND');
    });
  });

  describe('the groups and the staff', () => {
    it('lists the groups of the active year for an administrator, who may tick them all', async () => {
      tx()['studentGroup']!['findMany']!.mockResolvedValue([{ id: GROUP, name: '7A', kind: 'CLASS' }]);
      const res = await get('/groups').expect(200);
      expect(res.body).toEqual([{ id: GROUP, name: '7A', kind: 'CLASS', subjects: [], canTick: true, canMakeList: true }]);
    });

    it('lists a teacher’s groups with the subjects they teach there', async () => {
      defaults({ 'app.ack_mentee_ids()': [{ ids: [] }] });
      tx()['masterLesson']!['findMany']!.mockResolvedValue([{ subject: { name: 'Slöjd' }, studentGroup: { id: GROUP, name: 'Slöjd 7', kind: 'TEACHING_GROUP' }, extraGroups: [] }]);
      const res = await get('/groups', teacher).expect(200);
      expect(res.body).toEqual([{ id: GROUP, name: 'Slöjd 7', kind: 'TEACHING_GROUP', subjects: ['Slöjd'], canTick: true, canMakeList: false }]);
    });

    it('lists the staff who can have given an instruction', async () => {
      const res = await get('/instructors', teacher).expect(200);
      expect(res.body).toEqual([{ id: rector.id, name: 'Ada Rektor' }]);
    });

    it('says whether the school has Kvittens on', async () => {
      expect((await get('/settings', teacher).expect(200)).body).toEqual({ kvittens: true });
      defaults({ 'app.ack_enabled()': [{ on: false }] });
      expect((await get('/settings').expect(200)).body).toEqual({ kvittens: false });
    });
  });

  describe('a group’s roster', () => {
    function ready() {
      tx()['instructionTemplate']!['findFirst']!.mockResolvedValue(template());
      tx()['studentGroup']!['findFirst']!.mockResolvedValue({ id: CLASS, name: '7A', kind: 'CLASS' });
    }

    it('answers the pupils and what they have had, and records the read', async () => {
      ready();
      tx()['instructionProof']!['findMany']!.mockResolvedValue([
        {
          id: PROOF,
          schoolId: SCHOOL,
          templateId: TEMPLATE,
          studentId: PUPIL,
          instructedOn: new Date('2026-11-03T00:00:00Z'),
          instructorId: rector.id,
          recordedById: rector.id,
          recordedAt: new Date('2026-11-03T09:15:00Z'),
          note: null,
          voidedAt: null,
        },
      ]);
      const res = await get(`/templates/${TEMPLATE}/roster?groupId=${CLASS}`, teacher).expect(200);
      expect(res.body).toMatchObject({
        template: { id: TEMPLATE, title: 'Cirkelsågen' },
        group: { id: CLASS, name: '7A', kind: 'CLASS' },
        done: 1,
        pupils: 1,
      });
      expect(res.body.rows).toEqual([
        {
          studentId: PUPIL,
          name: 'Anna Andersson',
          className: '7A',
          canTick: true,
          proofs: [
            {
              id: PROOF,
              instructedOn: '2026-11-03',
              instructorId: rector.id,
              instructorName: 'Ada Rektor',
              recordedByName: 'Ada Rektor',
              recordedAt: '2026-11-03T09:15:00.000Z',
              note: null,
              // The teacher is the one who wrote it (the test login's user id is the rector's).
              canVoid: true,
            },
          ],
        },
      ]);
      expect(tx().$executeRaw).toHaveBeenCalledTimes(1);
      expect((tx().$executeRaw.mock.calls[0]![0] as { values: unknown[] }).values).toEqual(['PEOPLE', null, [PUPIL]]);
    });

    it('lets a teacher look at a pupil they do not teach, and not tick them', async () => {
      ready();
      defaults({ 'app.checklist_taught_ids()': [{ ids: [] }] });
      const res = await get(`/templates/${TEMPLATE}/roster?groupId=${CLASS}`, teacher).expect(200);
      expect(res.body.rows).toEqual([expect.objectContaining({ studentId: PUPIL, canTick: false })]);
    });

    it('says per tick whether the caller may void it: the writer, or an administrator who writes Drift', async () => {
      ready();
      const tick = (id: string, recordedById: string) => ({
        id,
        schoolId: SCHOOL,
        templateId: TEMPLATE,
        studentId: PUPIL,
        instructedOn: new Date('2026-11-03T00:00:00Z'),
        instructorId: null,
        recordedById,
        recordedAt: new Date('2026-11-03T09:15:00Z'),
        note: null,
        voidedAt: null,
      });
      // The test logins' user id is the rector's: the teacher wrote the first tick and not the second.
      tx()['instructionProof']!['findMany']!.mockResolvedValue([tick(PROOF, rector.id), tick(LIST, OTHER)]);
      const canVoid = async (as: string) =>
        (await get(`/templates/${TEMPLATE}/roster?groupId=${CLASS}`, as).expect(200)).body.rows[0].proofs.map((view: { canVoid: boolean }) => view.canVoid);
      expect(await canVoid(teacher)).toEqual([true, false]);
      expect(await canVoid(admin)).toEqual([true, true]);
      expect(await canVoid(lasare)).toEqual([false, false]);
    });

    it('answers 404 for a template or a group that is not the school’s', async () => {
      ready();
      tx()['instructionTemplate']!['findFirst']!.mockResolvedValue(null);
      const res = await get(`/templates/${TEMPLATE}/roster?groupId=${GROUP}`).expect(404);
      expect(res.body.code).toBe('CHECKLIST_NOT_FOUND');
      expect(tx().$executeRaw).not.toHaveBeenCalled();
    });

    it.each([['no group', ''], ['a group that is not an id', '?groupId=7A'], ['an empty group', '?groupId='], ['a parameter it does not know', `?groupId=${GROUP}&pupil=${PUPIL}`]])(
      'refuses %s with a 400',
      async (_label, query) => {
        ready();
        await get(`/templates/${TEMPLATE}/roster${query}`).expect(400);
        expect(harness.prisma.withRls).not.toHaveBeenCalled();
      },
    );
  });

  describe('the rosters and the lists for paper', () => {
    const askedAboutMarks = () => tx().$queryRaw.mock.calls.filter((call) => String((call[0] as string[]).join?.('?') ?? '').includes('app.checklist_protected_ids'));

    function ready() {
      tx()['instructionTemplate']!['findFirst']!.mockResolvedValue(template());
      tx()['studentGroup']!['findFirst']!.mockResolvedValue({ id: CLASS, name: '7A', kind: 'CLASS' });
      tx()['consentList']!['findFirst']!.mockResolvedValue(list());
    }

    describe('GET /templates/:id/roster/print', () => {
      const url = `/templates/${TEMPLATE}/roster/print?groupId=${CLASS}`;

      it.each([
        ['an administrator', admin],
        ['a teacher', teacher],
        ['a läsare', lasare],
      ])('answers %s the roster, with the pupil kept, nobody held out, and the read recorded', async (_who, as) => {
        ready();
        const res = await get(url, as).expect(200);
        expect(res.body).toMatchObject({ template: { id: TEMPLATE }, group: { id: CLASS }, done: 0, pupils: 1, heldOut: 0 });
        expect(res.body.rows).toEqual([expect.objectContaining({ studentId: PUPIL, name: 'Anna Andersson' })]);
        expect(askedAboutMarks()).toHaveLength(1);
        expect(askedAboutMarks()[0]!.slice(1)).toEqual([[PUPIL]]);
        expect((tx().$executeRaw.mock.calls[0]![0] as { values: unknown[] }).values).toEqual(['PEOPLE', null, [PUPIL]]);
      });

      it.each([
        ['an administrator', admin],
        ['a teacher', teacher],
      ])('holds a marked pupil out of %s’s sheet, counts them, and records no read of them', async (_who, as) => {
        ready();
        defaults({ 'app.checklist_protected_ids': [{ ids: [PUPIL] }] });
        const res = await get(url, as).expect(200);
        expect(res.body).toMatchObject({ rows: [], done: 0, pupils: 0, heldOut: 1 });
        expect(JSON.stringify(res.body)).not.toContain('Andersson');
        expect(JSON.stringify(res.body)).not.toContain(PUPIL);
        expect(tx().$executeRaw).not.toHaveBeenCalled();
      });

      it('is the screen’s roster that shows them: the same pupil is named there, and the marks are not asked about', async () => {
        ready();
        defaults({ 'app.checklist_protected_ids': [{ ids: [PUPIL] }] });
        const res = await get(`/templates/${TEMPLATE}/roster?groupId=${CLASS}`, teacher).expect(200);
        expect(res.body.rows).toEqual([expect.objectContaining({ studentId: PUPIL })]);
        expect(res.body.heldOut).toBe(0);
        expect(askedAboutMarks()).toHaveLength(0);
      });

      it('answers 404 for a template or a group that is not the school’s', async () => {
        ready();
        tx()['studentGroup']!['findFirst']!.mockResolvedValue(null);
        expect((await get(url).expect(404)).body.code).toBe('CHECKLIST_NOT_FOUND');
      });

      it.each([
        ['no group', `/templates/${TEMPLATE}/roster/print`],
        ['a group that is not an id', `/templates/${TEMPLATE}/roster/print?groupId=7A`],
        ['an empty group', `/templates/${TEMPLATE}/roster/print?groupId=`],
        ['a template that is not an id', `/templates/not-an-id/roster/print?groupId=${CLASS}`],
        ['a parameter it does not know', `/templates/${TEMPLATE}/roster/print?groupId=${CLASS}&pupil=${PUPIL}`],
      ])('refuses %s with a 400 before the database', async (_label, path) => {
        ready();
        await get(path).expect(400);
        await get(path, teacher).expect(400);
        expect(harness.prisma.withRls).not.toHaveBeenCalled();
      });

      it.each(['STUDENT', 'GUARDIAN'])('refuses %s', async (role) => {
        await get(url, asUser({ role: role as never })).expect(403);
        expect(harness.prisma.withRls).not.toHaveBeenCalled();
      });

      it('refuses a visitor with no token', async () => {
        await http().get(`${BASE}${url}`).expect(401);
      });
    });

    describe('GET /consent-lists/:id/print', () => {
      const url = `/consent-lists/${LIST}/print`;

      it.each([
        ['an administrator', admin],
        ['a teacher', teacher],
        ['a läsare', lasare],
      ])('answers %s the list, with the pupil kept, nobody held out, and the read recorded', async (_who, as) => {
        ready();
        const res = await get(url, as).expect(200);
        expect(res.body).toMatchObject({ list: { id: LIST, counts: { pupils: 1, missing: 1 } }, kvittens: true, heldOut: 0 });
        expect(res.body.rows).toEqual([expect.objectContaining({ studentId: PUPIL, name: 'Anna Andersson', state: 'MISSING' })]);
        expect(askedAboutMarks()[0]!.slice(1)).toEqual([[PUPIL]]);
        expect((tx().$executeRaw.mock.calls[0]![0] as { values: unknown[] }).values).toEqual(['PEOPLE', null, [PUPIL]]);
      });

      it.each([
        ['an administrator', admin],
        ['a teacher', teacher],
      ])('holds a marked pupil out of %s’s sheet and of the counts, counts them, and records no read', async (_who, as) => {
        ready();
        defaults({ 'app.checklist_protected_ids': [{ ids: [PUPIL] }] });
        const res = await get(url, as).expect(200);
        expect(res.body.rows).toEqual([]);
        expect(res.body.list.counts).toEqual({ pupils: 0, granted: 0, declined: 0, withdrawn: 0, asked: 0, missing: 0 });
        expect(res.body.heldOut).toBe(1);
        expect(res.body.list).toMatchObject({ id: LIST, title: 'Fotografering' });
        expect(JSON.stringify(res.body)).not.toContain('Andersson');
        expect(tx().$executeRaw).not.toHaveBeenCalled();
      });

      it('is the screen’s list that shows them: the same pupil is named there, and the marks are not asked about', async () => {
        ready();
        defaults({ 'app.checklist_protected_ids': [{ ids: [PUPIL] }] });
        const res = await get(`/consent-lists/${LIST}`, teacher).expect(200);
        expect(res.body.rows).toEqual([expect.objectContaining({ studentId: PUPIL })]);
        expect(res.body.heldOut).toBe(0);
        expect(askedAboutMarks()).toHaveLength(0);
      });

      it('answers 404 for a list that is not the school’s, and 400 for an id that is not a uuid', async () => {
        expect((await get(url).expect(404)).body.code).toBe('CHECKLIST_NOT_FOUND');
        await get('/consent-lists/not-an-id/print').expect(400);
      });

      it.each(['STUDENT', 'GUARDIAN'])('refuses %s', async (role) => {
        await get(url, asUser({ role: role as never })).expect(403);
        expect(harness.prisma.withRls).not.toHaveBeenCalled();
      });

      it('refuses a visitor with no token', async () => {
        await http().get(`${BASE}${url}`).expect(401);
      });
    });
  });

  describe('ticking', () => {
    const body = { templateId: TEMPLATE, studentIds: [PUPIL] };

    function ready() {
      tx()['instructionTemplate']!['findFirst']!.mockResolvedValue(template());
      tx()['instructionProof']!['createMany']!.mockImplementation(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
    }

    it('writes a proof for the pupil, today, and answers how many were new', async () => {
      ready();
      const res = await post('/proofs', body, teacher).expect(201);
      expect(res.body).toEqual({ written: 1, already: 0 });
      const { data, skipDuplicates } = tx()['instructionProof']!['createMany']!.mock.calls[0]![0];
      expect(skipDuplicates).toBe(true);
      expect(data).toEqual([expect.objectContaining({ schoolId: SCHOOL, templateId: TEMPLATE, studentId: PUPIL, instructorId: null, note: null })]);
      expect(data[0].instructedOn).toBeInstanceOf(Date);
    });

    it('takes the day, who gave the instruction and a note', async () => {
      ready();
      await post('/proofs', { ...body, instructedOn: '2026-10-01', instructorId: rector.id, note: '  Grupp 2  ' }, teacher).expect(201);
      expect(tx()['instructionProof']!['createMany']!.mock.calls[0]![0].data[0]).toMatchObject({
        instructedOn: new Date('2026-10-01T00:00:00.000Z'),
        instructorId: rector.id,
        note: 'Grupp 2',
      });
    });

    it('says a pupil who already has the day’s proof was already', async () => {
      ready();
      tx()['instructionProof']!['findMany']!.mockResolvedValue([{ studentId: PUPIL }]);
      const res = await post('/proofs', body).expect(201);
      expect(res.body).toEqual({ written: 0, already: 1 });
      expect(tx()['instructionProof']!['createMany']).not.toHaveBeenCalled();
    });

    it('refuses a teacher a pupil they do not teach with 403 CHECKLIST_NOT_YOUR_PUPIL', async () => {
      ready();
      defaults({ 'app.checklist_taught_ids()': [{ ids: [] }] });
      const res = await post('/proofs', body, teacher).expect(403);
      expect(res.body.code).toBe('CHECKLIST_NOT_YOUR_PUPIL');
      expect(tx()['instructionProof']!['createMany']).not.toHaveBeenCalled();
    });

    it('lets an administrator tick any pupil of the school', async () => {
      ready();
      defaults({ 'app.checklist_taught_ids()': [{ ids: [] }] });
      await post('/proofs', body).expect(201);
    });

    it('answers 422 for a pupil who is not an active pupil of the school, a day that has not come and a day that does not exist', async () => {
      ready();
      tx()['user']!['findMany']!.mockResolvedValue([]);
      expect((await post('/proofs', body).expect(422)).body.code).toBe('CHECKLIST_UNKNOWN_PUPIL');
      users([pupil]);
      const future = await post('/proofs', { ...body, instructedOn: '2999-01-01' }).expect(422);
      expect(future.body.code).toBe('CHECKLIST_DATE_IN_THE_FUTURE');
      const none = await post('/proofs', { ...body, instructedOn: '2026-02-30' }).expect(422);
      expect(none.body).toMatchObject({ code: 'CHECKLIST_DATE_INVALID', detail: 'Datumet finns inte.' });
      expect(tx()['instructionProof']!['createMany']).not.toHaveBeenCalled();
    });

    it('answers 409 for a template that is retired, 404 for one that is not the school’s', async () => {
      tx()['instructionTemplate']!['findFirst']!.mockResolvedValue(template({ active: false }));
      expect((await post('/proofs', body).expect(409)).body.code).toBe('CHECKLIST_TEMPLATE_RETIRED');
      tx()['instructionTemplate']!['findFirst']!.mockResolvedValue(null);
      expect((await post('/proofs', body).expect(404)).body.code).toBe('CHECKLIST_NOT_FOUND');
    });

    it.each([
      ['CL422', 'CHECKLIST_INSTRUCTOR_IS_NOT_STAFF', 422, 'CHECKLIST_INSTRUCTOR_IS_NOT_STAFF'],
      ['CL409', 'CHECKLIST_TEMPLATE_RETIRED', 409, 'CHECKLIST_TEMPLATE_RETIRED'],
      ['CL403', 'CHECKLIST_NOT_STAFF', 403, 'CHECKLIST_NOT_STAFF'],
    ])('answers the database’s %s (%s) as %i %s', async (state, name, status, code) => {
      ready();
      tx()['instructionProof']!['createMany']!.mockRejectedValue(refusal(state, name));
      const res = await post('/proofs', { ...body, instructorId: rector.id }).expect(status);
      expect(res.body.code).toBe(code);
    });

    it.each([
      ['no template', { studentIds: [PUPIL] }],
      ['a template that is not an id', { ...body, templateId: 'cirkelsagen' }],
      ['no pupils', { templateId: TEMPLATE }],
      ['an empty list of pupils', { ...body, studentIds: [] }],
      ['pupils that are not a list', { ...body, studentIds: PUPIL }],
      ['a pupil that is not an id', { ...body, studentIds: ['anna'] }],
      ['301 pupils', { ...body, studentIds: Array.from({ length: 301 }, () => PUPIL) }],
      ['a day with the time on it', { ...body, instructedOn: '2026-11-03T10:00:00Z' }],
      ['a day written as 3/11', { ...body, instructedOn: '3/11/2026' }],
      ['a day with one digit', { ...body, instructedOn: '2026-1-1' }],
      ['an instructor that is not an id', { ...body, instructorId: 'ada' }],
      ['a note of 501 characters', { ...body, note: 'n'.repeat(501) }],
      ['a note that is not text', { ...body, note: 7 }],
      ['a field it does not know', { ...body, voided: true }],
    ])('refuses %s with a 400 before the database', async (_label, payload) => {
      await post('/proofs', payload, teacher).expect(400);
      expect(harness.prisma.withRls).not.toHaveBeenCalled();
    });

    it('takes 300 pupils and a note of 500 characters', async () => {
      ready();
      const ids = Array.from({ length: 300 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
      tx()['user']!['findMany']!.mockResolvedValue(ids.map((id) => ({ id })));
      const res = await post('/proofs', { templateId: TEMPLATE, studentIds: ids, note: 'n'.repeat(500) }).expect(201);
      expect(res.body).toEqual({ written: 300, already: 0 });
    });
  });

  describe('voiding', () => {
    const void_ = (id: string, body: unknown, as = teacher) => post(`/proofs/${id}/void`, body, as);

    it('voids the tick with the reason, and answers the time with 200', async () => {
      raw({ 'app.checklist_void_proof': [{ at: new Date('2026-11-07T10:00:00Z') }] });
      const res = await void_(PROOF, { reason: '  Fel elev  ' }).expect(200);
      expect(res.body).toEqual({ voidedAt: '2026-11-07T10:00:00.000Z' });
      expect(tx().$queryRaw.mock.calls[0]!.slice(1)).toEqual([PROOF, 'Fel elev']);
    });

    it.each([
      ['CL403', 403, 'CHECKLIST_NOT_STAFF'],
      ['CL404', 404, 'CHECKLIST_NOT_FOUND'],
      ['CL422', 422, 'CHECKLIST_REASON_NEEDED'],
    ])('answers the database’s %s as %i %s', async (state, status, code) => {
      tx().$queryRaw.mockRejectedValue(refusal(state, code));
      const res = await void_(PROOF, { reason: 'Fel elev' }).expect(status);
      expect(res.body.code).toBe(code);
    });

    it.each([
      ['no reason', {}],
      ['an empty reason', { reason: '' }],
      ['a blank reason', { reason: '   ' }],
      ['a reason of 301 characters', { reason: 'r'.repeat(301) }],
      ['a reason that is not text', { reason: 4 }],
      ['a field it does not know', { reason: 'Fel elev', studentId: PUPIL }],
    ])('refuses %s with a 400 before the database', async (_label, payload) => {
      await void_(PROOF, payload).expect(400);
      expect(tx().$queryRaw).not.toHaveBeenCalled();
    });

    it('refuses a proof id that is not a uuid', async () => {
      await void_('not-an-id', { reason: 'Fel elev' }).expect(400);
    });
  });

  describe('the consent lists', () => {
    it('lists the open lists with the counts, and records no read', async () => {
      tx()['consentList']!['findMany']!.mockResolvedValue([list()]);
      const res = await get('/consent-lists', teacher).expect(200);
      expect(res.body).toEqual([
        {
          id: LIST,
          title: 'Fotografering',
          classId: CLASS,
          className: '7A',
          createdAt: '2026-10-01T08:00:00.000Z',
          createdByName: 'Ada Rektor',
          closedAt: null,
          counts: { pupils: 1, granted: 0, declined: 0, withdrawn: 0, asked: 0, missing: 1 },
        },
      ]);
      expect(tx()['consentList']!['findMany']).toHaveBeenCalledWith(expect.objectContaining({ where: { schoolId: SCHOOL, closedAt: null } }));
      expect(tx().$executeRaw).not.toHaveBeenCalled();
    });

    it('narrows to a class and takes the closed lists too when asked to', async () => {
      await get(`/consent-lists?classId=${CLASS}&includeClosed=true`).expect(200);
      expect(tx()['consentList']!['findMany']).toHaveBeenCalledWith(expect.objectContaining({ where: { schoolId: SCHOOL, studentGroupId: CLASS } }));
      await get('/consent-lists?classId=7A').expect(400);
    });

    it('makes a list for a class, with a trimmed title and text', async () => {
      tx()['studentGroup']!['findFirst']!.mockResolvedValue({ id: CLASS });
      tx()['consentList']!['create']!.mockResolvedValue(list());
      const res = await post('/consent-lists', { classId: CLASS, title: '  Fotografering  ', body: '  Text  ' }).expect(201);
      expect(res.body).toMatchObject({ id: LIST, title: 'Fotografering', classId: CLASS, counts: { pupils: 1, missing: 1 } });
      expect(tx()['consentList']!['create']).toHaveBeenCalledWith({ data: { schoolId: SCHOOL, studentGroupId: CLASS, title: 'Fotografering', body: 'Text' } });
    });

    it('lets a teacher make a list for a class they have a mentee in', async () => {
      tx()['studentGroup']!['findFirst']!.mockResolvedValue({ id: CLASS });
      tx()['consentList']!['create']!.mockResolvedValue(list());
      await post('/consent-lists', { classId: CLASS, title: 'Fotografering', body: 'Text' }, teacher).expect(201);
    });

    it('answers a teacher 403 CONSENT_NOT_YOUR_CLASS for a class they have no mentee in, and an administrator is asked no such thing', async () => {
      tx()['studentGroup']!['findFirst']!.mockResolvedValue({ id: CLASS });
      tx()['consentList']!['create']!.mockResolvedValue(list());
      defaults({ 'app.checklist_mentee_class_ids': [{ ids: [] }] });
      const refused = await post('/consent-lists', { classId: CLASS, title: 'Fotografering', body: 'Text' }, teacher).expect(403);
      expect(refused.body.code).toBe('CONSENT_NOT_YOUR_CLASS');
      expect(tx()['consentList']!['create']).not.toHaveBeenCalled();
      await post('/consent-lists', { classId: CLASS, title: 'Fotografering', body: 'Text' }, admin).expect(201);
      expect(tx()['consentList']!['create']).toHaveBeenCalledTimes(1);
    });

    it('answers 422 CONSENT_NOT_A_CLASS for a group that is not a class, and 409 CONSENT_LIST_EXISTS for a second open list of the name', async () => {
      const res = await post('/consent-lists', { classId: CLASS, title: 'Fotografering', body: 'Text' }).expect(422);
      expect(res.body.code).toBe('CONSENT_NOT_A_CLASS');
      tx()['studentGroup']!['findFirst']!.mockResolvedValue({ id: CLASS });
      tx()['consentList']!['create']!.mockRejectedValue(known('P2002'));
      const exists = await post('/consent-lists', { classId: CLASS, title: 'Fotografering', body: 'Text' }).expect(409);
      expect(exists.body.code).toBe('CONSENT_LIST_EXISTS');
    });

    it.each([
      ['no class', { title: 'T', body: 'B' }],
      ['a class that is not an id', { classId: '7A', title: 'T', body: 'B' }],
      ['no title', { classId: CLASS, body: 'B' }],
      ['a blank title', { classId: CLASS, title: '   ', body: 'B' }],
      ['a title of 121 characters', { classId: CLASS, title: 't'.repeat(121), body: 'B' }],
      ['no text', { classId: CLASS, title: 'T' }],
      ['a blank text', { classId: CLASS, title: 'T', body: '   ' }],
      ['a text of 1701 characters', { classId: CLASS, title: 'T', body: 'b'.repeat(1701) }],
      ['a field it does not know', { classId: CLASS, title: 'T', body: 'B', closedAt: '2026-01-01' }],
    ])('refuses %s with a 400 before the database', async (_label, payload) => {
      await post('/consent-lists', payload).expect(400);
      expect(harness.prisma.withRls).not.toHaveBeenCalled();
    });

    it('takes a text of 1700 characters, which with the footer fits Kvittens’ 2000', async () => {
      tx()['studentGroup']!['findFirst']!.mockResolvedValue({ id: CLASS });
      tx()['consentList']!['create']!.mockResolvedValue(list());
      await post('/consent-lists', { classId: CLASS, title: 'T', body: 'b'.repeat(1700) }).expect(201);
    });
  });

  describe('a list', () => {
    it('answers the pupils and where each stands, and records the read', async () => {
      tx()['consentList']!['findFirst']!.mockResolvedValue(list());
      tx()['consentEntry']!['findMany']!.mockResolvedValue([
        {
          id: 'e-1',
          schoolId: SCHOOL,
          listId: LIST,
          studentId: PUPIL,
          kind: 'GRANTED',
          source: 'REGISTERED',
          givenOn: new Date('2026-10-02T00:00:00Z'),
          givenBy: 'Mamma',
          note: null,
          ackRequestId: null,
          recordedById: rector.id,
          recordedAt: new Date('2026-10-02T08:00:00Z'),
        },
      ]);
      const res = await get(`/consent-lists/${LIST}`).expect(200);
      expect(res.body).toMatchObject({
        list: { id: LIST, title: 'Fotografering', body: 'Vi får fotografera i skolans kanaler.', counts: { pupils: 1, granted: 1 } },
        kvittens: true,
        canClose: true,
      });
      expect(res.body.rows).toEqual([
        expect.objectContaining({
          studentId: PUPIL,
          name: 'Anna Andersson',
          state: 'GRANTED',
          inClass: true,
          canWrite: true,
          ask: null,
          entry: expect.objectContaining({ id: 'e-1', kind: 'GRANTED', givenOn: '2026-10-02', givenBy: 'Mamma', recordedByName: 'Ada Rektor' }),
        }),
      ]);
      expect(tx().$executeRaw).toHaveBeenCalledTimes(1);
      expect((tx().$executeRaw.mock.calls[0]![0] as { values: unknown[] }).values).toEqual(['PEOPLE', null, [PUPIL]]);
    });

    it('says ASKED while a request waits for a guardian', async () => {
      // Made by somebody else, so that the teacher can not close it.
      tx()['consentList']!['findFirst']!.mockResolvedValue(list({ createdById: OTHER }));
      tx()['consentAsk']!['findMany']!.mockResolvedValue([{ ackRequestId: 'req-1', schoolId: SCHOOL, listId: LIST, createdAt: new Date('2026-10-05T10:00:00Z') }]);
      defaults({ 'app.ack_status': [{ request_id: 'req-1', student_id: PUPIL, asked: 2, acked: 1, waiting: 1, met: false }] });
      const res = await get(`/consent-lists/${LIST}`, teacher).expect(200);
      expect(res.body.canClose).toBe(false);
      expect(res.body.rows[0]).toMatchObject({ state: 'ASKED', ask: { askedAt: '2026-10-05T10:00:00.000Z', guardiansAsked: 2, guardiansWaiting: 1 } });
      expect(res.body.list.counts).toMatchObject({ asked: 1, missing: 0 });
    });

    it('answers 404 for a list that is not the school’s, and 400 for an id that is not a uuid', async () => {
      const res = await get(`/consent-lists/${LIST}`).expect(404);
      expect(res.body.code).toBe('CHECKLIST_NOT_FOUND');
      expect(tx().$executeRaw).not.toHaveBeenCalled();
      await get('/consent-lists/not-an-id').expect(400);
    });

    describe('writing answers', () => {
      const body = { studentIds: [PUPIL], kind: 'GRANTED' };

      beforeEach(() => {
        tx()['consentList']!['findFirst']!.mockResolvedValue(list());
      });

      it('writes an answer for each pupil, and answers how many', async () => {
        const res = await post(`/consent-lists/${LIST}/entries`, { ...body, givenBy: ' Mamma ', note: ' Ringde ', givenOn: '2026-10-15' }, teacher).expect(201);
        expect(res.body).toEqual({ written: 1 });
        expect(tx()['consentEntry']!['createMany']).toHaveBeenCalledWith({
          data: [{ schoolId: SCHOOL, listId: LIST, studentId: PUPIL, kind: 'GRANTED', givenOn: new Date('2026-10-15T00:00:00.000Z'), givenBy: 'Mamma', note: 'Ringde' }],
        });
      });

      it.each(['GRANTED', 'DECLINED', 'WITHDRAWN'])('takes the kind %s', async (kind) => {
        await post(`/consent-lists/${LIST}/entries`, { ...body, kind }).expect(201);
        expect(tx()['consentEntry']!['createMany']!.mock.calls[0]![0].data[0].kind).toBe(kind);
      });

      it('refuses a teacher a pupil they do not mentor with 403 CHECKLIST_NOT_YOUR_PUPIL', async () => {
        defaults({ 'app.ack_mentee_ids()': [{ ids: [] }] });
        const res = await post(`/consent-lists/${LIST}/entries`, body, teacher).expect(403);
        expect(res.body.code).toBe('CHECKLIST_NOT_YOUR_PUPIL');
        expect(tx()['consentEntry']!['createMany']).not.toHaveBeenCalled();
      });

      it('answers 409 CONSENT_LIST_CLOSED for a closed list, 404 for another school’s, 422 for a day that has not come', async () => {
        tx()['consentList']!['findFirst']!.mockResolvedValue(list({ closedAt: new Date('2026-10-20T12:00:00Z') }));
        expect((await post(`/consent-lists/${LIST}/entries`, body).expect(409)).body.code).toBe('CONSENT_LIST_CLOSED');
        tx()['consentList']!['findFirst']!.mockResolvedValue(null);
        expect((await post(`/consent-lists/${LIST}/entries`, body).expect(404)).body.code).toBe('CHECKLIST_NOT_FOUND');
        tx()['consentList']!['findFirst']!.mockResolvedValue(list());
        expect((await post(`/consent-lists/${LIST}/entries`, { ...body, givenOn: '2999-01-01' }).expect(422)).body.code).toBe('CHECKLIST_DATE_IN_THE_FUTURE');
        expect(tx()['consentEntry']!['createMany']).not.toHaveBeenCalled();
      });

      it('answers 422 for a pupil who is not an active pupil of the school', async () => {
        users([rector]);
        expect((await post(`/consent-lists/${LIST}/entries`, body).expect(422)).body.code).toBe('CHECKLIST_UNKNOWN_PUPIL');
      });

      it('answers the database’s refusal of the insert: a list closed meanwhile is 409', async () => {
        tx()['consentEntry']!['createMany']!.mockRejectedValue(refusal('CL409', 'CONSENT_LIST_CLOSED'));
        expect((await post(`/consent-lists/${LIST}/entries`, body).expect(409)).body.code).toBe('CONSENT_LIST_CLOSED');
      });

      it.each([
        ['no pupils', { kind: 'GRANTED' }],
        ['an empty list of pupils', { ...body, studentIds: [] }],
        ['a pupil that is not an id', { ...body, studentIds: ['anna'] }],
        ['301 pupils', { ...body, studentIds: Array.from({ length: 301 }, () => PUPIL) }],
        ['no kind', { studentIds: [PUPIL] }],
        ['a kind it does not know', { ...body, kind: 'MAYBE' }],
        ['a kind in lower case', { ...body, kind: 'granted' }],
        ['a day that is not a day', { ...body, givenOn: 'igår' }],
        ['a day with the time on it', { ...body, givenOn: '2026-10-15T00:00:00Z' }],
        ['who gave it in 121 characters', { ...body, givenBy: 'g'.repeat(121) }],
        ['a note of 301 characters', { ...body, note: 'n'.repeat(301) }],
        ['a field it does not know', { ...body, source: 'KVITTENS' }],
      ])('refuses %s with a 400 before the database', async (_label, payload) => {
        harness.prisma.withRls.mockClear();
        await post(`/consent-lists/${LIST}/entries`, payload).expect(400);
        expect(harness.prisma.withRls).not.toHaveBeenCalled();
      });

      it('takes 300 pupils', async () => {
        const ids = Array.from({ length: 300 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
        users(ids.map((id) => ({ ...pupil, id })));
        defaults({ 'app.ack_mentee_ids()': [{ ids }] });
        expect((await post(`/consent-lists/${LIST}/entries`, { ...body, studentIds: ids }, teacher).expect(201)).body).toEqual({ written: 300 });
      });
    });

    describe('asking the guardians', () => {
      beforeEach(() => {
        tx()['consentList']!['findFirst']!.mockResolvedValue(list());
        tx()['guardianStudent']!['findMany']!.mockResolvedValue([{ studentId: PUPIL, guardianId: GUARDIAN }]);
      });

      it('asks through Kvittens with the rule ALL, and links the request to the list in the same transaction', async () => {
        const res = await post(`/consent-lists/${LIST}/ask`, { studentIds: [PUPIL] }, teacher).expect(201);
        expect(res.body).toEqual({ requestId: expect.any(String), pupils: 1, guardians: 1, withoutGuardian: [] });
        const request = tx()['ackRequest']!['createMany']!.mock.calls[0]![0].data[0];
        expect(request).toMatchObject({
          id: res.body.requestId,
          schoolId: SCHOOL,
          title: 'Samtycke: Fotografering',
          rule: 'ALL',
        });
        expect(request.body).toMatch(/^Vi får fotografera i skolans kanaler\.\n\nGenom att bekräfta ger du ditt samtycke\./);
        expect(tx()['ackReceipt']!['createMany']).toHaveBeenCalledWith({ data: [{ requestId: res.body.requestId, schoolId: SCHOOL, studentId: PUPIL, guardianId: GUARDIAN }] });
        expect(tx()['consentAsk']!['createMany']).toHaveBeenCalledWith({ data: [{ ackRequestId: res.body.requestId, schoolId: SCHOOL, listId: LIST }] });
      });

      it('asks every pupil with no answer when it is not told which', async () => {
        const res = await post(`/consent-lists/${LIST}/ask`, {}).expect(201);
        expect(res.body).toMatchObject({ pupils: 1, guardians: 1 });
        expect(tx()['ackReceipt']!['createMany']!.mock.calls[0]![0].data).toEqual([expect.objectContaining({ studentId: PUPIL })]);
      });

      it('says which pupils have no guardian to ask', async () => {
        tx()['guardianStudent']!['findMany']!.mockResolvedValue([]);
        const res = await post(`/consent-lists/${LIST}/ask`, { studentIds: [PUPIL] }).expect(422);
        expect(res.body.code).toBe('ACK_NO_GUARDIANS');
        expect(tx()['consentAsk']!['createMany']).not.toHaveBeenCalled();
      });

      it('answers 409 ACK_DISABLED while the school has Kvittens off', async () => {
        defaults({ 'app.ack_enabled()': [{ on: false, enabled: false }] });
        const res = await post(`/consent-lists/${LIST}/ask`, {}).expect(409);
        expect(res.body.code).toBe('ACK_DISABLED');
        expect(tx()['ackRequest']!['createMany']).not.toHaveBeenCalled();
      });

      it('answers 422 CONSENT_NOBODY_TO_ASK when nobody lacks an answer, and 409 CONSENT_LIST_CLOSED for a closed list', async () => {
        users([rector]);
        expect((await post(`/consent-lists/${LIST}/ask`, {}).expect(422)).body.code).toBe('CONSENT_NOBODY_TO_ASK');
        tx()['consentList']!['findFirst']!.mockResolvedValue(list({ closedAt: new Date('2026-10-20T12:00:00Z') }));
        expect((await post(`/consent-lists/${LIST}/ask`, {}).expect(409)).body.code).toBe('CONSENT_LIST_CLOSED');
        expect(tx()['ackRequest']!['createMany']).not.toHaveBeenCalled();
      });

      it('refuses a teacher a pupil they do not mentor', async () => {
        defaults({ 'app.ack_mentee_ids()': [{ ids: [] }] });
        const res = await post(`/consent-lists/${LIST}/ask`, { studentIds: [PUPIL] }, teacher).expect(403);
        expect(res.body.code).toBe('CHECKLIST_NOT_YOUR_PUPIL');
      });

      it.each([
        ['KV429', 'ACK_TOO_MANY_REQUESTS'],
        ['KV428', 'ACK_TOO_MANY_RECIPIENTS'],
      ])('answers Kvittens’ limit %s as a 429 with its code, and links nothing', async (state, code) => {
        tx()['ackRequest']!['createMany']!.mockRejectedValue(refusal(state));
        const res = await post(`/consent-lists/${LIST}/ask`, { studentIds: [PUPIL] }).expect(429);
        expect(res.body.code).toBe(code);
        expect(tx()['consentAsk']!['createMany']).not.toHaveBeenCalled();
      });

      it('answers a list closed while the request was written as 409 CONSENT_LIST_CLOSED', async () => {
        tx()['consentAsk']!['createMany']!.mockRejectedValue(refusal('CL409', 'CONSENT_LIST_CLOSED'));
        const res = await post(`/consent-lists/${LIST}/ask`, { studentIds: [PUPIL] }).expect(409);
        expect(res.body.code).toBe('CONSENT_LIST_CLOSED');
      });

      it.each([
        ['an empty list of pupils', { studentIds: [] }],
        ['pupils that are not a list', { studentIds: PUPIL }],
        ['a pupil that is not an id', { studentIds: ['anna'] }],
        ['2001 pupils', { studentIds: Array.from({ length: 2001 }, () => PUPIL) }],
        ['a field it does not know', { rule: 'ANY' }],
        ['a title of its own', { title: 'Ett eget' }],
      ])('refuses %s with a 400 before the database', async (_label, payload) => {
        await post(`/consent-lists/${LIST}/ask`, payload).expect(400);
        expect(harness.prisma.withRls).not.toHaveBeenCalled();
      });
    });

    describe('closing', () => {
      it('closes the list and answers the time with 200', async () => {
        raw({ 'app.checklist_close_list': [{ at: new Date('2026-11-07T10:00:00Z') }] });
        const res = await post(`/consent-lists/${LIST}/close`, {}, teacher).expect(200);
        expect(res.body).toEqual({ closedAt: '2026-11-07T10:00:00.000Z' });
        expect(tx().$queryRaw.mock.calls[0]!.slice(1)).toEqual([LIST]);
      });

      it.each([
        ['CL403', 403, 'CHECKLIST_NOT_STAFF'],
        ['CL404', 404, 'CHECKLIST_NOT_FOUND'],
      ])('answers the database’s %s as %i %s', async (state, status, code) => {
        tx().$queryRaw.mockRejectedValue(refusal(state, code));
        const res = await post(`/consent-lists/${LIST}/close`, {}).expect(status);
        expect(res.body.code).toBe(code);
      });

      it('refuses an id that is not a uuid', async () => {
        await post('/consent-lists/not-an-id/close', {}).expect(400);
        expect(tx().$queryRaw).not.toHaveBeenCalled();
      });
    });
  });

  describe('a pupil’s card', () => {
    it('answers the pupil, every tick and where they stand on each list, and records the read', async () => {
      tx()['instructionProof']!['findMany']!.mockResolvedValue([
        {
          id: PROOF,
          schoolId: SCHOOL,
          templateId: TEMPLATE,
          studentId: PUPIL,
          instructedOn: new Date('2026-11-03T00:00:00Z'),
          instructorId: rector.id,
          recordedById: rector.id,
          recordedAt: new Date('2026-11-03T09:15:00Z'),
          note: null,
          voidedAt: new Date('2026-11-04T08:00:00Z'),
          voidedById: rector.id,
          voidReason: 'Fel elev',
        },
      ]);
      tx()['instructionTemplate']!['findMany']!.mockResolvedValue([template()]);
      tx()['consentList']!['findMany']!.mockResolvedValue([list()]);
      const res = await get(`/students/${PUPIL}`, teacher).expect(200);
      expect(res.body.student).toEqual({ id: PUPIL, name: 'Anna Andersson', className: '7A' });
      expect(res.body.proofs).toEqual([
        expect.objectContaining({ id: PROOF, templateTitle: 'Cirkelsågen', voidedAt: '2026-11-04T08:00:00.000Z', voidedByName: 'Ada Rektor', voidReason: 'Fel elev', canVoid: true }),
      ]);
      expect(res.body.consents).toEqual([{ listId: LIST, title: 'Fotografering', className: '7A', closed: false, state: 'MISSING', entry: null }]);
      expect((tx().$executeRaw.mock.calls[0]![0] as { values: unknown[] }).values).toEqual(['PEOPLE', null, [PUPIL]]);
    });

    it('answers 404 for a pupil a teacher can not see, and for one who is not a pupil of the school', async () => {
      defaults({ 'app.checklist_visible_ids()': [{ ids: [] }] });
      expect((await get(`/students/${PUPIL}`, teacher).expect(404)).body.code).toBe('CHECKLIST_NOT_FOUND');
      users([]);
      expect((await get(`/students/${PUPIL}`).expect(404)).body.code).toBe('CHECKLIST_NOT_FOUND');
      expect(tx().$executeRaw).not.toHaveBeenCalled();
    });

    it('refuses an id that is not a uuid', async () => {
      await get('/students/not-an-id').expect(400);
    });
  });
});
