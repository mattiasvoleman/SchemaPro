import { ConflictException, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { PrismaService } from '../database/prisma.service';
import { InstructionService } from './instruction.service';

const admin = testUser({ schoolId: 'school-1', userId: 'admin-1' });
const teacher = testUser({ schoolId: 'school-1', userId: 'teacher-1', role: 'TEACHER' as never });
const NOW = new Date('2026-11-07T10:00:00Z');

/** The SQL a tagged template or Prisma.sql carries, as one string. */
const sqlOf = (arg: unknown): string =>
  Array.isArray(arg) ? arg.join('?') : typeof arg === 'object' && arg !== null && 'sql' in arg ? String((arg as { sql: string }).sql) : String(arg);

/** Answers $queryRaw by a fragment of its SQL, in the order the keys are given. */
function raw(tx: TxMock, answers: Record<string, unknown>): void {
  tx.$queryRaw.mockImplementation((strings: unknown) => {
    const sql = sqlOf(strings);
    for (const [fragment, answer] of Object.entries(answers)) {
      if (sql.includes(fragment)) return Promise.resolve(typeof answer === 'function' ? (answer as () => unknown)() : answer);
    }
    return Promise.resolve([]);
  });
}

function setup() {
  const tx = createTxMock();
  const prisma = createPrismaMock(tx);
  const service = new InstructionService(prisma as unknown as PrismaService);
  return { tx, prisma, service };
}

/** A refusal the database raised, as the adapter reports a raw statement's (P2010), named in the message. */
function refusal(code: string, name = ''): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`Raw query failed. Code: \`${code}\`. Message: \`${name}\``, {
    code: 'P2010',
    clientVersion: 'test',
    meta: { driverAdapterError: { cause: { originalCode: code } } },
  });
}

const known = (code: string) => new Prisma.PrismaClientKnownRequestError(`Prisma error ${code}`, { code, clientVersion: 'test' });

const tpl = (over: Record<string, unknown> = {}) => ({
  id: 't-1',
  schoolId: 'school-1',
  subjectId: null as string | null,
  title: 'Cirkelsågen',
  description: null as string | null,
  active: true,
  ...over,
});

const pupil = (id: string, firstName: string, lastName: string, className: string | null = '7A') => ({
  id,
  firstName,
  lastName,
  studentGroup: className ? { name: className } : null,
});

const proof = (over: Record<string, unknown> = {}) => ({
  id: 'pr-1',
  schoolId: 'school-1',
  templateId: 't-1',
  studentId: 'p-1',
  instructedOn: new Date('2026-11-03T00:00:00Z'),
  instructorId: 'teacher-1' as string | null,
  recordedById: 'teacher-1' as string | null,
  recordedAt: new Date('2026-11-03T09:15:00Z'),
  note: null as string | null,
  voidedAt: null,
  ...over,
});

/** The SQL of every raw read the service has made. */
const rawSql = (tx: TxMock): string[] => tx.$queryRaw.mock.calls.map((call) => sqlOf(call[0]));

/** The exact SQL values of the read-log statement that was run, or null when none was. */
function readLogged(tx: TxMock): unknown[] | null {
  const calls = tx.$executeRaw.mock.calls;
  expect(calls.length).toBeLessThanOrEqual(1);
  return calls.length === 0 ? null : (calls[0]![0] as { values: unknown[] }).values;
}

describe('InstructionService', () => {
  describe('templates', () => {
    it('lists the active templates of the school, by title, with the name of the subject, and records no read', async () => {
      const { tx, service } = setup();
      tx['instructionTemplate']!['findMany']!.mockResolvedValue([tpl({ id: 't-1', title: 'Cirkelsågen', subjectId: 's-1', description: 'Skydd och nödstopp' }), tpl({ id: 't-2', title: 'Kast och stöt' })]);
      tx['subject']!['findMany']!.mockResolvedValue([{ id: 's-1', name: 'Slöjd' }]);
      expect(await service.templates(admin)).toEqual([
        { id: 't-1', subjectId: 's-1', subjectName: 'Slöjd', title: 'Cirkelsågen', description: 'Skydd och nödstopp', active: true },
        { id: 't-2', subjectId: null, subjectName: null, title: 'Kast och stöt', description: null, active: true },
      ]);
      expect(tx['instructionTemplate']!['findMany']).toHaveBeenCalledWith({
        where: { schoolId: 'school-1', active: true },
        orderBy: [{ title: 'asc' }, { id: 'asc' }],
      });
      expect(tx['subject']!['findMany']).toHaveBeenCalledWith({ where: { id: { in: ['s-1'] } }, select: { id: true, name: true } });
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('includes the retired templates when asked to', async () => {
      const { tx, service } = setup();
      tx['instructionTemplate']!['findMany']!.mockResolvedValue([tpl({ active: false })]);
      const views = await service.templates(teacher, true);
      expect(views[0]!.active).toBe(false);
      expect(tx['instructionTemplate']!['findMany']).toHaveBeenCalledWith(expect.objectContaining({ where: { schoolId: 'school-1' } }));
    });

    it('asks nothing of Subjects when no template has one, and has no name for a subject that is gone', async () => {
      const { tx, service } = setup();
      tx['instructionTemplate']!['findMany']!.mockResolvedValue([tpl()]);
      expect((await service.templates(admin))[0]!.subjectName).toBeNull();
      expect(tx['subject']!['findMany']).not.toHaveBeenCalled();
      tx['instructionTemplate']!['findMany']!.mockResolvedValue([tpl({ subjectId: 's-gone' })]);
      tx['subject']!['findMany']!.mockResolvedValue([]);
      expect(await service.templates(admin)).toEqual([expect.objectContaining({ subjectId: 's-gone', subjectName: null })]);
    });

    it('asks for each subject once', async () => {
      const { tx, service } = setup();
      tx['instructionTemplate']!['findMany']!.mockResolvedValue([tpl({ id: 't-1', subjectId: 's-1' }), tpl({ id: 't-2', subjectId: 's-1' }), tpl({ id: 't-3', subjectId: 's-2' })]);
      await service.templates(admin);
      expect(tx['subject']!['findMany']).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['s-1', 's-2'] } } }));
    });

    it('refuses a login with no school', async () => {
      const { service } = setup();
      await expect(service.templates(testUser({ schoolId: undefined }))).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('createTemplate', () => {
    it('writes the moment for the school, and answers it with the subject’s name', async () => {
      const { tx, service } = setup();
      const row = tpl({ subjectId: 's-1', description: 'Alla moment' });
      tx['instructionTemplate']!['create']!.mockResolvedValue(row);
      tx['subject']!['findMany']!.mockResolvedValue([{ id: 's-1', name: 'Slöjd' }]);
      const view = await service.createTemplate({ title: 'Cirkelsågen', description: 'Alla moment', subjectId: 's-1' }, admin);
      expect(view).toEqual({ id: 't-1', subjectId: 's-1', subjectName: 'Slöjd', title: 'Cirkelsågen', description: 'Alla moment', active: true });
      expect(tx['instructionTemplate']!['create']).toHaveBeenCalledWith({
        data: { schoolId: 'school-1', title: 'Cirkelsågen', description: 'Alla moment', subjectId: 's-1' },
      });
    });

    it('writes null for a description and a subject that are left out', async () => {
      const { tx, service } = setup();
      tx['instructionTemplate']!['create']!.mockResolvedValue(tpl());
      const view = await service.createTemplate({ title: 'Cirkelsågen' }, admin);
      expect(view).toMatchObject({ subjectId: null, subjectName: null, description: null });
      expect(tx['instructionTemplate']!['create']).toHaveBeenCalledWith({ data: { schoolId: 'school-1', title: 'Cirkelsågen', description: null, subjectId: null } });
    });

    it('answers a moment the subject already has as 409 CHECKLIST_TEMPLATE_EXISTS', async () => {
      const { tx, service } = setup();
      tx['instructionTemplate']!['create']!.mockRejectedValue(known('P2002'));
      const error = await service.createTemplate({ title: 'Cirkelsågen' }, admin).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error).toMatchObject({ response: { code: 'CHECKLIST_TEMPLATE_EXISTS', message: 'Det momentet finns redan i det ämnet.' } });
    });

    it('answers a subject the school does not have as 422 CHECKLIST_UNKNOWN_SUBJECT', async () => {
      const { tx, service } = setup();
      tx['instructionTemplate']!['create']!.mockRejectedValue(known('P2003'));
      const error = await service.createTemplate({ title: 'Cirkelsågen', subjectId: 's-x' }, admin).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(error).toMatchObject({ response: { code: 'CHECKLIST_UNKNOWN_SUBJECT' } });
    });

    it('answers the database’s own refusals with their codes, and lets any other error through', async () => {
      const { tx, service } = setup();
      tx['instructionTemplate']!['create']!.mockRejectedValue(refusal('CL403', 'CHECKLIST_NOT_STAFF'));
      await expect(service.createTemplate({ title: 'T' }, admin)).rejects.toMatchObject({ status: 403, response: { code: 'CHECKLIST_NOT_STAFF' } });
      const other = new Error('connection reset');
      tx['instructionTemplate']!['create']!.mockRejectedValue(other);
      await expect(service.createTemplate({ title: 'T' }, admin)).rejects.toBe(other);
    });

    it('refuses a login with no school before it touches the database', async () => {
      const { tx, service } = setup();
      await expect(service.createTemplate({ title: 'T' }, testUser({ schoolId: undefined }))).rejects.toBeInstanceOf(ForbiddenException);
      expect(tx['instructionTemplate']!['create']).not.toHaveBeenCalled();
    });
  });

  describe('updateTemplate', () => {
    it('saves only what is named', async () => {
      const { tx, service } = setup();
      tx['instructionTemplate']!['update']!.mockResolvedValue(tpl({ title: 'Ny titel' }));
      const view = await service.updateTemplate('t-1', { title: 'Ny titel' }, admin);
      expect(view.title).toBe('Ny titel');
      expect(tx['instructionTemplate']!['update']).toHaveBeenCalledWith({ where: { id_schoolId: { id: 't-1', schoolId: 'school-1' } }, data: { title: 'Ny titel' } });
    });

    it('saves all four fields when all are named, and null clears a description and a subject', async () => {
      const { tx, service } = setup();
      tx['instructionTemplate']!['update']!.mockResolvedValue(tpl({ active: false }));
      await service.updateTemplate('t-1', { title: 'T', description: 'D', subjectId: 's-1', active: false }, admin);
      expect(tx['instructionTemplate']!['update']).toHaveBeenLastCalledWith(expect.objectContaining({ data: { title: 'T', description: 'D', subjectId: 's-1', active: false } }));
      await service.updateTemplate('t-1', { description: null, subjectId: null }, admin);
      expect(tx['instructionTemplate']!['update']).toHaveBeenLastCalledWith(expect.objectContaining({ data: { description: null, subjectId: null } }));
      await service.updateTemplate('t-1', { active: true }, admin);
      expect(tx['instructionTemplate']!['update']).toHaveBeenLastCalledWith(expect.objectContaining({ data: { active: true } }));
    });

    it('writes nothing of its own for an empty save', async () => {
      const { tx, service } = setup();
      tx['instructionTemplate']!['update']!.mockResolvedValue(tpl());
      await service.updateTemplate('t-1', {}, admin);
      expect(tx['instructionTemplate']!['update']).toHaveBeenCalledWith(expect.objectContaining({ data: {} }));
    });

    it('answers the name of the subject it was moved to', async () => {
      const { tx, service } = setup();
      tx['instructionTemplate']!['update']!.mockResolvedValue(tpl({ subjectId: 's-2' }));
      tx['subject']!['findMany']!.mockResolvedValue([{ id: 's-2', name: 'Idrott' }]);
      expect(await service.updateTemplate('t-1', { subjectId: 's-2' }, admin)).toMatchObject({ subjectId: 's-2', subjectName: 'Idrott' });
    });

    it('answers a template that is not the school’s (Prisma’s P2025) as 404 CHECKLIST_NOT_FOUND', async () => {
      const { tx, service } = setup();
      tx['instructionTemplate']!['update']!.mockRejectedValue(known('P2025'));
      const error = await service.updateTemplate('t-x', { title: 'T' }, admin).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      expect(error).toMatchObject({ response: { code: 'CHECKLIST_NOT_FOUND', message: 'Det finns inte, eller är inte ditt att se.' } });
    });

    it('answers a moment the subject already has, a subject that is not there, and the database’s refusals', async () => {
      const { tx, service } = setup();
      tx['instructionTemplate']!['update']!.mockRejectedValue(known('P2002'));
      await expect(service.updateTemplate('t-1', { title: 'T' }, admin)).rejects.toMatchObject({ status: 409, response: { code: 'CHECKLIST_TEMPLATE_EXISTS' } });
      tx['instructionTemplate']!['update']!.mockRejectedValue(known('P2003'));
      await expect(service.updateTemplate('t-1', { subjectId: 's-x' }, admin)).rejects.toMatchObject({ status: 422, response: { code: 'CHECKLIST_UNKNOWN_SUBJECT' } });
      tx['instructionTemplate']!['update']!.mockRejectedValue(refusal('CL403', 'CHECKLIST_NOT_STAFF'));
      await expect(service.updateTemplate('t-1', { title: 'T' }, admin)).rejects.toMatchObject({ status: 403, response: { code: 'CHECKLIST_NOT_STAFF' } });
    });

    it('lets an error that is not ours through', async () => {
      const { tx, service } = setup();
      const other = new Error('connection reset');
      tx['instructionTemplate']!['update']!.mockRejectedValue(other);
      await expect(service.updateTemplate('t-1', { title: 'T' }, admin)).rejects.toBe(other);
    });
  });

  describe('groups', () => {
    const g7a = { id: 'g-7a', name: '7A', kind: 'CLASS' as const };
    const g8b = { id: 'g-8b', name: '8B', kind: 'CLASS' as const };
    const gSlojd = { id: 'g-sl', name: 'Slöjd 7', kind: 'TEACHING_GROUP' as const };

    it('is every group of the active year for an administrator, who may tick them all and make a list for each class, with no subjects', async () => {
      const { tx, service } = setup();
      tx['studentGroup']!['findMany']!.mockResolvedValue([g7a, gSlojd]);
      expect(await service.groups(admin)).toEqual([
        { id: 'g-7a', name: '7A', kind: 'CLASS', subjects: [], canTick: true, canMakeList: true },
        { id: 'g-sl', name: 'Slöjd 7', kind: 'TEACHING_GROUP', subjects: [], canTick: true, canMakeList: false },
      ]);
      expect(tx['studentGroup']!['findMany']).toHaveBeenCalledWith({
        where: { schoolId: 'school-1', academicYear: { isActive: true } },
        select: { id: true, name: true, kind: true },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      });
      expect(tx['masterLesson']!['findMany']).not.toHaveBeenCalled();
      expect(tx.$queryRaw).not.toHaveBeenCalled();
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it.each(['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION'])('lets an administrator with the profile %s, who writes Drift, tick every group', async (profile) => {
      const { tx, service } = setup();
      tx['studentGroup']!['findMany']!.mockResolvedValue([g7a, gSlojd]);
      const groups = await service.groups(testUser({ schoolId: 'school-1', userId: 'admin-1', adminProfile: profile as never }));
      expect(groups.map((group) => group.canTick)).toEqual([true, true]);
      // A list is made for a class and not for a teaching group.
      expect(groups.map((group) => group.canMakeList)).toEqual([true, false]);
    });

    it('lets an administrator whose request carries no profile tick every group, as it always did', async () => {
      const { tx, service } = setup();
      tx['studentGroup']!['findMany']!.mockResolvedValue([g7a]);
      const groups = await service.groups(testUser({ schoolId: 'school-1', userId: 'admin-1', adminProfile: undefined }));
      expect(groups).toEqual([expect.objectContaining({ id: 'g-7a', canTick: true, canMakeList: true })]);
    });

    it('lets a läsare look at every group, tick none and make no list', async () => {
      const { tx, service } = setup();
      tx['studentGroup']!['findMany']!.mockResolvedValue([g7a, gSlojd]);
      const groups = await service.groups(testUser({ schoolId: 'school-1', userId: 'admin-1', adminProfile: 'LASARE' as never }));
      expect(groups).toEqual([
        { id: 'g-7a', name: '7A', kind: 'CLASS', subjects: [], canTick: false, canMakeList: false },
        { id: 'g-sl', name: 'Slöjd 7', kind: 'TEACHING_GROUP', subjects: [], canTick: false, canMakeList: false },
      ]);
    });

    it('is, for a teacher, the groups of their lessons and the extra classes of those, with the subjects they teach there', async () => {
      const { tx, service } = setup();
      raw(tx, { 'app.ack_mentee_ids()': [{ ids: [] }] });
      tx['masterLesson']!['findMany']!.mockResolvedValue([
        { subject: { name: 'Slöjd' }, studentGroup: gSlojd, extraGroups: [{ studentGroup: g7a }] },
        { subject: { name: 'Matematik' }, studentGroup: g7a, extraGroups: [] },
        { subject: { name: 'Slöjd' }, studentGroup: g7a, extraGroups: [] },
      ]);
      // A class they only teach in is not one they may make a list for; that is the mentors'.
      expect(await service.groups(teacher)).toEqual([
        { id: 'g-7a', name: '7A', kind: 'CLASS', subjects: ['Slöjd', 'Matematik'], canTick: true, canMakeList: false },
        { id: 'g-sl', name: 'Slöjd 7', kind: 'TEACHING_GROUP', subjects: ['Slöjd'], canTick: true, canMakeList: false },
      ]);
      expect(tx['masterLesson']!['findMany']).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            schoolId: 'school-1',
            isParked: false,
            academicYear: { isActive: true },
            OR: [{ teacherId: 'teacher-1' }, { coTeacherId: 'teacher-1' }],
          },
        }),
      );
      expect(tx['user']!['findMany']).not.toHaveBeenCalled();
    });

    it('adds the classes of the teacher’s mentees to look at, and to make a list for, and not to tick; a class that is ticked stays ticked and gains the list', async () => {
      const { tx, service } = setup();
      raw(tx, { 'app.ack_mentee_ids()': [{ ids: ['m-1', 'm-2', 'm-3', 'm-4'] }] });
      tx['masterLesson']!['findMany']!.mockResolvedValue([{ subject: { name: 'Matematik' }, studentGroup: g7a, extraGroups: [] }]);
      tx['user']!['findMany']!.mockResolvedValue([{ studentGroup: g8b }, { studentGroup: g7a }, { studentGroup: g8b }, { studentGroup: null }]);
      expect(await service.groups(teacher)).toEqual([
        { id: 'g-7a', name: '7A', kind: 'CLASS', subjects: ['Matematik'], canTick: true, canMakeList: true },
        { id: 'g-8b', name: '8B', kind: 'CLASS', subjects: [], canTick: false, canMakeList: true },
      ]);
      expect(tx['user']!['findMany']).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['m-1', 'm-2', 'm-3', 'm-4'] }, studentGroupId: { not: null } } }));
    });

    it('lets a teacher make a list for a mentee’s class only when it is a class: a mentee’s group that is a teaching group is not one', async () => {
      const { tx, service } = setup();
      raw(tx, { 'app.ack_mentee_ids()': [{ ids: ['m-1', 'm-2'] }] });
      tx['user']!['findMany']!.mockResolvedValue([{ studentGroup: gSlojd }, { studentGroup: g8b }]);
      expect(await service.groups(teacher)).toEqual([
        { id: 'g-8b', name: '8B', kind: 'CLASS', subjects: [], canTick: false, canMakeList: true },
        { id: 'g-sl', name: 'Slöjd 7', kind: 'TEACHING_GROUP', subjects: [], canTick: false, canMakeList: false },
      ]);
    });

    it('gives a class that is both a lesson’s extra class and a mentee’s class both: ticked, and a list', async () => {
      const { tx, service } = setup();
      raw(tx, { 'app.ack_mentee_ids()': [{ ids: ['m-1'] }] });
      // The lesson is in 7A as an extra class; the mentee is in 7A as well.
      tx['masterLesson']!['findMany']!.mockResolvedValue([{ subject: { name: 'Slöjd' }, studentGroup: gSlojd, extraGroups: [{ studentGroup: g7a }] }]);
      tx['user']!['findMany']!.mockResolvedValue([{ studentGroup: g7a }]);
      const groups = await service.groups(teacher);
      expect(groups.find((group) => group.id === 'g-7a')).toEqual({ id: 'g-7a', name: '7A', kind: 'CLASS', subjects: ['Slöjd'], canTick: true, canMakeList: true });
      expect(groups.find((group) => group.id === 'g-sl')!.canMakeList).toBe(false);
    });

    it('sorts by name as Swedish does, and groups of one name by id', async () => {
      const { tx, service } = setup();
      raw(tx, { 'app.ack_mentee_ids()': [{ ids: [] }] });
      const group = (id: string, name: string) => ({ subject: { name: 'X' }, studentGroup: { id, name, kind: 'CLASS' as const }, extraGroups: [] });
      tx['masterLesson']!['findMany']!.mockResolvedValue([group('g-3', 'Åk 9'), group('g-2', 'Åk 7'), group('g-1', 'Åk 7'), group('g-0', 'Zeta')]);
      expect((await service.groups(teacher)).map((g) => g.id)).toEqual(['g-0', 'g-1', 'g-2', 'g-3']);
    });

    it('reads a missing answer for the mentees as none', async () => {
      const { tx, service } = setup();
      raw(tx, { 'app.ack_mentee_ids()': [{ ids: null }] });
      expect(await service.groups(teacher)).toEqual([]);
      raw(tx, {});
      expect(await service.groups(teacher)).toEqual([]);
      expect(tx['user']!['findMany']).not.toHaveBeenCalled();
    });

    it('refuses a teacher with no user id, and a login with no school', async () => {
      const { service } = setup();
      await expect(service.groups(testUser({ schoolId: 'school-1', role: 'TEACHER' as never, userId: undefined }))).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.groups(testUser({ schoolId: undefined }))).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('instructors', () => {
    it('is the school’s active teachers and administrators, by name, and records no read', async () => {
      const { tx, service } = setup();
      tx['user']!['findMany']!.mockResolvedValue([
        { id: 'u-1', firstName: 'Ada', lastName: 'Ek' },
        { id: 'u-2', firstName: 'Bo', lastName: 'Fur' },
      ]);
      expect(await service.instructors(teacher)).toEqual([
        { id: 'u-1', name: 'Ada Ek' },
        { id: 'u-2', name: 'Bo Fur' },
      ]);
      expect(tx['user']!['findMany']).toHaveBeenCalledWith({
        where: { schoolId: 'school-1', isActive: true, role: { in: ['TEACHER', 'SCHOOL_ADMIN'] } },
        select: { id: true, firstName: true, lastName: true },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }, { id: 'asc' }],
      });
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('is empty when nobody is', async () => {
      const { service } = setup();
      expect(await service.instructors(admin)).toEqual([]);
    });
  });

  describe('roster', () => {
    const klass = { id: 'g-1', name: '7A', kind: 'CLASS' as const };
    const team = { id: 'g-2', name: 'Slöjd 7', kind: 'TEACHING_GROUP' as const };
    const staff = [
      { id: 'teacher-1', firstName: 'Tora', lastName: 'Lind' },
      { id: 'admin-1', firstName: 'Ada', lastName: 'Rektor' },
    ];

    /** Members of a class are found by studentGroupId; the names of staff by id. */
    function directory(tx: TxMock, members: unknown[]) {
      tx['user']!['findMany']!.mockImplementation(async ({ where }: { where: { studentGroupId?: string; id?: { in: string[] } } }) =>
        where.studentGroupId ? members : staff.filter((person) => where.id?.in.includes(person.id)),
      );
    }

    it('answers 404 for a template or a group that is not the school’s', async () => {
      const { tx, service } = setup();
      tx['instructionTemplate']!['findFirst']!.mockResolvedValue(null);
      tx['studentGroup']!['findFirst']!.mockResolvedValue(klass);
      await expect(service.roster('t-1', 'g-1', admin)).rejects.toMatchObject({ status: 404, response: { code: 'CHECKLIST_NOT_FOUND' } });
      tx['instructionTemplate']!['findFirst']!.mockResolvedValue(tpl());
      tx['studentGroup']!['findFirst']!.mockResolvedValue(null);
      await expect(service.roster('t-1', 'g-x', admin)).rejects.toBeInstanceOf(NotFoundException);
      expect(tx['instructionTemplate']!['findFirst']).toHaveBeenCalledWith({ where: { id: 't-1', schoolId: 'school-1' } });
      expect(tx['studentGroup']!['findFirst']).toHaveBeenCalledWith({ where: { id: 'g-x', schoolId: 'school-1' }, select: { id: true, name: true, kind: true } });
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('shows an administrator a class: every active pupil, sorted as Swedish sorts, with the valid proofs, the latest first', async () => {
      const { tx, service } = setup();
      tx['instructionTemplate']!['findFirst']!.mockResolvedValue(tpl({ subjectId: 's-1' }));
      tx['subject']!['findMany']!.mockResolvedValue([{ id: 's-1', name: 'Slöjd' }]);
      tx['studentGroup']!['findFirst']!.mockResolvedValue(klass);
      directory(tx, [pupil('p-3', 'Åsa', 'Åberg'), pupil('p-1', 'Anna', 'Andersson'), pupil('p-2', 'Zack', 'Zetterberg', null), pupil('p-4', 'Bo', 'Åberg')]);
      tx['instructionProof']!['findMany']!.mockResolvedValue([
        proof({ id: 'pr-2', studentId: 'p-1', instructedOn: new Date('2026-11-03T00:00:00Z'), instructorId: 'admin-1', recordedById: 'teacher-1', note: 'Visade nödstoppet' }),
        proof({ id: 'pr-1', studentId: 'p-1', instructedOn: new Date('2026-09-01T00:00:00Z'), instructorId: 'u-gone', recordedById: null, recordedAt: new Date('2026-09-01T07:00:00Z') }),
        proof({ id: 'pr-3', studentId: 'p-3', instructorId: null, recordedById: 'teacher-1' }),
      ]);

      const roster = await service.roster('t-1', 'g-1', admin);

      expect(roster.template).toEqual({ id: 't-1', subjectId: 's-1', subjectName: 'Slöjd', title: 'Cirkelsågen', description: null, active: true });
      expect(roster.group).toEqual(klass);
      expect(roster.rows.map((row) => row.studentId)).toEqual(['p-1', 'p-2', 'p-4', 'p-3']);
      expect(roster.rows.map((row) => row.name)).toEqual(['Anna Andersson', 'Zack Zetterberg', 'Bo Åberg', 'Åsa Åberg']);
      expect(roster.rows.map((row) => row.className)).toEqual(['7A', null, '7A', '7A']);
      expect(roster.rows.every((row) => row.canTick)).toBe(true);
      expect(roster.rows[0]!.proofs).toEqual([
        {
          id: 'pr-2',
          instructedOn: '2026-11-03',
          instructorId: 'admin-1',
          instructorName: 'Ada Rektor',
          recordedByName: 'Tora Lind',
          recordedAt: '2026-11-03T09:15:00.000Z',
          note: 'Visade nödstoppet',
          canVoid: true,
        },
        {
          id: 'pr-1',
          instructedOn: '2026-09-01',
          instructorId: 'u-gone',
          instructorName: null,
          recordedByName: null,
          recordedAt: '2026-09-01T07:00:00.000Z',
          note: null,
          canVoid: true,
        },
      ]);
      expect(roster.rows[3]!.proofs).toEqual([expect.objectContaining({ id: 'pr-3', instructorId: null, instructorName: null, recordedByName: 'Tora Lind' })]);
      expect(roster.rows[1]!.proofs).toEqual([]);
      expect(roster.done).toBe(2);
      expect(roster.pupils).toBe(4);
      // The screen holds nobody out.
      expect(roster.heldOut).toBe(0);
      // An administrator is asked nothing of the database's id lists.
      expect(tx.$queryRaw).not.toHaveBeenCalled();
      expect(tx['user']!['findMany']).toHaveBeenCalledWith(expect.objectContaining({ where: { schoolId: 'school-1', role: 'STUDENT', isActive: true, studentGroupId: 'g-1' } }));
      expect(tx['instructionProof']!['findMany']).toHaveBeenCalledWith({
        where: { schoolId: 'school-1', templateId: 't-1', voidedAt: null, studentId: { in: ['p-1', 'p-2', 'p-4', 'p-3'] } },
        orderBy: [{ instructedOn: 'desc' }, { recordedAt: 'desc' }, { id: 'asc' }],
      });
    });

    it.each([
      ['FULL', true],
      ['REKTOR', true],
      ['SCHEMALAGGARE', true],
      ['EXPEDITION', true],
      ['LASARE', false],
      [undefined, true],
    ])('lets an administrator with the profile %s tick: %s, and shows them the whole class either way', async (profile, canTick) => {
      const { tx, service } = setup();
      tx['instructionTemplate']!['findFirst']!.mockResolvedValue(tpl());
      tx['studentGroup']!['findFirst']!.mockResolvedValue(klass);
      directory(tx, [pupil('p-1', 'Anna', 'Andersson'), pupil('p-2', 'Bo', 'Berg')]);
      const roster = await service.roster('t-1', 'g-1', testUser({ schoolId: 'school-1', userId: 'admin-1', adminProfile: profile as never }));
      expect(roster.rows.map((row) => [row.studentId, row.canTick])).toEqual([
        ['p-1', canTick],
        ['p-2', canTick],
      ]);
      // A läsare reads the class, and it is recorded, as any administrator's reading is.
      expect(readLogged(tx)).toEqual(['PEOPLE', null, ['p-1', 'p-2']]);
    });

    describe('who may void a tick', () => {
      const ME = 'teacher-1';
      function proofs(tx: TxMock) {
        tx['instructionTemplate']!['findFirst']!.mockResolvedValue(tpl());
        tx['studentGroup']!['findFirst']!.mockResolvedValue(klass);
        directory(tx, [pupil('p-1', 'Anna', 'Andersson')]);
        tx['instructionProof']!['findMany']!.mockResolvedValue([
          proof({ id: 'pr-mine', studentId: 'p-1', recordedById: ME, instructedOn: new Date('2026-11-03T00:00:00Z') }),
          proof({ id: 'pr-theirs', studentId: 'p-1', recordedById: 'admin-1', instructedOn: new Date('2026-11-02T00:00:00Z') }),
          proof({ id: 'pr-nobody', studentId: 'p-1', recordedById: null, instructedOn: new Date('2026-11-01T00:00:00Z') }),
        ]);
        raw(tx, { 'app.checklist_taught_ids()': [{ ids: ['p-1'] }], 'app.checklist_visible_ids()': [{ ids: ['p-1'] }] });
      }
      const canVoid = async (service: InstructionService, as: Parameters<InstructionService['roster']>[2]) =>
        Object.fromEntries((await service.roster('t-1', 'g-1', as)).rows[0]!.proofs.map((view) => [view.id, view.canVoid]));

      it('lets a teacher void the ticks they wrote, and no one else’s', async () => {
        const { tx, service } = setup();
        proofs(tx);
        expect(await canVoid(service, teacher)).toEqual({ 'pr-mine': true, 'pr-theirs': false, 'pr-nobody': false });
      });

      it('lets an administrator who writes Drift void any', async () => {
        const { tx, service } = setup();
        proofs(tx);
        expect(await canVoid(service, admin)).toEqual({ 'pr-mine': true, 'pr-theirs': true, 'pr-nobody': true });
        expect(await canVoid(service, testUser({ schoolId: 'school-1', userId: 'admin-1', adminProfile: 'EXPEDITION' as never }))).toEqual({ 'pr-mine': true, 'pr-theirs': true, 'pr-nobody': true });
      });

      it('lets a läsare void none, not even one they wrote', async () => {
        const { tx, service } = setup();
        proofs(tx);
        expect(await canVoid(service, testUser({ schoolId: 'school-1', userId: 'admin-1', adminProfile: 'LASARE' as never }))).toEqual({ 'pr-mine': false, 'pr-theirs': false, 'pr-nobody': false });
      });

      it('says the same on the sheet for paper', async () => {
        const { tx, service } = setup();
        proofs(tx);
        raw(tx, { 'app.checklist_taught_ids()': [{ ids: ['p-1'] }], 'app.checklist_visible_ids()': [{ ids: ['p-1'] }], 'app.checklist_protected_ids': [{ ids: [] }] });
        const roster = await service.roster('t-1', 'g-1', teacher, true);
        expect(roster.rows[0]!.proofs.map((view) => view.canVoid)).toEqual([true, false, false]);
      });
    });

    it('records the read of every pupil named, once, as PEOPLE', async () => {
      const { tx, service } = setup();
      tx['instructionTemplate']!['findFirst']!.mockResolvedValue(tpl());
      tx['studentGroup']!['findFirst']!.mockResolvedValue(klass);
      directory(tx, [pupil('p-2', 'Bo', 'Berg'), pupil('p-1', 'Anna', 'Andersson')]);
      await service.roster('t-1', 'g-1', testUser({ schoolId: 'school-1', userId: 'admin-1', channel: 'APP' }));
      expect(readLogged(tx)).toEqual(['PEOPLE', 'APP', ['p-1', 'p-2']]);
      tx.$executeRaw.mockClear();
      await service.roster('t-1', 'g-1', admin);
      expect(readLogged(tx)).toEqual(['PEOPLE', null, ['p-1', 'p-2']]);
    });

    it('breaks a tie of surnames by first name and then by id', async () => {
      const { tx, service } = setup();
      tx['instructionTemplate']!['findFirst']!.mockResolvedValue(tpl());
      tx['studentGroup']!['findFirst']!.mockResolvedValue(klass);
      directory(tx, [pupil('p-4', 'Bo', 'Ek'), pupil('p-3', 'Anna', 'Ek'), pupil('p-2', 'Anna', 'Ek'), pupil('p-1', 'Zed', 'Ek')]);
      const roster = await service.roster('t-1', 'g-1', admin);
      expect(roster.rows.map((row) => row.studentId)).toEqual(['p-2', 'p-3', 'p-4', 'p-1']);
    });

    it('shows a teaching group through its members, and asks for no names when no proof names a person', async () => {
      const { tx, service } = setup();
      tx['instructionTemplate']!['findFirst']!.mockResolvedValue(tpl());
      tx['studentGroup']!['findFirst']!.mockResolvedValue(team);
      tx['studentGroupMember']!['findMany']!.mockResolvedValue([{ student: pupil('p-1', 'Anna', 'Andersson', '7A') }, { student: pupil('p-2', 'Bo', 'Berg', '7B') }]);
      tx['instructionProof']!['findMany']!.mockResolvedValue([proof({ studentId: 'p-2', instructorId: null, recordedById: null })]);
      const roster = await service.roster('t-1', 'g-2', admin);
      expect(roster.group).toEqual(team);
      expect(roster.rows.map((row) => [row.studentId, row.className, row.proofs.length])).toEqual([
        ['p-1', '7A', 0],
        ['p-2', '7B', 1],
      ]);
      expect(roster.done).toBe(1);
      expect(roster.pupils).toBe(2);
      expect(tx['studentGroupMember']!['findMany']).toHaveBeenCalledWith({
        where: { studentGroupId: 'g-2', student: { isActive: true, role: 'STUDENT' } },
        select: { student: { select: { id: true, firstName: true, lastName: true, studentGroup: { select: { name: true } } } } },
      });
      // Not as a class: the users are not read for members, and with no one to name, not for names either.
      expect(tx['user']!['findMany']).not.toHaveBeenCalled();
    });

    it('lets a teacher tick the pupils they teach and look at the ones they can see, and no others', async () => {
      const { tx, service } = setup();
      raw(tx, {
        'app.checklist_taught_ids()': [{ ids: ['p-1'] }],
        'app.checklist_visible_ids()': [{ ids: ['p-1', 'p-2'] }],
      });
      tx['instructionTemplate']!['findFirst']!.mockResolvedValue(tpl());
      tx['studentGroup']!['findFirst']!.mockResolvedValue(klass);
      directory(tx, [pupil('p-1', 'Anna', 'Andersson'), pupil('p-2', 'Bo', 'Berg'), pupil('p-3', 'Cia', 'Carlsson')]);
      const roster = await service.roster('t-1', 'g-1', teacher);
      expect(roster.rows.map((row) => [row.studentId, row.canTick])).toEqual([
        ['p-1', true],
        ['p-2', false],
      ]);
      expect(roster.pupils).toBe(2);
      // The proofs asked for and the read recorded are the visible pupils', not the class's.
      expect(tx['instructionProof']!['findMany']).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ studentId: { in: ['p-1', 'p-2'] } }) }));
      expect(readLogged(tx)).toEqual(['PEOPLE', null, ['p-1', 'p-2']]);
    });

    it('has nobody to show, and nobody to record, for a teacher who may see none of the class', async () => {
      const { tx, service } = setup();
      raw(tx, { 'app.checklist_taught_ids()': [{ ids: null }], 'app.checklist_visible_ids()': [] });
      tx['instructionTemplate']!['findFirst']!.mockResolvedValue(tpl());
      tx['studentGroup']!['findFirst']!.mockResolvedValue(klass);
      directory(tx, [pupil('p-1', 'Anna', 'Andersson')]);
      const roster = await service.roster('t-1', 'g-1', teacher);
      expect(roster).toMatchObject({ rows: [], done: 0, pupils: 0, heldOut: 0 });
      expect(readLogged(tx)).toBeNull();
    });

    describe('for paper', () => {
      /** Class 7A of four pupils, all with proofs but Bo; a teacher who teaches and sees Anna, Bo and Cia (not Dan). */
      function sheet(tx: TxMock, marked: string[]) {
        tx['instructionTemplate']!['findFirst']!.mockResolvedValue(tpl());
        tx['studentGroup']!['findFirst']!.mockResolvedValue(klass);
        directory(tx, [pupil('p-4', 'Dan', 'Dahl'), pupil('p-1', 'Anna', 'Andersson'), pupil('p-3', 'Cia', 'Carlsson'), pupil('p-2', 'Bo', 'Berg')]);
        tx['instructionProof']!['findMany']!.mockResolvedValue([
          proof({ id: 'pr-1', studentId: 'p-1' }),
          proof({ id: 'pr-3', studentId: 'p-3' }),
          proof({ id: 'pr-4', studentId: 'p-4' }),
        ]);
        raw(tx, {
          'app.checklist_taught_ids()': [{ ids: ['p-1', 'p-3'] }],
          'app.checklist_visible_ids()': [{ ids: ['p-1', 'p-2', 'p-3'] }],
          'app.checklist_protected_ids': [{ ids: marked }],
        });
      }
      const protectedQueries = (tx: TxMock) => tx.$queryRaw.mock.calls.filter((call) => sqlOf(call[0]).includes('app.checklist_protected_ids'));

      it('leaves nobody out when the database marks nobody, and asks it about all the pupils, in the order of the sheet', async () => {
        const { tx, service } = setup();
        sheet(tx, []);
        const roster = await service.roster('t-1', 'g-1', admin, true);
        expect(roster.rows.map((row) => row.studentId)).toEqual(['p-1', 'p-2', 'p-3', 'p-4']);
        expect(roster).toMatchObject({ done: 3, pupils: 4, heldOut: 0 });
        expect(protectedQueries(tx)).toHaveLength(1);
        expect(protectedQueries(tx)[0]!.slice(1)).toEqual([['p-1', 'p-2', 'p-3', 'p-4']]);
        expect(readLogged(tx)).toEqual(['PEOPLE', null, ['p-1', 'p-2', 'p-3', 'p-4']]);
      });

      it('leaves a marked pupil out of the rows and the counts, counts them in heldOut, and records the read of the pupils kept', async () => {
        const { tx, service } = setup();
        sheet(tx, ['p-1', 'p-4']);
        const roster = await service.roster('t-1', 'g-1', admin, true);
        expect(roster.rows.map((row) => row.studentId)).toEqual(['p-2', 'p-3']);
        // Anna and Dan had proofs, and are not counted in done: Cia has the one proof left.
        expect(roster).toMatchObject({ done: 1, pupils: 2, heldOut: 2 });
        expect(roster.rows.find((row) => row.studentId === 'p-3')!.proofs).toHaveLength(1);
        expect(JSON.stringify(roster)).not.toContain('Anna');
        expect(JSON.stringify(roster)).not.toContain('Dahl');
        expect(readLogged(tx)).toEqual(['PEOPLE', null, ['p-2', 'p-3']]);
      });

      it('shows nobody, counts nobody, and records no read when every pupil is marked', async () => {
        const { tx, service } = setup();
        sheet(tx, ['p-1', 'p-2', 'p-3', 'p-4']);
        const roster = await service.roster('t-1', 'g-1', admin, true);
        expect(roster).toMatchObject({ rows: [], done: 0, pupils: 0, heldOut: 4 });
        expect(roster.template.id).toBe('t-1');
        expect(roster.group).toEqual(klass);
        expect(readLogged(tx)).toBeNull();
      });

      it('holds out of a teacher’s sheet the marked among the pupils they can see, and counts only those', async () => {
        const { tx, service } = setup();
        // Dan is marked too, and is not one the teacher can see: he is not asked about, and is not counted.
        sheet(tx, ['p-2', 'p-4']);
        const roster = await service.roster('t-1', 'g-1', teacher, true);
        expect(protectedQueries(tx)[0]!.slice(1)).toEqual([['p-1', 'p-2', 'p-3']]);
        expect(roster.rows.map((row) => [row.studentId, row.canTick])).toEqual([
          ['p-1', true],
          ['p-3', true],
        ]);
        expect(roster).toMatchObject({ done: 2, pupils: 2, heldOut: 1 });
        expect(readLogged(tx)).toEqual(['PEOPLE', null, ['p-1', 'p-3']]);
      });

      it('asks nothing of the database about the marks when the sheet has no pupils', async () => {
        const { tx, service } = setup();
        sheet(tx, ['p-1']);
        directory(tx, []);
        const roster = await service.roster('t-1', 'g-1', admin, true);
        expect(roster).toMatchObject({ rows: [], done: 0, pupils: 0, heldOut: 0 });
        expect(protectedQueries(tx)).toHaveLength(0);
      });

      it('reads a missing answer as nobody marked', async () => {
        const { tx, service } = setup();
        sheet(tx, []);
        raw(tx, { 'app.checklist_protected_ids': [{ ids: null }] });
        expect((await service.roster('t-1', 'g-1', admin, true)).heldOut).toBe(0);
        raw(tx, {});
        expect((await service.roster('t-1', 'g-1', admin, true)).rows).toHaveLength(4);
      });

      it('holds out a pupil of a teaching group too', async () => {
        const { tx, service } = setup();
        sheet(tx, ['p-2']);
        tx['studentGroup']!['findFirst']!.mockResolvedValue(team);
        tx['studentGroupMember']!['findMany']!.mockResolvedValue([{ student: pupil('p-1', 'Anna', 'Andersson') }, { student: pupil('p-2', 'Bo', 'Berg') }]);
        const roster = await service.roster('t-1', 'g-2', admin, true);
        expect(roster.rows.map((row) => row.studentId)).toEqual(['p-1']);
        expect(roster.heldOut).toBe(1);
      });

      it('still answers 404 for a template or a group that is not the school’s, before it asks about any mark', async () => {
        const { tx, service } = setup();
        sheet(tx, ['p-1']);
        tx['instructionTemplate']!['findFirst']!.mockResolvedValue(null);
        await expect(service.roster('t-1', 'g-1', admin, true)).rejects.toMatchObject({ status: 404, response: { code: 'CHECKLIST_NOT_FOUND' } });
        expect(protectedQueries(tx)).toHaveLength(0);
      });

      it('is not what the screen answers: the screen shows the marked pupil, says heldOut 0 and does not ask about the marks', async () => {
        const { tx, service } = setup();
        sheet(tx, ['p-1', 'p-2']);
        for (const as of [admin, teacher]) {
          tx.$queryRaw.mockClear();
          const screen = await service.roster('t-1', 'g-1', as);
          expect(screen.rows.some((row) => row.studentId === 'p-1')).toBe(true);
          expect(screen.heldOut).toBe(0);
          expect(rawSql(tx).some((sql) => sql.includes('app.checklist_protected_ids'))).toBe(false);
          const explicit = await service.roster('t-1', 'g-1', as, false);
          expect(explicit.rows).toEqual(screen.rows);
          expect(rawSql(tx).some((sql) => sql.includes('app.checklist_protected_ids'))).toBe(false);
        }
      });
    });
  });

  describe('tick', () => {
    beforeEach(() => {
      jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    const dto = { templateId: 't-1', studentIds: ['p-1', 'p-2'] };

    function ready(tx: TxMock, over: { template?: unknown; pupils?: string[]; had?: string[]; timezone?: string | null } = {}) {
      tx['instructionTemplate']!['findFirst']!.mockResolvedValue(over.template === undefined ? tpl() : over.template);
      tx['school']!['findUnique']!.mockResolvedValue(over.timezone === null ? null : { timezone: over.timezone ?? 'Europe/Stockholm' });
      tx['user']!['findMany']!.mockResolvedValue((over.pupils ?? ['p-1', 'p-2']).map((id) => ({ id })));
      tx['instructionProof']!['findMany']!.mockResolvedValue((over.had ?? []).map((studentId) => ({ studentId })));
      tx['instructionProof']!['createMany']!.mockImplementation(async ({ data }: { data: unknown[] }) => ({ count: data.length }));
    }

    it('ticks the pupils for today in the school’s day, and counts nobody as already ticked', async () => {
      const { tx, service } = setup();
      ready(tx);
      expect(await service.tick(dto, admin)).toEqual({ written: 2, already: 0 });
      expect(tx['instructionProof']!['createMany']).toHaveBeenCalledWith({
        data: [
          { schoolId: 'school-1', templateId: 't-1', studentId: 'p-1', instructedOn: new Date('2026-11-07T00:00:00.000Z'), instructorId: null, note: null },
          { schoolId: 'school-1', templateId: 't-1', studentId: 'p-2', instructedOn: new Date('2026-11-07T00:00:00.000Z'), instructorId: null, note: null },
        ],
        skipDuplicates: true,
      });
      expect(tx['instructionTemplate']!['findFirst']).toHaveBeenCalledWith({ where: { id: 't-1', schoolId: 'school-1' } });
      expect(tx['user']!['findMany']).toHaveBeenCalledWith({ where: { id: { in: ['p-1', 'p-2'] }, schoolId: 'school-1', role: 'STUDENT', isActive: true }, select: { id: true } });
      expect(tx['instructionProof']!['findMany']).toHaveBeenCalledWith({
        where: { schoolId: 'school-1', templateId: 't-1', studentId: { in: ['p-1', 'p-2'] }, instructedOn: new Date('2026-11-07T00:00:00.000Z'), voidedAt: null },
        select: { studentId: true },
      });
      // An administrator is asked nothing of the id lists; a tick is not a read.
      expect(tx.$queryRaw).not.toHaveBeenCalled();
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('takes today in the school’s zone and not the server’s: a minute past midnight there is already tomorrow', async () => {
      const { tx, service } = setup();
      jest.setSystemTime(new Date('2026-11-07T23:30:00Z'));
      ready(tx, { timezone: 'Europe/Stockholm' });
      await service.tick({ ...dto, instructedOn: '2026-11-08' }, admin);
      expect(tx['instructionProof']!['createMany']!.mock.calls[0]![0].data[0].instructedOn).toEqual(new Date('2026-11-08T00:00:00.000Z'));
      // The same instant is still the 7th in New York, so the 8th has not come there.
      ready(tx, { timezone: 'America/New_York' });
      await expect(service.tick({ ...dto, instructedOn: '2026-11-08' }, admin)).rejects.toMatchObject({ status: 422, response: { code: 'CHECKLIST_DATE_IN_THE_FUTURE' } });
      await service.tick(dto, admin);
      expect(tx['instructionProof']!['createMany']!.mock.calls[1]![0].data[0].instructedOn).toEqual(new Date('2026-11-07T00:00:00.000Z'));
    });

    it('takes Stockholm’s day for a school with no row to say its zone', async () => {
      const { tx, service } = setup();
      jest.setSystemTime(new Date('2026-11-07T23:30:00Z'));
      ready(tx, { timezone: null });
      await service.tick(dto, admin);
      expect(tx['instructionProof']!['createMany']!.mock.calls[0]![0].data[0].instructedOn).toEqual(new Date('2026-11-08T00:00:00.000Z'));
    });

    it('ticks for an earlier day, with who gave the instruction and a note', async () => {
      const { tx, service } = setup();
      ready(tx);
      await service.tick({ ...dto, instructedOn: '2026-10-01', instructorId: 'u-2', note: 'Cirkelsågen, grupp 2' }, admin);
      const { data } = tx['instructionProof']!['createMany']!.mock.calls[0]![0];
      expect(data).toHaveLength(2);
      expect(data[0]).toMatchObject({ instructedOn: new Date('2026-10-01T00:00:00.000Z'), instructorId: 'u-2', note: 'Cirkelsågen, grupp 2' });
      expect(data[1]).toMatchObject({ instructedOn: new Date('2026-10-01T00:00:00.000Z'), instructorId: 'u-2', note: 'Cirkelsågen, grupp 2' });
    });

    it('accepts today named, and refuses tomorrow with 422 CHECKLIST_DATE_IN_THE_FUTURE', async () => {
      const { tx, service } = setup();
      ready(tx);
      await expect(service.tick({ ...dto, instructedOn: '2026-11-07' }, admin)).resolves.toEqual({ written: 2, already: 0 });
      const error = await service.tick({ ...dto, instructedOn: '2026-11-08' }, admin).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(error).toMatchObject({ response: { code: 'CHECKLIST_DATE_IN_THE_FUTURE', message: 'Datumet har inte kommit.' } });
      expect(tx['instructionProof']!['createMany']).toHaveBeenCalledTimes(1);
    });

    it.each(['2026-02-30', '2026-13-45', '2026-00-10', '2026-04-31', '2026-02-29'])('refuses the day %s, which does not exist', async (day) => {
      const { tx, service } = setup();
      ready(tx);
      const error = await service.tick({ ...dto, instructedOn: day }, admin).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(error).toMatchObject({ response: { code: 'CHECKLIST_DATE_INVALID', message: 'Datumet finns inte.' } });
      expect(tx['instructionProof']!['createMany']).not.toHaveBeenCalled();
    });

    it('answers 404 for a template that is not the school’s', async () => {
      const { tx, service } = setup();
      ready(tx, { template: null });
      await expect(service.tick(dto, admin)).rejects.toMatchObject({ status: 404, response: { code: 'CHECKLIST_NOT_FOUND' } });
      expect(tx['instructionProof']!['createMany']).not.toHaveBeenCalled();
    });

    it('answers 409 CHECKLIST_TEMPLATE_RETIRED for a retired template, before it looks at anything else', async () => {
      const { tx, service } = setup();
      ready(tx, { template: tpl({ active: false }) });
      const error = await service.tick(dto, admin).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error).toMatchObject({ response: { code: 'CHECKLIST_TEMPLATE_RETIRED', message: 'Mallen är avvecklad. Ta fram den igen för att bocka av i den.' } });
      expect(tx['school']!['findUnique']).not.toHaveBeenCalled();
      expect(tx['instructionProof']!['createMany']).not.toHaveBeenCalled();
    });

    it('answers 422 CHECKLIST_UNKNOWN_PUPIL when a pupil is not an active pupil of the school', async () => {
      const { tx, service } = setup();
      ready(tx, { pupils: ['p-1'] });
      const error = await service.tick(dto, admin).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(error).toMatchObject({ response: { code: 'CHECKLIST_UNKNOWN_PUPIL' } });
      expect(tx['instructionProof']!['createMany']).not.toHaveBeenCalled();
    });

    it('counts a pupil named twice once', async () => {
      const { tx, service } = setup();
      ready(tx);
      expect(await service.tick({ ...dto, studentIds: ['p-1', 'p-2', 'p-1', 'p-2', 'p-2'] }, admin)).toEqual({ written: 2, already: 0 });
      expect(tx['user']!['findMany']).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { in: ['p-1', 'p-2'] } }) }));
      expect(tx['instructionProof']!['createMany']!.mock.calls[0]![0].data).toHaveLength(2);
    });

    it('lets a teacher tick pupils of their own groups and lessons', async () => {
      const { tx, service } = setup();
      ready(tx);
      raw(tx, { 'app.checklist_taught_ids()': [{ ids: ['p-1', 'p-2', 'p-9'] }] });
      expect(await service.tick(dto, teacher)).toEqual({ written: 2, already: 0 });
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('refuses a teacher a pupil they do not teach with 403 CHECKLIST_NOT_YOUR_PUPIL, and writes nobody', async () => {
      const { tx, service } = setup();
      ready(tx);
      raw(tx, { 'app.checklist_taught_ids()': [{ ids: ['p-1'] }] });
      const error = await service.tick(dto, teacher).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error).toMatchObject({ response: { code: 'CHECKLIST_NOT_YOUR_PUPIL' } });
      expect(tx['instructionProof']!['createMany']).not.toHaveBeenCalled();
      // A teacher who teaches nobody (no answer at all) is refused the same.
      raw(tx, {});
      await expect(service.tick(dto, teacher)).rejects.toMatchObject({ response: { code: 'CHECKLIST_NOT_YOUR_PUPIL' } });
    });

    it('counts a pupil who already has a proof for the day, and writes only the others', async () => {
      const { tx, service } = setup();
      ready(tx, { had: ['p-1'] });
      expect(await service.tick(dto, admin)).toEqual({ written: 1, already: 1 });
      const { data } = tx['instructionProof']!['createMany']!.mock.calls[0]![0];
      expect(data.map((row: { studentId: string }) => row.studentId)).toEqual(['p-2']);
    });

    it('writes nothing, and says so, when every pupil already has one', async () => {
      const { tx, service } = setup();
      ready(tx, { had: ['p-1', 'p-2'] });
      expect(await service.tick(dto, admin)).toEqual({ written: 0, already: 2 });
      expect(tx['instructionProof']!['createMany']).not.toHaveBeenCalled();
    });

    it('counts, as already, a pupil another tick wrote while this one ran (skipDuplicates dropped the row)', async () => {
      const { tx, service } = setup();
      ready(tx);
      tx['instructionProof']!['createMany']!.mockResolvedValue({ count: 1 });
      expect(await service.tick(dto, admin)).toEqual({ written: 1, already: 1 });
    });

    it.each([
      ['CL422', 'CHECKLIST_INSTRUCTOR_IS_NOT_STAFF', 422, 'CHECKLIST_INSTRUCTOR_IS_NOT_STAFF'],
      ['CL422', 'CHECKLIST_DATE_IN_THE_FUTURE', 422, 'CHECKLIST_DATE_IN_THE_FUTURE'],
      ['CL422', 'CHECKLIST_NOT_A_PUPIL', 422, 'CHECKLIST_UNKNOWN_PUPIL'],
      ['CL409', 'CHECKLIST_TEMPLATE_RETIRED', 409, 'CHECKLIST_TEMPLATE_RETIRED'],
      ['CL403', 'CHECKLIST_NOT_STAFF', 403, 'CHECKLIST_NOT_STAFF'],
    ])('answers the database’s %s (%s) when the insert is refused as %i %s', async (state, name, status, code) => {
      const { tx, service } = setup();
      ready(tx);
      tx['instructionProof']!['createMany']!.mockRejectedValue(refusal(state, name));
      await expect(service.tick({ ...dto, instructorId: 'u-x' }, admin)).rejects.toMatchObject({ status, response: { code } });
    });

    it('lets an error that is not ours through', async () => {
      const { tx, service } = setup();
      ready(tx);
      const other = new Error('connection reset');
      tx['instructionProof']!['createMany']!.mockRejectedValue(other);
      await expect(service.tick(dto, admin)).rejects.toBe(other);
    });

    it('refuses a login with no school', async () => {
      const { service } = setup();
      await expect(service.tick(dto, testUser({ schoolId: undefined }))).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('voidProof', () => {
    it('voids the tick with the reason, and answers the time the database gave', async () => {
      const { tx, service } = setup();
      raw(tx, { 'app.checklist_void_proof': [{ at: new Date('2026-11-07T10:00:00Z') }] });
      expect(await service.voidProof('pr-1', { reason: 'Fel elev' }, teacher)).toEqual({ voidedAt: '2026-11-07T10:00:00.000Z' });
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      expect(tx.$queryRaw.mock.calls[0]!.slice(1)).toEqual(['pr-1', 'Fel elev']);
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it.each([
      ['CL403', 403, 'CHECKLIST_NOT_STAFF'],
      ['CL404', 404, 'CHECKLIST_NOT_FOUND'],
      ['CL422', 422, 'CHECKLIST_REASON_NEEDED'],
    ])('answers the database’s %s as %i %s', async (state, status, code) => {
      const { tx, service } = setup();
      tx.$queryRaw.mockRejectedValue(refusal(state, code));
      await expect(service.voidProof('pr-1', { reason: 'x' }, admin)).rejects.toMatchObject({ status, response: { code } });
    });

    it('lets an error that is not ours through', async () => {
      const { tx, service } = setup();
      const other = new Error('connection reset');
      tx.$queryRaw.mockRejectedValue(other);
      await expect(service.voidProof('pr-1', { reason: 'x' }, admin)).rejects.toBe(other);
    });
  });
});
