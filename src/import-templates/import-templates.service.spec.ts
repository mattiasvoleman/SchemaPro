import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createPrismaMock, createTxMock, testUser, type PrismaMock, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { IMPORT_TEMPLATE_LIMIT } from './import-fields';
import {
  checkPlacements,
  cleanTemplateName,
  ImportTemplatesService,
  TEMPLATE_DUPLICATE_FIELD,
  TEMPLATE_DUPLICATE_KEY,
  TEMPLATE_FIELDS_CONFLICT,
  TEMPLATE_LABEL_INVALID,
  TEMPLATE_LIMIT,
  TEMPLATE_NAME_INVALID,
  TEMPLATE_NAME_TAKEN,
  TEMPLATE_PERSONAL_NUMBER,
  TEMPLATE_UNKNOWN_FIELD,
  toTemplateView,
} from './import-templates.service';

const SCHOOL = '33333333-3333-4333-8333-333333333333';
const ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-11-18T10:00:00.000Z');

const post = (key: string, field: string | null, label = key) => ({ key, label, field });
const known = (code: string) => new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: 'test' });
const row = (over: Record<string, unknown> = {}) => ({
  id: ID,
  kind: 'requirements',
  name: 'Höstens tjänstefördelning',
  headerRow: null,
  placements: [{ key: 'grupp', label: 'Grupp', field: 'groupName' }],
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

/** The refusal's code and flat params, or what else was thrown. */
const refusal = (run: () => unknown): { status: number; code?: string; params?: unknown } | unknown => {
  try {
    run();
  } catch (error) {
    if (error instanceof BadRequestException || error instanceof ConflictException) {
      const body = error.getResponse() as { code?: string; params?: unknown };
      return { status: error.getStatus(), code: body.code, params: body.params };
    }
    return error;
  }
  return 'resolved';
};

describe('cleanTemplateName', () => {
  it('trims, and keeps a name of one to eighty characters', () => {
    expect(cleanTemplateName('  Höstens tjänstefördelning ')).toBe('Höstens tjänstefördelning');
    expect(cleanTemplateName('x')).toBe('x');
    expect(cleanTemplateName('ö'.repeat(80))).toHaveLength(80);
  });

  it.each([['blank', '   '], ['empty', ''], ['too long', 'x'.repeat(81)], ['a control character', 'Hö\tst'], ['a line break', 'a\nb'], ['an invisible one', 'a​b']])(
    'refuses %s',
    (_what, name) => {
      expect(refusal(() => cleanTemplateName(name))).toEqual({ status: 400, code: TEMPLATE_NAME_INVALID, params: { max: 80 } });
    },
  );

  it('counts characters, not UTF-16 units, as the database does', () => {
    expect(cleanTemplateName('😀'.repeat(80))).toHaveLength(160);
    expect(refusal(() => cleanTemplateName('😀'.repeat(81)))).toMatchObject({ code: TEMPLATE_NAME_INVALID });
  });

  it('refuses a name that looks like a personnummer, without quoting it', () => {
    const refused = refusal(() => cleanTemplateName('Mall 19800101-1234'));
    expect(refused).toEqual({ status: 400, code: TEMPLATE_PERSONAL_NUMBER, params: { in: 'name' } });
    expect(JSON.stringify(refused)).not.toContain('19800101');
  });
});

describe('checkPlacements', () => {
  it('keeps a mapping of fields of the kind, and the columns that read nothing', () => {
    const posts = [post('grupp', 'groupName', 'Grupp'), post('amne', 'subject', 'Ämne'), post('anteckning', null, 'Anteckning')];
    expect(checkPlacements('requirements', posts)).toEqual(posts);
  });

  it('refuses a field that belongs to another kind, naming it and the kind', () => {
    expect(refusal(() => checkPlacements('rooms', [post('grupp', 'groupName')]))).toEqual({
      status: 400,
      code: TEMPLATE_UNKNOWN_FIELD,
      params: { field: 'groupName', kind: 'rooms' },
    });
  });

  it('refuses a field placed on two columns, never keeping the first', () => {
    expect(refusal(() => checkPlacements('students', [post('a', 'email'), post('b', 'email')]))).toEqual({
      status: 400,
      code: TEMPLATE_DUPLICATE_FIELD,
      params: { field: 'email' },
    });
  });

  it('allows several columns that read nothing, and holds the kind\'s own pairs apart', () => {
    expect(() => checkPlacements('students', [post('a', null), post('b', null)])).not.toThrow();
    expect(refusal(() => checkPlacements('scheduleLessons', [post('tid', 'timeRange'), post('slut', 'end')]))).toEqual({
      status: 400,
      code: TEMPLATE_FIELDS_CONFLICT,
      params: { a: 'timeRange', b: 'end' },
    });
    expect(refusal(() => checkPlacements('scheduleLessons', [post('lar', 'teacherList'), post('lar2', 'coTeacher')]))).toMatchObject({
      code: TEMPLATE_FIELDS_CONFLICT,
    });
    expect(() => checkPlacements('scheduleLessons', [post('tid', 'timeRange'), post('start', null), post('lar', 'teacher')])).not.toThrow();
  });

  it('refuses a key that stands twice', () => {
    expect(refusal(() => checkPlacements('students', [post('namn', 'firstName'), post('namn', null)]))).toEqual({
      status: 400,
      code: TEMPLATE_DUPLICATE_KEY,
      params: { index: 1 },
    });
  });

  it('refuses a control character in a label', () => {
    expect(refusal(() => checkPlacements('students', [post('namn', 'firstName', 'För\nnamn')]))).toEqual({
      status: 400,
      code: TEMPLATE_LABEL_INVALID,
      params: { index: 0 },
    });
  });

  it.each([
    ['a label', post('namn', 'firstName', 'Personnr 19800101-1234')],
    ['a label in the 12-digit form', post('namn', 'firstName', '198001011234')],
    ['a label with a samordningsnummer', post('namn', 'firstName', '800161-1234')],
    ['a label in another spelling', post('namn', 'firstName', '1980 01 01 1234')],
    ['a key', post('198001011234', null, '')],
  ])('refuses %s that has the shape of a personnummer, naming its place and not its text', (_what, bad) => {
    const refused = refusal(() => checkPlacements('students', [post('a', 'lastName'), bad]));
    expect(refused).toEqual({ status: 400, code: TEMPLATE_PERSONAL_NUMBER, params: { index: 1 } });
    expect(JSON.stringify(refused)).not.toMatch(/1980|800161/);
  });

  it('lets an ordinary header with digits and dates through', () => {
    expect(() =>
      checkPlacements('students', [post('klass7a', 'className', 'Klass 7A'), post('lasar20262027', null, 'Läsår 2026-2027')]),
    ).not.toThrow();
  });
});

describe('toTemplateView', () => {
  it('rebuilds the posts and writes the dates as text', () => {
    expect(toTemplateView(row({ placements: [{ key: 'a', label: 'A', field: 'email', extra: 'x' }, { key: 'b', label: 'B', field: null }] }))).toEqual({
      id: ID,
      kind: 'requirements',
      name: 'Höstens tjänstefördelning',
      headerRow: null,
      placements: [{ key: 'a', label: 'A', field: 'email' }, { key: 'b', label: 'B', field: null }],
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
  });

  it('drops a post that is not a post, and reads a stored non-array as none', () => {
    expect(toTemplateView(row({ placements: [1, null, [], { key: 1, label: 'x' }, { key: 'a', label: 'A', field: 7 }] })).placements).toEqual([
      { key: 'a', label: 'A', field: null },
    ]);
    expect(toTemplateView(row({ placements: { key: 'a' } })).placements).toEqual([]);
  });

  it('scrubs a personnummer that a path other than this one wrote into a row', () => {
    const view = toTemplateView(row({ placements: [{ key: 'a', label: 'Elev 19800101-1234', field: null }] }));
    expect(JSON.stringify(view)).not.toContain('19800101');
    expect(view.placements[0]!.label).toContain('[personnummer]');
  });
});

describe('ImportTemplatesService', () => {
  let tx: TxMock;
  let prisma: PrismaMock;
  let service: ImportTemplatesService;
  const mapping = { kind: 'requirements' as const, name: ' Höst ', placements: [post('grupp', 'groupName', 'Grupp')] };

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock(tx);
    service = new ImportTemplatesService(prisma as unknown as PrismaService);
    tx.importMappingTemplate.findMany.mockResolvedValue([]);
    tx.importMappingTemplate.count.mockResolvedValue(0);
    tx.importMappingTemplate.create.mockResolvedValue(row());
    tx.importMappingTemplate.update.mockResolvedValue(row());
    tx.importMappingTemplate.deleteMany.mockResolvedValue({ count: 1 });
    tx.importMappingTemplate.findUnique.mockResolvedValue({ kind: 'requirements' });
  });

  describe('list', () => {
    it('asks for the caller\'s school, narrowed to a kind when one is given', async () => {
      await service.list({}, testUser());
      expect(tx.importMappingTemplate.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { schoolId: SCHOOL } }));
      await service.list({ kind: 'rooms' }, testUser());
      expect(tx.importMappingTemplate.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { schoolId: SCHOOL, kind: 'rooms' } }));
    });

    it('orders by kind and then by name in Swedish, numbers by value (a name late in the alphabet still follows its kind)', async () => {
      tx.importMappingTemplate.findMany.mockResolvedValue([
        row({ id: 'a', kind: 'rooms', name: 'Ö' }),
        row({ id: 'b', kind: 'rooms', name: 'Z' }),
        row({ id: 'c', kind: 'rooms', name: 'Mall 10' }),
        row({ id: 'd', kind: 'rooms', name: 'Mall 9' }),
        row({ id: 'e', kind: 'classes', name: 'Ä' }),
      ]);
      expect((await service.list({}, testUser())).map((view) => view.id)).toEqual(['e', 'd', 'c', 'b', 'a']);
    });
  });

  describe('create', () => {
    it('writes the trimmed name, the school\'s own id and the posts as they are checked', async () => {
      await expect(service.create(mapping, testUser())).resolves.toMatchObject({ id: ID, kind: 'requirements' });
      expect(tx.importMappingTemplate.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { schoolId: SCHOOL, kind: 'requirements', name: 'Höst', headerRow: null, placements: [post('grupp', 'groupName', 'Grupp')] },
        }),
      );
    });

    it('stores the header row it was given', async () => {
      await service.create({ ...mapping, headerRow: 3 }, testUser());
      expect(tx.importMappingTemplate.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ headerRow: 3 }) }));
    });

    it('refuses before it writes: a bad name, a bad post', async () => {
      await expect(service.create({ ...mapping, name: ' ' }, testUser())).rejects.toBeInstanceOf(BadRequestException);
      await expect(service.create({ ...mapping, placements: [post('a', 'nope')] }, testUser())).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.importMappingTemplate.create).not.toHaveBeenCalled();
      expect(prisma.withRls).not.toHaveBeenCalled();
    });

    it('stops at the limit, and says what it is', async () => {
      tx.importMappingTemplate.count.mockResolvedValue(IMPORT_TEMPLATE_LIMIT);
      const refused = await service.create(mapping, testUser()).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(ConflictException);
      expect((refused as ConflictException).getResponse()).toMatchObject({ code: TEMPLATE_LIMIT, params: { limit: IMPORT_TEMPLATE_LIMIT } });
      expect(tx.importMappingTemplate.count).toHaveBeenCalledWith({ where: { schoolId: SCHOOL, kind: 'requirements' } });
      expect(tx.importMappingTemplate.create).not.toHaveBeenCalled();
    });

    it('takes a second writer\'s name as the name taken', async () => {
      tx.importMappingTemplate.create.mockRejectedValue(known('P2002'));
      const refused = await service.create(mapping, testUser()).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(ConflictException);
      expect((refused as ConflictException).getResponse()).toMatchObject({ code: TEMPLATE_NAME_TAKEN });
    });
  });

  describe('update', () => {
    it('changes only what it was given, and checks the posts against the template\'s own kind', async () => {
      await service.update(ID, { name: ' Ny ' }, testUser());
      expect(tx.importMappingTemplate.update).toHaveBeenLastCalledWith({ where: { id: ID }, data: { name: 'Ny' }, select: expect.anything() });
      await service.update(ID, { headerRow: null, placements: [post('grupp', 'groupName')] }, testUser());
      expect(tx.importMappingTemplate.update).toHaveBeenLastCalledWith({
        where: { id: ID },
        data: { headerRow: null, placements: [post('grupp', 'groupName')] },
        select: expect.anything(),
      });
      await expect(service.update(ID, { placements: [post('namn', 'firstName')] }, testUser())).rejects.toMatchObject({
        response: { code: TEMPLATE_UNKNOWN_FIELD },
      });
    });

    it('answers 404 for a row the arms hide, and writes nothing', async () => {
      tx.importMappingTemplate.findUnique.mockResolvedValue(null);
      await expect(service.update(ID, { name: 'x' }, testUser())).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.importMappingTemplate.update).not.toHaveBeenCalled();
    });

    it('takes a taken name as the name taken', async () => {
      tx.importMappingTemplate.update.mockRejectedValue(known('P2002'));
      await expect(service.update(ID, { name: 'Höst' }, testUser())).rejects.toMatchObject({ response: { code: TEMPLATE_NAME_TAKEN } });
    });
  });

  describe('remove', () => {
    it('deletes by id, under the caller\'s arms', async () => {
      await expect(service.remove(ID, testUser())).resolves.toBeUndefined();
      expect(tx.importMappingTemplate.deleteMany).toHaveBeenCalledWith({ where: { id: ID } });
    });

    it('answers 404 when no row was removed', async () => {
      tx.importMappingTemplate.deleteMany.mockResolvedValue({ count: 0 });
      await expect(service.remove(ID, testUser())).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
