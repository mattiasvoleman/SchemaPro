import { Prisma } from '@prisma/client';
import request from 'supertest';
import { asUser, createTestApp, type TestHarness } from './utils/test-app';

const ADMIN_PROFILES = ['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION', 'LASARE'];
/** The profiles that hold Planering (app.admin_profile_writes). */
const PLANNING = ['FULL', 'REKTOR', 'SCHEMALAGGARE'];
const NOT_PLANNING = ['EXPEDITION', 'LASARE'];
const ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-11-18T10:00:00.000Z');

const post = (key: string, field: string | null, label = key) => ({ key, label, field });
const template = { kind: 'requirements', name: 'Höstens tjänstefördelning', headerRow: 2, placements: [post('grupp', 'groupName', 'Grupp'), post('ped', 'teacherSignature', 'Ped'), post('anteckning', null)] };
const stored = (over: Record<string, unknown> = {}) => ({ id: ID, kind: 'requirements', name: 'Höstens tjänstefördelning', headerRow: 2, placements: template.placements, createdAt: NOW, updatedAt: NOW, ...over });

/**
 * A school's saved column mappings: who reaches the routes, what a request must be, and what reaches the client.
 * The mocks stand in for the database, so these hold the role and area gates, the validation and the shape of the
 * answers, and say nothing of row security; RLS sections 535-539 say who reads and writes which row. What the
 * mocks DO show is the one thing a service's own spec cannot: that a refusal's code and flat params survive the
 * global problem filter (problem-json-forwards-only-code-and-flat-params), which keeps nothing else.
 */
describe('/api/v1/import-templates (e2e)', () => {
  let harness: TestHarness;
  const http = () => request(harness.app.getHttpServer());
  const call = (verb: 'get' | 'post' | 'patch' | 'delete', path: string, as: string, body?: object) => {
    const sent = http()[verb](`/api/v1/import-templates${path}`).set('x-test-user', as);
    return body === undefined ? sent : sent.send(body);
  };
  const model = () => harness.tx['importMappingTemplate']!;

  beforeAll(async () => {
    harness = await createTestApp();
  });
  afterAll(async () => {
    await harness.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    model()['findMany']!.mockResolvedValue([stored()]);
    model()['count']!.mockResolvedValue(0);
    model()['create']!.mockResolvedValue(stored());
    model()['findUnique']!.mockResolvedValue({ kind: 'requirements' });
    model()['update']!.mockResolvedValue(stored({ name: 'Ny' }));
    model()['deleteMany']!.mockResolvedValue({ count: 1 });
  });

  describe('who reaches what', () => {
    it.each(['STUDENT', 'GUARDIAN', 'TEACHER'])('gives %s none of it, not even the read', async (role) => {
      const as = asUser({ role: role as never });
      await call('get', '', as).expect(403);
      await call('post', '', as, template).expect(403);
      await call('patch', `/${ID}`, as, { name: 'x' }).expect(403);
      await call('delete', `/${ID}`, as).expect(403);
      expect(model()['findMany']).not.toHaveBeenCalled();
      expect(model()['create']).not.toHaveBeenCalled();
    });

    it('refuses a request with no token', async () => {
      await http().get('/api/v1/import-templates').expect(401);
      await http().post('/api/v1/import-templates').send(template).expect(401);
      await http().patch(`/api/v1/import-templates/${ID}`).send({ name: 'x' }).expect(401);
      await http().delete(`/api/v1/import-templates/${ID}`).expect(401);
    });

    it('lets every administrator profile read the templates, the läsare and the expedition too', async () => {
      for (const adminProfile of ADMIN_PROFILES) {
        const answer = await call('get', '', asUser({ adminProfile: adminProfile as never })).expect(200);
        expect(answer.body).toEqual([
          { id: ID, kind: 'requirements', name: 'Höstens tjänstefördelning', headerRow: 2, placements: template.placements, createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() },
        ]);
      }
    });

    it('asks for the caller\'s school, narrowed to a kind when one is given, and refuses a kind that is none', async () => {
      await call('get', '?kind=rooms', asUser({})).expect(200);
      expect(model()['findMany']).toHaveBeenLastCalledWith(expect.objectContaining({ where: { schoolId: '33333333-3333-4333-8333-333333333333', kind: 'rooms' } }));
      await call('get', '?kind=untis', asUser({})).expect(400);
    });

    it('lets Planering make, change and remove a template, and nobody else, before anything is written', async () => {
      for (const adminProfile of PLANNING) {
        const as = asUser({ adminProfile: adminProfile as never });
        await call('post', '', as, template).expect(201);
        await call('patch', `/${ID}`, as, { name: 'Ny' }).expect(200);
        await call('delete', `/${ID}`, as).expect(204);
      }
      jest.clearAllMocks();
      for (const adminProfile of NOT_PLANNING) {
        const as = asUser({ adminProfile: adminProfile as never });
        const refused = await call('post', '', as, template).expect(403);
        expect(refused.body.code).toBe('AREA_NOT_YOURS');
        await call('patch', `/${ID}`, as, { name: 'Ny' }).expect(403);
        await call('delete', `/${ID}`, as).expect(403);
      }
      expect(model()['create']).not.toHaveBeenCalled();
      expect(model()['update']).not.toHaveBeenCalled();
      expect(model()['deleteMany']).not.toHaveBeenCalled();
    });
  });

  describe('what a request must be', () => {
    const admin = asUser({});

    it.each([
      ['no kind', { name: 'x', placements: [] }],
      ['a kind that is none', { kind: 'untis', name: 'x', placements: [] }],
      ['no name', { kind: 'rooms', placements: [] }],
      ['no posts', { kind: 'rooms', name: 'x' }],
      ['posts that are not a list', { kind: 'rooms', name: 'x', placements: { key: 'a' } }],
      ['more than 200 posts', { kind: 'rooms', name: 'x', placements: Array.from({ length: 201 }, (_, i) => post(`k${i}`, null)) }],
      ['a key with a capital', { kind: 'rooms', name: 'x', placements: [post('Namn', 'name')] }],
      ['a key with a space', { kind: 'rooms', name: 'x', placements: [post('två ord', 'name')] }],
      ['a post without a field', { kind: 'rooms', name: 'x', placements: [{ key: 'namn', label: 'Namn' }] }],
      ['a field that is not a name', { kind: 'rooms', name: 'x', placements: [post('namn', 'a field')] }],
      ['a header row of 21', { kind: 'rooms', name: 'x', headerRow: 21, placements: [] }],
      ['a header row of 0', { kind: 'rooms', name: 'x', headerRow: 0, placements: [] }],
      ['a name of 201 characters', { kind: 'rooms', name: 'x'.repeat(201), placements: [] }],
      ['a property the pipe does not know', { kind: 'rooms', name: 'x', placements: [], schoolId: 'a' }],
      ['a post with a property the pipe does not know', { kind: 'rooms', name: 'x', placements: [{ ...post('namn', 'name'), value: 'Anna' }] }],
    ])('refuses a template with %s with a 400, and writes nothing', async (_label, body) => {
      await call('post', '', admin, body).expect(400);
      expect(model()['create']).not.toHaveBeenCalled();
    });

    it('refuses an id that is no id, and a kind in an update, which a template never changes', async () => {
      await call('patch', '/inte-ett-id', admin, { name: 'x' }).expect(400);
      await call('delete', '/inte-ett-id', admin).expect(400);
      await call('patch', `/${ID}`, admin, { kind: 'rooms' }).expect(400);
      await call('patch', `/${ID}`, admin, { name: '' }).expect(400);
      expect(model()['update']).not.toHaveBeenCalled();
    });

    it('takes a template made for another school\'s id as its own: the school is the caller\'s and no body says otherwise', async () => {
      await call('post', '', admin, { kind: 'rooms', name: 'x', placements: [], schoolId: '55555555-5555-4555-8555-555555555555' }).expect(400);
      await call('post', '', admin, { kind: 'rooms', name: 'x', placements: [] }).expect(201);
      expect(model()['create']).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ schoolId: '33333333-3333-4333-8333-333333333333' }) }));
    });
  });

  describe('what reaches the client', () => {
    const admin = asUser({});

    it('puts the stored template in the answer to a create, with the name trimmed and the posts as they were checked', async () => {
      const made = await call('post', '', admin, { ...template, name: '  Höstens tjänstefördelning ' }).expect(201);
      expect(made.body).toMatchObject({ id: ID, kind: 'requirements', name: 'Höstens tjänstefördelning', headerRow: 2 });
      expect(model()['create']).toHaveBeenCalledWith(
        expect.objectContaining({ data: { schoolId: '33333333-3333-4333-8333-333333333333', kind: 'requirements', name: 'Höstens tjänstefördelning', headerRow: 2, placements: template.placements } }),
      );
    });

    it.each([
      ['a field of another kind', { ...template, kind: 'rooms' }, 400, 'TEMPLATE_UNKNOWN_FIELD', { field: 'groupName', kind: 'rooms' }],
      ['a field placed twice', { ...template, placements: [post('a', 'groupName'), post('b', 'groupName')] }, 400, 'TEMPLATE_DUPLICATE_FIELD', { field: 'groupName' }],
      ['two fields for the same cells', { kind: 'scheduleLessons', name: 'x', placements: [post('tid', 'timeRange'), post('slut', 'end')] }, 400, 'TEMPLATE_FIELDS_CONFLICT', { a: 'timeRange', b: 'end' }],
      ['a key that stands twice', { ...template, placements: [post('a', 'groupName'), post('a', null)] }, 400, 'TEMPLATE_DUPLICATE_KEY', { index: 1 }],
      ['a header shaped like a personnummer', { ...template, placements: [post('a', null), post('b', null, 'Personnr 19800101-1234')] }, 400, 'TEMPLATE_PERSONAL_NUMBER', { index: 1 }],
      ['a name shaped like a personnummer', { ...template, name: 'Mall 198001011234' }, 400, 'TEMPLATE_PERSONAL_NUMBER', { in: 'name' }],
      ['a blank name', { ...template, name: '   ' }, 400, 'TEMPLATE_NAME_INVALID', { max: 80 }],
    ])('sends %s as a problem with its code and its flat params', async (_label, body, status, code, params) => {
      const refused = await call('post', '', admin, body).expect(status);
      expect(refused.body).toMatchObject({ status, code, params });
      // A refusal names a place and never quotes a header that has the shape of a number.
      expect(JSON.stringify(refused.body)).not.toMatch(/19800101/);
      expect(model()['create']).not.toHaveBeenCalled();
    });

    it('sends the template limit with the limit, and a name taken as a 409 with its code', async () => {
      model()['count']!.mockResolvedValue(20);
      const full = await call('post', '', admin, template).expect(409);
      expect(full.body).toMatchObject({ code: 'TEMPLATE_LIMIT', params: { limit: 20 } });
      model()['count']!.mockResolvedValue(0);
      model()['create']!.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('x', { code: 'P2002', clientVersion: 'test' }));
      const taken = await call('post', '', admin, template).expect(409);
      expect(taken.body.code).toBe('TEMPLATE_NAME_TAKEN');
    });

    it('answers 404 for a template the arms hide, on a change and a removal alike', async () => {
      model()['findUnique']!.mockResolvedValue(null);
      await call('patch', `/${ID}`, admin, { name: 'Ny' }).expect(404);
      model()['deleteMany']!.mockResolvedValue({ count: 0 });
      await call('delete', `/${ID}`, admin).expect(404);
    });

    it('checks a changed list of posts against the kind the template already has, not one the body names', async () => {
      model()['findUnique']!.mockResolvedValue({ kind: 'rooms' });
      const refused = await call('patch', `/${ID}`, admin, { placements: [post('grupp', 'groupName')] }).expect(400);
      expect(refused.body).toMatchObject({ code: 'TEMPLATE_UNKNOWN_FIELD', params: { field: 'groupName', kind: 'rooms' } });
      expect(model()['update']).not.toHaveBeenCalled();
    });

    it('takes a header row back to the first with an explicit null, and leaves it when the body says nothing', async () => {
      await call('patch', `/${ID}`, admin, { headerRow: null }).expect(200);
      expect(model()['update']).toHaveBeenLastCalledWith(expect.objectContaining({ data: { headerRow: null } }));
      await call('patch', `/${ID}`, admin, { name: 'Ny' }).expect(200);
      expect(model()['update']).toHaveBeenLastCalledWith(expect.objectContaining({ data: { name: 'Ny' } }));
    });
  });
});
