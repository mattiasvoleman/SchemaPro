import { ConflictException, ForbiddenException, HttpException, HttpStatus, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createPrismaMock, createTxMock, testUser, type TxMock } from '../../test/utils/prisma-mock';
import type { AckService } from '../ack/ack.service';
import type { PrismaService } from '../database/prisma.service';
import { CONSENT_FOOTER, TITLE_MAX } from './checklists';
import { ConsentService } from './consent.service';

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

/** What the database's functions say by default: Kvittens on, a teacher who sees and mentors nobody, no request asked. */
function answers(tx: TxMock, over: Record<string, unknown> = {}): void {
  raw(tx, {
    'app.ack_enabled()': [{ on: true }],
    'app.checklist_visible_ids()': [{ ids: [] }],
    'app.ack_mentee_ids()': [{ ids: [] }],
    ...over,
  });
}

/** The SQL of every raw read the service has made. */
const rawSql = (tx: TxMock): string[] => tx.$queryRaw.mock.calls.map((call) => sqlOf(call[0]));

function setup() {
  const tx = createTxMock();
  const prisma = createPrismaMock(tx);
  const ack = { createThen: jest.fn() };
  const service = new ConsentService(prisma as unknown as PrismaService, ack as unknown as AckService);
  return { tx, prisma, ack, service };
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

// ---------------------------------------------------------------------------
// The school, in memory

interface Person {
  id: string;
  firstName: string;
  lastName: string;
  schoolId: string;
  role: string;
  isActive: boolean;
  studentGroupId: string | null;
  studentGroup: { name: string } | null;
}

const person = (id: string, firstName: string, lastName: string, over: Partial<Person> = {}): Person => ({
  id,
  firstName,
  lastName,
  schoolId: 'school-1',
  role: 'STUDENT',
  isActive: true,
  studentGroupId: 'c-1',
  studentGroup: { name: '7A' },
  ...over,
});

const staff = (id: string, firstName: string, lastName: string, role = 'TEACHER'): Person =>
  person(id, firstName, lastName, { role, studentGroupId: null, studentGroup: null });

type Cond = string | boolean | null | { in?: string[]; not?: null };

function matches(row: Record<string, unknown>, where: Record<string, Cond>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key];
    if (cond !== null && typeof cond === 'object') {
      if ('in' in cond) return cond.in!.includes(value as string);
      if ('not' in cond) return value !== cond.not;
      throw new Error(`The fake school cannot answer a condition on ${key}`);
    }
    return value === cond;
  });
}

/** Users, as findMany and findFirst find them: by the conditions the service puts in `where`. */
function directory(tx: TxMock, people: Person[]): void {
  tx['user']!['findMany']!.mockImplementation(async ({ where }: { where: Record<string, Cond> }) => people.filter((p) => matches(p as never, where)));
  tx['user']!['findFirst']!.mockImplementation(async ({ where }: { where: Record<string, Cond> }) => people.find((p) => matches(p as never, where)) ?? null);
}

const listRow = (over: Record<string, unknown> = {}) => ({
  id: 'l-1',
  schoolId: 'school-1',
  studentGroupId: 'c-1' as string | null,
  groupName: '7A',
  title: 'Fotografering',
  body: 'Vi får fotografera i skolans kanaler.',
  createdById: 'admin-1' as string | null,
  createdAt: new Date('2026-10-01T08:00:00Z'),
  closedAt: null as Date | null,
  ...over,
});

const entry = (id: string, studentId: string, kind: 'GRANTED' | 'DECLINED' | 'WITHDRAWN', recordedAt: string, over: Record<string, unknown> = {}) => ({
  id,
  schoolId: 'school-1',
  listId: 'l-1',
  studentId,
  kind,
  source: 'REGISTERED' as 'REGISTERED' | 'KVITTENS',
  givenOn: new Date('2026-10-02T00:00:00Z'),
  givenBy: 'Vårdnadshavaren' as string | null,
  note: null as string | null,
  ackRequestId: null,
  recordedById: 'admin-1' as string | null,
  recordedAt: new Date(recordedAt),
  ...over,
});

const askRow = (ackRequestId: string, createdAt: string, over: Record<string, unknown> = {}) => ({ ackRequestId, schoolId: 'school-1', listId: 'l-1', createdAt: new Date(createdAt), ...over });
const status = (request: string, student: string, over: Record<string, unknown> = {}) => ({ request_id: request, student_id: student, asked: 2, acked: 1, waiting: 1, met: false, ...over });

/** The exact SQL values of the read-log statement that was run, or null when none was. */
function readLogged(tx: TxMock): unknown[] | null {
  const calls = tx.$executeRaw.mock.calls;
  expect(calls.length).toBeLessThanOrEqual(1);
  return calls.length === 0 ? null : (calls[0]![0] as { values: unknown[] }).values;
}

/**
 * Class 7A, c-1, with the pupils of every case:
 *   p-1 Andersson  GRANTED, after having been taken back (three answers, written out of order)
 *   p-2 Berg       nothing, and not asked
 *   p-3 Carlsson   WITHDRAWN, and asked again since (req-1 waits)
 *   p-4 Dahl       DECLINED
 *   p-5 Ek         nothing, and not asked
 *   p-6 Falk       moved to 7B (c-2) but GRANTED on this list, by a Kvittens confirmation
 *   p-7 Grahn      left the school, GRANTED
 * and the staff who wrote them.
 */
function school(tx: TxMock) {
  const people = [
    person('p-1', 'Anna', 'Andersson'),
    person('p-2', 'Bo', 'Berg'),
    person('p-3', 'Cia', 'Carlsson'),
    person('p-4', 'Dan', 'Dahl'),
    person('p-5', 'Eva', 'Ek'),
    person('p-6', 'Fia', 'Falk', { studentGroupId: 'c-2', studentGroup: { name: '7B' } }),
    person('p-7', 'Gus', 'Grahn', { isActive: false }),
    staff('admin-1', 'Ada', 'Rektor', 'SCHOOL_ADMIN'),
    staff('teacher-1', 'Tora', 'Lind'),
  ];
  directory(tx, people);
  tx['consentList']!['findFirst']!.mockResolvedValue(listRow());
  tx['consentEntry']!['findMany']!.mockResolvedValue([
    entry('e-1c', 'p-1', 'GRANTED', '2026-10-06T08:00:00Z', { recordedById: 'teacher-1', givenBy: 'Mamma', note: 'Ringde' }),
    entry('e-1a', 'p-1', 'GRANTED', '2026-10-02T08:00:00Z'),
    entry('e-3', 'p-3', 'WITHDRAWN', '2026-10-03T08:00:00Z'),
    entry('e-4', 'p-4', 'DECLINED', '2026-10-03T09:00:00Z'),
    entry('e-1b', 'p-1', 'WITHDRAWN', '2026-10-04T08:00:00Z'),
    entry('e-6', 'p-6', 'GRANTED', '2026-10-05T08:00:00Z', { source: 'KVITTENS', recordedById: null, givenBy: null }),
    entry('e-7', 'p-7', 'GRANTED', '2026-10-02T09:00:00Z'),
  ]);
  tx['consentAsk']!['findMany']!.mockResolvedValue([askRow('req-1', '2026-10-05T10:00:00Z')]);
  answers(tx, { 'app.ack_status': [status('req-1', 'p-3', { asked: 2, waiting: 1 })] });
}

describe('ConsentService', () => {
  describe('settings', () => {
    it('says whether the school has Kvittens on', async () => {
      const { tx, service } = setup();
      answers(tx);
      expect(await service.settings(teacher)).toEqual({ kvittens: true });
      answers(tx, { 'app.ack_enabled()': [{ on: false }] });
      expect(await service.settings(admin)).toEqual({ kvittens: false });
    });

    it('says off when the database says nothing, or null', async () => {
      const { tx, service } = setup();
      raw(tx, {});
      expect(await service.settings(admin)).toEqual({ kvittens: false });
      answers(tx, { 'app.ack_enabled()': [{ on: null }] });
      expect(await service.settings(admin)).toEqual({ kvittens: false });
    });
  });

  describe('lists', () => {
    it('lists the open lists of the school, newest first, with a count of each state, and records no read', async () => {
      const { tx, service } = setup();
      school(tx);
      tx['consentList']!['findMany']!.mockResolvedValue([listRow()]);
      const items = await service.lists(admin);
      expect(items).toEqual([
        {
          id: 'l-1',
          title: 'Fotografering',
          classId: 'c-1',
          className: '7A',
          createdAt: '2026-10-01T08:00:00.000Z',
          createdByName: 'Ada Rektor',
          closedAt: null,
          counts: { pupils: 7, granted: 3, declined: 1, withdrawn: 0, asked: 1, missing: 2 },
        },
      ]);
      expect(tx['consentList']!['findMany']).toHaveBeenCalledWith({ where: { schoolId: 'school-1', closedAt: null }, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('narrows to a class, and takes the closed lists too when asked to', async () => {
      const { tx, service } = setup();
      await service.lists(admin, { classId: 'c-1' });
      expect(tx['consentList']!['findMany']).toHaveBeenLastCalledWith(expect.objectContaining({ where: { schoolId: 'school-1', studentGroupId: 'c-1', closedAt: null } }));
      await service.lists(admin, { includeClosed: true });
      expect(tx['consentList']!['findMany']).toHaveBeenLastCalledWith(expect.objectContaining({ where: { schoolId: 'school-1' } }));
      await service.lists(admin, { classId: 'c-2', includeClosed: true });
      expect(tx['consentList']!['findMany']).toHaveBeenLastCalledWith(expect.objectContaining({ where: { schoolId: 'school-1', studentGroupId: 'c-2' } }));
      await service.lists(admin, { includeClosed: false });
      expect(tx['consentList']!['findMany']).toHaveBeenLastCalledWith(expect.objectContaining({ where: { schoolId: 'school-1', closedAt: null } }));
    });

    it('asks nothing about pupils when there is no list', async () => {
      const { tx, service } = setup();
      expect(await service.lists(admin)).toEqual([]);
      expect(tx['consentEntry']!['findMany']).not.toHaveBeenCalled();
      expect(tx['consentAsk']!['findMany']).not.toHaveBeenCalled();
      expect(tx['user']!['findMany']).not.toHaveBeenCalled();
    });

    it('counts each list by its own answers: a pupil who has answered on one list is missing on the other', async () => {
      const { tx, service } = setup();
      school(tx);
      const second = listRow({ id: 'l-2', studentGroupId: 'c-2', groupName: '7B', title: 'Utflykt', createdById: null, closedAt: new Date('2026-10-20T12:00:00Z') });
      tx['consentList']!['findMany']!.mockResolvedValue([listRow(), second]);
      const [first, other] = await service.lists(admin, { includeClosed: true });
      expect(first!.counts.pupils).toBe(7);
      // p-6 is in 7B now, and has answered on the list of 7A, not on this one.
      expect(other).toMatchObject({
        id: 'l-2',
        classId: 'c-2',
        className: '7B',
        createdByName: null,
        closedAt: '2026-10-20T12:00:00.000Z',
        counts: { pupils: 1, granted: 0, declined: 0, withdrawn: 0, asked: 0, missing: 1 },
      });
    });

    it('names a list whose class has been removed by its stamped name, with no class id', async () => {
      const { tx, service } = setup();
      school(tx);
      tx['consentList']!['findMany']!.mockResolvedValue([listRow({ studentGroupId: null, createdById: 'u-gone' })]);
      const [item] = await service.lists(admin);
      expect(item).toMatchObject({ classId: null, className: '7A', createdByName: null });
    });

    it('counts only the pupils a teacher can see', async () => {
      const { tx, service } = setup();
      school(tx);
      answers(tx, { 'app.checklist_visible_ids()': [{ ids: ['p-1', 'p-2'] }], 'app.ack_status': [status('req-1', 'p-3')] });
      tx['consentList']!['findMany']!.mockResolvedValue([listRow()]);
      const [item] = await service.lists(teacher);
      expect(item!.counts).toEqual({ pupils: 2, granted: 1, declined: 0, withdrawn: 0, asked: 0, missing: 1 });
    });

    it('refuses a login with no school', async () => {
      const { service } = setup();
      await expect(service.lists(testUser({ schoolId: undefined }))).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('createList', () => {
    const dto = { classId: 'c-1', title: 'Fotografering', body: 'Vi får fotografera.' };

    it('makes a list for a class of the school, with the class’s pupils counted as missing', async () => {
      const { tx, service } = setup();
      directory(tx, [person('p-1', 'Anna', 'Andersson'), person('p-2', 'Bo', 'Berg'), staff('admin-1', 'Ada', 'Rektor', 'SCHOOL_ADMIN')]);
      tx['studentGroup']!['findFirst']!.mockResolvedValue({ id: 'c-1' });
      tx['consentList']!['create']!.mockResolvedValue(listRow({ body: dto.body }));
      answers(tx);
      const item = await service.createList(dto, admin);
      expect(item).toEqual({
        id: 'l-1',
        title: 'Fotografering',
        classId: 'c-1',
        className: '7A',
        createdAt: '2026-10-01T08:00:00.000Z',
        createdByName: 'Ada Rektor',
        closedAt: null,
        counts: { pupils: 2, granted: 0, declined: 0, withdrawn: 0, asked: 0, missing: 2 },
      });
      expect(tx['studentGroup']!['findFirst']).toHaveBeenCalledWith({ where: { id: 'c-1', schoolId: 'school-1', kind: 'CLASS' }, select: { id: true } });
      expect(tx['consentList']!['create']).toHaveBeenCalledWith({ data: { schoolId: 'school-1', studentGroupId: 'c-1', title: 'Fotografering', body: 'Vi får fotografera.' } });
      expect(tx.$executeRaw).not.toHaveBeenCalled();
      // An administrator is asked nothing of the mentors' classes.
      expect(rawSql(tx).some((sql) => sql.includes('checklist_mentee_class_ids'))).toBe(false);
    });

    describe('for a teacher', () => {
      function mentoring(tx: TxMock, classes: unknown) {
        directory(tx, [person('p-1', 'Anna', 'Andersson'), person('p-2', 'Bo', 'Berg'), staff('teacher-1', 'Tora', 'Lind')]);
        tx['studentGroup']!['findFirst']!.mockResolvedValue({ id: 'c-1' });
        tx['consentList']!['create']!.mockResolvedValue(listRow({ body: dto.body, createdById: 'teacher-1' }));
        answers(tx, {
          'app.checklist_mentee_class_ids': classes,
          'app.checklist_visible_ids()': [{ ids: ['p-1', 'p-2'] }],
          'app.ack_mentee_ids()': [{ ids: ['p-1'] }],
        });
      }

      it('makes a list for a class they have a mentee in, asking the database which classes those are', async () => {
        const { tx, service } = setup();
        mentoring(tx, [{ ids: ['c-9', 'c-1'] }]);
        const item = await service.createList(dto, teacher);
        expect(item).toMatchObject({ id: 'l-1', classId: 'c-1', createdByName: 'Tora Lind', counts: { pupils: 2, missing: 2 } });
        expect(tx['consentList']!['create']).toHaveBeenCalledWith({ data: { schoolId: 'school-1', studentGroupId: 'c-1', title: 'Fotografering', body: 'Vi får fotografera.' } });
        expect(rawSql(tx).filter((sql) => sql.includes('checklist_mentee_class_ids'))).toHaveLength(1);
      });

      it.each([
        ['a class they have no mentee in', [{ ids: ['c-9'] }]],
        ['no class at all', [{ ids: [] }]],
        ['an answer of null', [{ ids: null }]],
        ['no answer', []],
      ])('answers 403 CONSENT_NOT_YOUR_CLASS for %s, and writes nothing', async (_label, classes) => {
        const { tx, service } = setup();
        mentoring(tx, classes);
        const error = await service.createList(dto, teacher).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ForbiddenException);
        expect(error).toMatchObject({ response: { code: 'CONSENT_NOT_YOUR_CLASS', message: 'Du kan bara göra samtyckeslistor för klasser du är mentor för.' } });
        expect(tx['consentList']!['create']).not.toHaveBeenCalled();
      });

      it('answers 422 CONSENT_NOT_A_CLASS first for a group that is not a class, and asks nothing of the mentors’ classes', async () => {
        const { tx, service } = setup();
        mentoring(tx, [{ ids: ['c-1'] }]);
        tx['studentGroup']!['findFirst']!.mockResolvedValue(null);
        await expect(service.createList(dto, teacher)).rejects.toMatchObject({ status: 422, response: { code: 'CONSENT_NOT_A_CLASS' } });
        expect(rawSql(tx).some((sql) => sql.includes('checklist_mentee_class_ids'))).toBe(false);
      });

      it('is asked for the class the database found, not the one the request named', async () => {
        const { tx, service } = setup();
        mentoring(tx, [{ ids: ['c-2'] }]);
        tx['studentGroup']!['findFirst']!.mockResolvedValue({ id: 'c-2' });
        tx['consentList']!['create']!.mockResolvedValue(listRow({ studentGroupId: 'c-2' }));
        await service.createList(dto, teacher);
        expect(tx['consentList']!['create']).toHaveBeenCalledWith({ data: expect.objectContaining({ studentGroupId: 'c-2' }) });
      });
    });

    it('answers 422 CONSENT_NOT_A_CLASS for a group that is not a class of the school, and writes nothing', async () => {
      const { tx, service } = setup();
      tx['studentGroup']!['findFirst']!.mockResolvedValue(null);
      const error = await service.createList(dto, admin).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(error).toMatchObject({ response: { code: 'CONSENT_NOT_A_CLASS', message: 'Klassen finns inte i skolan.' } });
      expect(tx['consentList']!['create']).not.toHaveBeenCalled();
    });

    it('answers a second open list of that name for the class as 409 CONSENT_LIST_EXISTS', async () => {
      const { tx, service } = setup();
      tx['studentGroup']!['findFirst']!.mockResolvedValue({ id: 'c-1' });
      tx['consentList']!['create']!.mockRejectedValue(known('P2002'));
      const error = await service.createList(dto, admin).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error).toMatchObject({ response: { code: 'CONSENT_LIST_EXISTS', message: 'Klassen har redan en öppen lista med det namnet.' } });
    });

    it('answers the database’s own refusals with their codes, and lets any other error through', async () => {
      const { tx, service } = setup();
      tx['studentGroup']!['findFirst']!.mockResolvedValue({ id: 'c-1' });
      answers(tx, { 'app.checklist_mentee_class_ids': [{ ids: ['c-1'] }] });
      tx['consentList']!['create']!.mockRejectedValue(refusal('CL422', 'CONSENT_NOT_A_CLASS'));
      await expect(service.createList(dto, admin)).rejects.toMatchObject({ status: 422, response: { code: 'CONSENT_NOT_A_CLASS' } });
      tx['consentList']!['create']!.mockRejectedValue(refusal('CL403', 'CHECKLIST_NOT_STAFF'));
      await expect(service.createList(dto, teacher)).rejects.toMatchObject({ status: 403, response: { code: 'CHECKLIST_NOT_STAFF' } });
      // A foreign-key refusal is not one of this service's to name.
      const fk = known('P2003');
      tx['consentList']!['create']!.mockRejectedValue(fk);
      await expect(service.createList(dto, admin)).rejects.toBe(fk);
    });

    it('refuses a login with no school before it touches the database', async () => {
      const { tx, service } = setup();
      await expect(service.createList(dto, testUser({ schoolId: undefined }))).rejects.toBeInstanceOf(ForbiddenException);
      expect(tx['consentList']!['create']).not.toHaveBeenCalled();
    });
  });

  describe('detail', () => {
    it('answers 404 for a list that is not the school’s', async () => {
      const { tx, service } = setup();
      tx['consentList']!['findFirst']!.mockResolvedValue(null);
      const error = await service.detail('l-x', admin).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      expect(error).toMatchObject({ response: { code: 'CHECKLIST_NOT_FOUND' } });
      expect(tx['consentList']!['findFirst']).toHaveBeenCalledWith({ where: { id: 'l-x', schoolId: 'school-1' } });
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('shows an administrator every pupil of the class and every pupil with an answer, by name, and where each stands', async () => {
      const { tx, service } = setup();
      school(tx);
      const detail = await service.detail('l-1', admin);

      expect(detail.list).toEqual({
        id: 'l-1',
        title: 'Fotografering',
        body: 'Vi får fotografera i skolans kanaler.',
        classId: 'c-1',
        className: '7A',
        createdAt: '2026-10-01T08:00:00.000Z',
        createdByName: 'Ada Rektor',
        closedAt: null,
        counts: { pupils: 7, granted: 3, declined: 1, withdrawn: 0, asked: 1, missing: 2 },
      });
      expect(detail.kvittens).toBe(true);
      expect(detail.canClose).toBe(true);
      // The screen holds nobody out, and does not ask the database who is marked.
      expect(detail.heldOut).toBe(0);
      expect(rawSql(tx).some((sql) => sql.includes('app.checklist_protected_ids'))).toBe(false);
      expect(detail.rows.map((row) => [row.studentId, row.name, row.state, row.inClass, row.canWrite])).toEqual([
        ['p-1', 'Anna Andersson', 'GRANTED', true, true],
        ['p-2', 'Bo Berg', 'MISSING', true, true],
        ['p-3', 'Cia Carlsson', 'ASKED', true, true],
        ['p-4', 'Dan Dahl', 'DECLINED', true, true],
        ['p-5', 'Eva Ek', 'MISSING', true, true],
        // Moved to another class: still on the list, no longer in its class.
        ['p-6', 'Fia Falk', 'GRANTED', false, true],
        // Left the school: still on the list, and nothing can be written for them.
        ['p-7', 'Gus Grahn', 'GRANTED', false, false],
      ]);
      expect(detail.rows.map((row) => row.className)).toEqual(['7A', '7A', '7A', '7A', '7A', '7B', '7A']);
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(readLogged(tx)).toEqual(['PEOPLE', null, ['p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6', 'p-7']]);
      // An administrator is asked nothing of the id lists; the pupils are the class's and those with an answer.
      expect(rawSql(tx).some((sql) => sql.includes('checklist_visible_ids') || sql.includes('ack_mentee_ids'))).toBe(false);
    });

    it('gives the answer that decides and the whole history, the latest first, whatever order the answers came in', async () => {
      const { tx, service } = setup();
      school(tx);
      const { rows } = await service.detail('l-1', admin);
      const anna = rows.find((row) => row.studentId === 'p-1')!;
      expect(anna.history.map((e) => [e.id, e.kind])).toEqual([
        ['e-1c', 'GRANTED'],
        ['e-1b', 'WITHDRAWN'],
        ['e-1a', 'GRANTED'],
      ]);
      expect(anna.entry).toEqual({
        id: 'e-1c',
        kind: 'GRANTED',
        source: 'REGISTERED',
        givenOn: '2026-10-02',
        givenBy: 'Mamma',
        note: 'Ringde',
        recordedByName: 'Tora Lind',
        recordedAt: '2026-10-06T08:00:00.000Z',
      });
      expect(anna.entry).toEqual(anna.history[0]);
      expect(anna.ask).toBeNull();
      // A confirmation in the app has no writer.
      const fia = rows.find((row) => row.studentId === 'p-6')!;
      expect(fia.entry).toMatchObject({ source: 'KVITTENS', recordedByName: null, givenBy: null });
      // Nobody has answered for Bo: no answer, no history, no request.
      expect(rows.find((row) => row.studentId === 'p-2')).toMatchObject({ state: 'MISSING', entry: null, history: [], ask: null });
    });

    it('says ASKED, with how many guardians were asked and how many wait, while a request made after the latest answer waits', async () => {
      const { tx, service } = setup();
      school(tx);
      const { rows } = await service.detail('l-1', admin);
      const cia = rows.find((row) => row.studentId === 'p-3')!;
      expect(cia.state).toBe('ASKED');
      expect(cia.ask).toEqual({ askedAt: '2026-10-05T10:00:00.000Z', guardiansAsked: 2, guardiansWaiting: 1 });
      // The answer it follows is still shown.
      expect(cia.entry).toMatchObject({ id: 'e-3', kind: 'WITHDRAWN' });
      expect(rawSql(tx).filter((sql) => sql.includes('app.ack_status'))).toHaveLength(1);
      expect(tx.$queryRaw.mock.calls.find((call) => sqlOf(call[0]).includes('app.ack_status'))![1]).toEqual(['req-1']);
    });

    it('does not say ASKED for a request that is met, that nobody can answer, that is older than the answer, or that did not ask this pupil', async () => {
      const { tx, service } = setup();
      school(tx);
      tx['consentAsk']!['findMany']!.mockResolvedValue([askRow('req-1', '2026-10-05T10:00:00Z'), askRow('req-2', '2026-10-01T10:00:00Z')]);
      answers(tx, {
        'app.ack_status': [
          status('req-1', 'p-3', { met: true }),
          status('req-1', 'p-2', { waiting: 0 }),
          // Asked before Anna's latest answer.
          status('req-2', 'p-1'),
          status('req-2', 'p-5'),
        ],
      });
      const { rows } = await service.detail('l-1', admin);
      const stateOf = (id: string) => rows.find((row) => row.studentId === id)!.state;
      expect(stateOf('p-3')).toBe('WITHDRAWN');
      expect(stateOf('p-2')).toBe('MISSING');
      expect(stateOf('p-1')).toBe('GRANTED');
      // Eva has no answer, so a request of any age waits for her.
      expect(stateOf('p-5')).toBe('ASKED');
      expect(rows.find((row) => row.studentId === 'p-4')!.state).toBe('DECLINED');
    });

    it('asks Kvittens for nothing when no request is linked to the list', async () => {
      const { tx, service } = setup();
      school(tx);
      tx['consentAsk']!['findMany']!.mockResolvedValue([]);
      const { rows } = await service.detail('l-1', admin);
      expect(rows.some((row) => row.state === 'ASKED')).toBe(false);
      expect(rawSql(tx).some((sql) => sql.includes('app.ack_status'))).toBe(false);
    });

    it('can be closed by its maker and an administrator, and not by another teacher', async () => {
      const { tx, service } = setup();
      school(tx);
      answers(tx, { 'app.checklist_visible_ids()': [{ ids: ['p-1'] }] });
      expect((await service.detail('l-1', teacher)).canClose).toBe(false);
      tx['consentList']!['findFirst']!.mockResolvedValue(listRow({ createdById: 'teacher-1' }));
      expect((await service.detail('l-1', teacher)).canClose).toBe(true);
      expect((await service.detail('l-1', admin)).canClose).toBe(true);
      tx['consentList']!['findFirst']!.mockResolvedValue(listRow({ createdById: null }));
      expect((await service.detail('l-1', teacher)).canClose).toBe(false);
    });

    it.each([
      ['FULL', true],
      ['REKTOR', true],
      ['SCHEMALAGGARE', true],
      ['EXPEDITION', true],
      ['LASARE', false],
      [undefined, true],
    ])('lets an administrator with the profile %s close the list and write for its pupils: %s', async (profile, may) => {
      const { tx, service } = setup();
      school(tx);
      const detail = await service.detail('l-1', testUser({ schoolId: 'school-1', userId: 'admin-1', adminProfile: profile as never }));
      expect(detail.canClose).toBe(may);
      // Pupil p-7 has left the school: nobody can write for them, whatever the profile.
      expect(detail.rows.map((row) => [row.studentId, row.canWrite])).toEqual([
        ['p-1', may],
        ['p-2', may],
        ['p-3', may],
        ['p-4', may],
        ['p-5', may],
        ['p-6', may],
        ['p-7', false],
      ]);
      // A läsare still reads the whole list, and it is recorded.
      expect(detail.rows).toHaveLength(7);
      expect(readLogged(tx)).toEqual(['PEOPLE', null, ['p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6', 'p-7']]);
    });

    it('shows the huvudman’s reader, a läsare with no user id of their own, the list and nothing to write', async () => {
      const { tx, service } = setup();
      school(tx);
      const reader = testUser({ schoolId: 'school-1', userId: undefined, adminProfile: 'LASARE' as never });
      const detail = await service.detail('l-1', reader);
      expect(detail.canClose).toBe(false);
      expect(detail.rows.some((row) => row.canWrite)).toBe(false);
    });

    it('lets a teacher write only for their mentees, which an administrator’s profile has no say in', async () => {
      const { tx, service } = setup();
      school(tx);
      answers(tx, { 'app.checklist_visible_ids()': [{ ids: ['p-2', 'p-5'] }], 'app.ack_mentee_ids()': [{ ids: ['p-5'] }] });
      const detail = await service.detail('l-1', teacher);
      expect(detail.rows.map((row) => [row.studentId, row.canWrite])).toEqual([
        ['p-2', false],
        ['p-5', true],
      ]);
    });

    it('refuses a teacher with no user id', async () => {
      const { tx, service } = setup();
      school(tx);
      await expect(service.detail('l-1', testUser({ schoolId: 'school-1', role: 'TEACHER' as never, userId: undefined }))).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('shows a teacher only the pupils they teach or mentor, lets them write for their mentees, and records only those read', async () => {
      const { tx, service } = setup();
      school(tx);
      answers(tx, {
        'app.checklist_visible_ids()': [{ ids: ['p-1', 'p-3', 'p-6'] }],
        'app.ack_mentee_ids()': [{ ids: ['p-3', 'p-9'] }],
        'app.ack_status': [status('req-1', 'p-3')],
      });
      const detail = await service.detail('l-1', teacher);
      expect(detail.rows.map((row) => [row.studentId, row.canWrite])).toEqual([
        ['p-1', false],
        ['p-3', true],
        ['p-6', false],
      ]);
      expect(detail.list.counts).toEqual({ pupils: 3, granted: 2, declined: 0, withdrawn: 0, asked: 1, missing: 0 });
      expect(detail.heldOut).toBe(0);
      expect(readLogged(tx)).toEqual(['PEOPLE', null, ['p-1', 'p-3', 'p-6']]);
    });

    it('reads a teacher’s missing id lists as nobody, and records nothing', async () => {
      const { tx, service } = setup();
      school(tx);
      answers(tx, { 'app.checklist_visible_ids()': [{ ids: null }], 'app.ack_mentee_ids()': [] });
      const detail = await service.detail('l-1', teacher);
      expect(detail.rows).toEqual([]);
      expect(detail.list.counts.pupils).toBe(0);
      expect(detail.heldOut).toBe(0);
      expect(readLogged(tx)).toBeNull();
    });

    it('lets nobody write on a closed list', async () => {
      const { tx, service } = setup();
      school(tx);
      tx['consentList']!['findFirst']!.mockResolvedValue(listRow({ closedAt: new Date('2026-10-20T12:00:00Z') }));
      const detail = await service.detail('l-1', admin);
      expect(detail.list.closedAt).toBe('2026-10-20T12:00:00.000Z');
      expect(detail.rows.every((row) => row.canWrite === false)).toBe(true);
    });

    it('reports Kvittens as off when the school has not turned it on', async () => {
      const { tx, service } = setup();
      school(tx);
      answers(tx, { 'app.ack_enabled()': [{ on: false }] });
      expect((await service.detail('l-1', admin)).kvittens).toBe(false);
    });

    it('shows the pupils who have an answer when the class is gone, none of them in the class, and asks for no class’s pupils', async () => {
      const { tx, service } = setup();
      school(tx);
      tx['consentList']!['findFirst']!.mockResolvedValue(listRow({ studentGroupId: null, groupName: '7A' }));
      const detail = await service.detail('l-1', admin);
      expect(detail.list).toMatchObject({ classId: null, className: '7A' });
      expect(detail.rows.map((row) => row.studentId)).toEqual(['p-1', 'p-3', 'p-4', 'p-6', 'p-7']);
      expect(detail.rows.every((row) => row.inClass === false)).toBe(true);
      expect(tx['user']!['findMany']).not.toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ studentGroupId: expect.anything() }) }));
    });

    it('leaves out an answer whose pupil is no pupil of the school any more', async () => {
      const { tx, service } = setup();
      school(tx);
      tx['consentEntry']!['findMany']!.mockResolvedValue([entry('e-x', 'p-gone', 'GRANTED', '2026-10-02T08:00:00Z'), entry('e-t', 'teacher-1', 'GRANTED', '2026-10-02T08:00:00Z')]);
      const { rows } = await service.detail('l-1', admin);
      // Only the class's own pupils remain, by name.
      expect(rows.map((row) => row.studentId)).toEqual(['p-1', 'p-2', 'p-3', 'p-4', 'p-5']);
      expect(rows.map((row) => row.studentId)).not.toContain('p-gone');
      expect(rows.map((row) => row.studentId)).not.toContain('teacher-1');
    });

    it('keeps the answers of another list off this one', async () => {
      const { tx, service } = setup();
      school(tx);
      tx['consentEntry']!['findMany']!.mockResolvedValue([entry('e-other', 'p-2', 'GRANTED', '2026-10-02T08:00:00Z', { listId: 'l-other' })]);
      const { rows } = await service.detail('l-1', admin);
      expect(rows.find((row) => row.studentId === 'p-2')).toMatchObject({ state: 'MISSING', entry: null, history: [] });
    });

    it('orders two answers written at the same instant by id', async () => {
      const { tx, service } = setup();
      school(tx);
      tx['consentEntry']!['findMany']!.mockResolvedValue([entry('e-b', 'p-2', 'WITHDRAWN', '2026-10-02T08:00:00Z'), entry('e-a', 'p-2', 'GRANTED', '2026-10-02T08:00:00Z')]);
      const { rows } = await service.detail('l-1', admin);
      const bo = rows.find((row) => row.studentId === 'p-2')!;
      expect(bo.state).toBe('WITHDRAWN');
      expect(bo.history.map((e) => e.id)).toEqual(['e-b', 'e-a']);
    });

    it('breaks a tie of names by id', async () => {
      const { tx, service } = setup();
      school(tx);
      directory(tx, [person('p-9', 'Anna', 'Andersson'), person('p-8', 'Anna', 'Andersson'), staff('admin-1', 'Ada', 'Rektor', 'SCHOOL_ADMIN')]);
      tx['consentEntry']!['findMany']!.mockResolvedValue([]);
      const { rows } = await service.detail('l-1', admin);
      expect(rows.map((row) => row.studentId)).toEqual(['p-8', 'p-9']);
    });

    it('sorts the pupils as Swedish does: Å after Z', async () => {
      const { tx, service } = setup();
      school(tx);
      directory(tx, [person('p-1', 'Åsa', 'Åberg'), person('p-2', 'Zack', 'Zetterberg'), person('p-3', 'Anna', 'Andersson'), staff('admin-1', 'Ada', 'Rektor', 'SCHOOL_ADMIN')]);
      tx['consentEntry']!['findMany']!.mockResolvedValue([]);
      const { rows } = await service.detail('l-1', admin);
      expect(rows.map((row) => row.name)).toEqual(['Anna Andersson', 'Zack Zetterberg', 'Åsa Åberg']);
    });

    it('shows a pupil with no class at all as having none', async () => {
      const { tx, service } = setup();
      school(tx);
      directory(tx, [person('p-1', 'Anna', 'Andersson', { studentGroupId: null, studentGroup: null })]);
      tx['consentEntry']!['findMany']!.mockResolvedValue([entry('e-1', 'p-1', 'GRANTED', '2026-10-02T08:00:00Z')]);
      const { rows } = await service.detail('l-1', admin);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ className: null, inClass: false, state: 'GRANTED', canWrite: true });
    });
  });

  describe('detail for paper', () => {
    /** The world of school(), with the pupils the database marks as having a protected identity. */
    function sheet(tx: TxMock, marked: string[], over: Record<string, unknown> = {}) {
      school(tx);
      answers(tx, { 'app.ack_status': [status('req-1', 'p-3')], 'app.checklist_protected_ids': [{ ids: marked }], ...over });
    }
    const protectedQueries = (tx: TxMock) => tx.$queryRaw.mock.calls.filter((call) => sqlOf(call[0]).includes('app.checklist_protected_ids'));
    const EVERYONE = ['p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6', 'p-7'];

    it('is the screen’s list when nobody is marked, asked about every pupil in the order of the list, with the read of all of them recorded', async () => {
      const { tx, service } = setup();
      sheet(tx, []);
      const paper = await service.detail('l-1', admin, true);
      expect(paper.rows.map((row) => row.studentId)).toEqual(EVERYONE);
      expect(paper.list.counts).toEqual({ pupils: 7, granted: 3, declined: 1, withdrawn: 0, asked: 1, missing: 2 });
      expect(paper.heldOut).toBe(0);
      expect(protectedQueries(tx)).toHaveLength(1);
      expect(protectedQueries(tx)[0]!.slice(1)).toEqual([EVERYONE]);
      expect(readLogged(tx)).toEqual(['PEOPLE', null, EVERYONE]);
      // Apart from the count, it is what the screen answers.
      const screen = await service.detail('l-1', admin);
      expect(paper).toEqual(screen);
    });

    it('leaves a marked pupil out of the rows and the counts, counts them in heldOut, and records the read of those kept', async () => {
      const { tx, service } = setup();
      // Anna has granted, Cia is asked.
      sheet(tx, ['p-1', 'p-3']);
      const paper = await service.detail('l-1', admin, true);
      expect(paper.rows.map((row) => row.studentId)).toEqual(['p-2', 'p-4', 'p-5', 'p-6', 'p-7']);
      expect(paper.list.counts).toEqual({ pupils: 5, granted: 2, declined: 1, withdrawn: 0, asked: 0, missing: 2 });
      expect(paper.heldOut).toBe(2);
      expect(readLogged(tx)).toEqual(['PEOPLE', null, ['p-2', 'p-4', 'p-5', 'p-6', 'p-7']]);
      // The rest of the answer is the list's: its body, its class, who made it, Kvittens, and who may close it.
      expect(paper.list).toMatchObject({ id: 'l-1', title: 'Fotografering', body: 'Vi får fotografera i skolans kanaler.', className: '7A', createdByName: 'Ada Rektor' });
      expect(paper.kvittens).toBe(true);
      expect(paper.canClose).toBe(true);
      expect(JSON.stringify(paper)).not.toContain('Andersson');
      expect(JSON.stringify(paper)).not.toContain('Carlsson');
    });

    it('holds out a marked pupil who has moved to another class or left the school, as well', async () => {
      const { tx, service } = setup();
      sheet(tx, ['p-6', 'p-7']);
      const paper = await service.detail('l-1', admin, true);
      expect(paper.rows.map((row) => row.studentId)).toEqual(['p-1', 'p-2', 'p-3', 'p-4', 'p-5']);
      expect(paper.list.counts).toEqual({ pupils: 5, granted: 1, declined: 1, withdrawn: 0, asked: 1, missing: 2 });
      expect(paper.heldOut).toBe(2);
    });

    it('shows nobody, counts nobody and records no read when every pupil is marked, and is still the list', async () => {
      const { tx, service } = setup();
      sheet(tx, EVERYONE);
      const paper = await service.detail('l-1', admin, true);
      expect(paper.rows).toEqual([]);
      expect(paper.list.counts).toEqual({ pupils: 0, granted: 0, declined: 0, withdrawn: 0, asked: 0, missing: 0 });
      expect(paper.heldOut).toBe(7);
      expect(paper.list).toMatchObject({ id: 'l-1', title: 'Fotografering' });
      expect(readLogged(tx)).toBeNull();
    });

    it('holds out of a teacher’s sheet the marked among the pupils they can see, asks only about those, and counts only those', async () => {
      const { tx, service } = setup();
      // Fia is marked and so is Dan, who the teacher can not see: only Fia is asked about and counted.
      sheet(tx, ['p-6', 'p-4'], {
        'app.checklist_visible_ids()': [{ ids: ['p-1', 'p-3', 'p-6'] }],
        'app.ack_mentee_ids()': [{ ids: ['p-3'] }],
      });
      const paper = await service.detail('l-1', teacher, true);
      expect(protectedQueries(tx)[0]!.slice(1)).toEqual([['p-1', 'p-3', 'p-6']]);
      expect(paper.rows.map((row) => [row.studentId, row.canWrite])).toEqual([
        ['p-1', false],
        ['p-3', true],
      ]);
      expect(paper.list.counts).toEqual({ pupils: 2, granted: 1, declined: 0, withdrawn: 0, asked: 1, missing: 0 });
      expect(paper.heldOut).toBe(1);
      expect(paper.canClose).toBe(false);
      expect(readLogged(tx)).toEqual(['PEOPLE', null, ['p-1', 'p-3']]);
    });

    it('asks nothing of the database about the marks when the list has no pupils', async () => {
      const { tx, service } = setup();
      sheet(tx, ['p-1']);
      tx['consentList']!['findFirst']!.mockResolvedValue(listRow({ studentGroupId: null }));
      tx['consentEntry']!['findMany']!.mockResolvedValue([]);
      const paper = await service.detail('l-1', admin, true);
      expect(paper).toMatchObject({ rows: [], heldOut: 0 });
      expect(protectedQueries(tx)).toHaveLength(0);
    });

    it('reads a missing answer as nobody marked', async () => {
      const { tx, service } = setup();
      sheet(tx, [], { 'app.checklist_protected_ids': [{ ids: null }] });
      expect((await service.detail('l-1', admin, true)).heldOut).toBe(0);
      sheet(tx, [], { 'app.checklist_protected_ids': [] });
      expect((await service.detail('l-1', admin, true)).rows).toHaveLength(7);
    });

    it('answers 404 for a list that is not the school’s, before it asks about any mark', async () => {
      const { tx, service } = setup();
      sheet(tx, ['p-1']);
      tx['consentList']!['findFirst']!.mockResolvedValue(null);
      await expect(service.detail('l-x', admin, true)).rejects.toMatchObject({ status: 404, response: { code: 'CHECKLIST_NOT_FOUND' } });
      expect(protectedQueries(tx)).toHaveLength(0);
    });

    it('is not what the screen answers: the screen shows the marked pupil, says heldOut 0 and does not ask about the marks', async () => {
      const { tx, service } = setup();
      sheet(tx, ['p-1', 'p-2']);
      for (const [as, extra] of [
        [admin, {}],
        [teacher, { 'app.checklist_visible_ids()': [{ ids: ['p-1', 'p-2'] }] }],
      ] as const) {
        sheet(tx, ['p-1', 'p-2'], extra);
        tx.$queryRaw.mockClear();
        const screen = await service.detail('l-1', as);
        expect(screen.rows.map((row) => row.studentId)).toContain('p-1');
        expect(screen.heldOut).toBe(0);
        expect(protectedQueries(tx)).toHaveLength(0);
        const explicit = await service.detail('l-1', as, false);
        expect(explicit.rows).toEqual(screen.rows);
        expect(protectedQueries(tx)).toHaveLength(0);
      }
    });
  });

  describe('close', () => {
    it('closes the list, and answers the time the database gave', async () => {
      const { tx, service } = setup();
      raw(tx, { 'app.checklist_close_list': [{ at: new Date('2026-11-07T10:00:00Z') }] });
      expect(await service.close('l-1', teacher)).toEqual({ closedAt: '2026-11-07T10:00:00.000Z' });
      expect(tx.$queryRaw.mock.calls[0]!.slice(1)).toEqual(['l-1']);
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it.each([
      ['CL403', 403, 'CHECKLIST_NOT_STAFF'],
      ['CL404', 404, 'CHECKLIST_NOT_FOUND'],
    ])('answers the database’s %s as %i %s', async (state, status_, code) => {
      const { tx, service } = setup();
      tx.$queryRaw.mockRejectedValue(refusal(state, code));
      await expect(service.close('l-1', admin)).rejects.toMatchObject({ status: status_, response: { code } });
    });

    it('lets an error that is not ours through', async () => {
      const { tx, service } = setup();
      const other = new Error('connection reset');
      tx.$queryRaw.mockRejectedValue(other);
      await expect(service.close('l-1', admin)).rejects.toBe(other);
    });
  });

  describe('record', () => {
    beforeEach(() => {
      jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    const dto = { studentIds: ['p-2', 'p-5'], kind: 'GRANTED' as const };

    function open(tx: TxMock, over: { list?: unknown; people?: Person[]; timezone?: string | null } = {}) {
      directory(tx, over.people ?? [person('p-2', 'Bo', 'Berg'), person('p-5', 'Eva', 'Ek'), person('p-8', 'Hugo', 'Holm', { isActive: false })]);
      tx['consentList']!['findFirst']!.mockResolvedValue(over.list === undefined ? listRow() : over.list);
      tx['school']!['findUnique']!.mockResolvedValue(over.timezone === null ? null : { timezone: over.timezone ?? 'Europe/Stockholm' });
      answers(tx);
    }

    it('writes an answer for each pupil, dated today in the school’s day, with nobody named and no note', async () => {
      const { tx, service } = setup();
      open(tx);
      expect(await service.record('l-1', dto, admin)).toEqual({ written: 2 });
      expect(tx['consentEntry']!['createMany']).toHaveBeenCalledWith({
        data: [
          { schoolId: 'school-1', listId: 'l-1', studentId: 'p-2', kind: 'GRANTED', givenOn: new Date('2026-11-07T00:00:00.000Z'), givenBy: null, note: null },
          { schoolId: 'school-1', listId: 'l-1', studentId: 'p-5', kind: 'GRANTED', givenOn: new Date('2026-11-07T00:00:00.000Z'), givenBy: null, note: null },
        ],
      });
      expect(tx['consentList']!['findFirst']).toHaveBeenCalledWith({ where: { id: 'l-1', schoolId: 'school-1' } });
      expect(tx['user']!['findMany']).toHaveBeenCalledWith({ where: { id: { in: ['p-2', 'p-5'] }, schoolId: 'school-1', role: 'STUDENT', isActive: true }, select: { id: true } });
      // An administrator is asked nothing of the mentees, and writing is not reading.
      expect(rawSql(tx).some((sql) => sql.includes('ack_mentee_ids'))).toBe(false);
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('writes a no, and a consent taken back, as they were given: the day on the paper, who gave it, and a note', async () => {
      const { tx, service } = setup();
      open(tx);
      await service.record('l-1', { studentIds: ['p-2'], kind: 'DECLINED', givenOn: '2026-10-15', givenBy: 'Pappa', note: 'Ringde rektorn' }, admin);
      expect(tx['consentEntry']!['createMany']).toHaveBeenLastCalledWith({
        data: [{ schoolId: 'school-1', listId: 'l-1', studentId: 'p-2', kind: 'DECLINED', givenOn: new Date('2026-10-15T00:00:00.000Z'), givenBy: 'Pappa', note: 'Ringde rektorn' }],
      });
      await service.record('l-1', { studentIds: ['p-2'], kind: 'WITHDRAWN' }, admin);
      expect(tx['consentEntry']!['createMany']).toHaveBeenLastCalledWith({ data: [expect.objectContaining({ kind: 'WITHDRAWN' })] });
    });

    it('counts a pupil named twice once', async () => {
      const { tx, service } = setup();
      open(tx);
      expect(await service.record('l-1', { ...dto, studentIds: ['p-2', 'p-2', 'p-5', 'p-2'] }, admin)).toEqual({ written: 2 });
      expect(tx['consentEntry']!['createMany']!.mock.calls[0]![0].data).toHaveLength(2);
    });

    it('takes today in the school’s zone: at midnight in Sweden it is already tomorrow, and a day later than that has not come', async () => {
      const { tx, service } = setup();
      jest.setSystemTime(new Date('2026-11-07T23:30:00Z'));
      open(tx);
      await service.record('l-1', { ...dto, givenOn: '2026-11-08' }, admin);
      await service.record('l-1', dto, admin);
      expect(tx['consentEntry']!['createMany']!.mock.calls[1]![0].data[0].givenOn).toEqual(new Date('2026-11-08T00:00:00.000Z'));
      await expect(service.record('l-1', { ...dto, givenOn: '2026-11-09' }, admin)).rejects.toMatchObject({ response: { code: 'CHECKLIST_DATE_IN_THE_FUTURE' } });
      open(tx, { timezone: 'America/New_York' });
      await expect(service.record('l-1', { ...dto, givenOn: '2026-11-08' }, admin)).rejects.toMatchObject({ response: { code: 'CHECKLIST_DATE_IN_THE_FUTURE' } });
      // A school with no row to say its zone is a Swedish one.
      open(tx, { timezone: null });
      await expect(service.record('l-1', { ...dto, givenOn: '2026-11-08' }, admin)).resolves.toEqual({ written: 2 });
    });

    it('refuses a day that has not come with 422 CHECKLIST_DATE_IN_THE_FUTURE, and writes nothing', async () => {
      const { tx, service } = setup();
      open(tx);
      const error = await service.record('l-1', { ...dto, givenOn: '2026-11-08' }, admin).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(error).toMatchObject({ response: { code: 'CHECKLIST_DATE_IN_THE_FUTURE', message: 'Datumet har inte kommit.' } });
      expect(tx['consentEntry']!['createMany']).not.toHaveBeenCalled();
    });

    it.each(['2026-02-30', '2026-13-45', '2026-00-10', '2026-04-31', '2026-02-29'])('refuses the day %s, which does not exist', async (day) => {
      const { tx, service } = setup();
      open(tx);
      const error = await service.record('l-1', { ...dto, givenOn: day }, admin).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(error).toMatchObject({ response: { code: 'CHECKLIST_DATE_INVALID', message: 'Datumet finns inte.' } });
      expect(tx['consentEntry']!['createMany']).not.toHaveBeenCalled();
    });

    it('answers 404 for a list that is not the school’s', async () => {
      const { tx, service } = setup();
      open(tx, { list: null });
      await expect(service.record('l-x', dto, admin)).rejects.toMatchObject({ status: 404, response: { code: 'CHECKLIST_NOT_FOUND' } });
      expect(tx['consentEntry']!['createMany']).not.toHaveBeenCalled();
    });

    it('answers 409 CONSENT_LIST_CLOSED for a closed list, before it looks at the pupils', async () => {
      const { tx, service } = setup();
      open(tx, { list: listRow({ closedAt: new Date('2026-10-20T12:00:00Z') }) });
      const error = await service.record('l-1', { ...dto, studentIds: ['p-unknown'] }, admin).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error).toMatchObject({ response: { code: 'CONSENT_LIST_CLOSED', message: 'Listan är avslutad. Det går inte att skriva mer i den.' } });
      expect(tx['user']!['findMany']).not.toHaveBeenCalled();
      expect(tx['consentEntry']!['createMany']).not.toHaveBeenCalled();
    });

    it('answers 422 CHECKLIST_UNKNOWN_PUPIL for a pupil who is not an active pupil of the school', async () => {
      const { tx, service } = setup();
      open(tx);
      for (const ids of [['p-2', 'p-unknown'], ['p-2', 'p-8'], ['p-2', 'admin-1']]) {
        const error = await service.record('l-1', { ...dto, studentIds: ids }, admin).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(UnprocessableEntityException);
        expect(error).toMatchObject({ response: { code: 'CHECKLIST_UNKNOWN_PUPIL' } });
      }
      expect(tx['consentEntry']!['createMany']).not.toHaveBeenCalled();
    });

    it('lets a teacher write for their mentees', async () => {
      const { tx, service } = setup();
      open(tx);
      answers(tx, { 'app.ack_mentee_ids()': [{ ids: ['p-2', 'p-5', 'p-9'] }] });
      expect(await service.record('l-1', dto, teacher)).toEqual({ written: 2 });
    });

    it('refuses a teacher a pupil they do not mentor with 403 CHECKLIST_NOT_YOUR_PUPIL, even one they teach, and writes nobody', async () => {
      const { tx, service } = setup();
      open(tx);
      answers(tx, { 'app.ack_mentee_ids()': [{ ids: ['p-2'] }], 'app.checklist_visible_ids()': [{ ids: ['p-2', 'p-5'] }] });
      const error = await service.record('l-1', dto, teacher).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error).toMatchObject({ response: { code: 'CHECKLIST_NOT_YOUR_PUPIL' } });
      expect(tx['consentEntry']!['createMany']).not.toHaveBeenCalled();
      // A teacher who mentors nobody (no answer at all) is refused the same.
      raw(tx, {});
      await expect(service.record('l-1', dto, teacher)).rejects.toMatchObject({ response: { code: 'CHECKLIST_NOT_YOUR_PUPIL' } });
    });

    it.each([
      ['CL409', 'CONSENT_LIST_CLOSED', 409, 'CONSENT_LIST_CLOSED'],
      ['CL422', 'CHECKLIST_NOT_A_PUPIL', 422, 'CHECKLIST_UNKNOWN_PUPIL'],
      ['CL422', 'CHECKLIST_DATE_IN_THE_FUTURE', 422, 'CHECKLIST_DATE_IN_THE_FUTURE'],
      ['CL403', 'CHECKLIST_NOT_STAFF', 403, 'CHECKLIST_NOT_STAFF'],
    ])('answers the database’s %s (%s) when the insert is refused as %i %s', async (state, name, status_, code) => {
      const { tx, service } = setup();
      open(tx);
      tx['consentEntry']!['createMany']!.mockRejectedValue(refusal(state, name));
      await expect(service.record('l-1', dto, admin)).rejects.toMatchObject({ status: status_, response: { code } });
    });

    it('lets an error that is not ours through', async () => {
      const { tx, service } = setup();
      open(tx);
      const other = new Error('connection reset');
      tx['consentEntry']!['createMany']!.mockRejectedValue(other);
      await expect(service.record('l-1', dto, admin)).rejects.toBe(other);
    });

    it('refuses a login with no school', async () => {
      const { service } = setup();
      await expect(service.record('l-1', dto, testUser({ schoolId: undefined }))).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('ask', () => {
    const created = { id: 'req-9', pupils: 2, guardians: 3, withoutGuardian: ['p-5'] };

    /** Kvittens as AckService.createThen does it: the callback runs in the same transaction, with the request just written. */
    function asking(tx: TxMock, ack: { createThen: jest.Mock }, result = created) {
      ack.createThen.mockImplementation(async (_dto: unknown, _user: unknown, then: (tx: TxMock, created: unknown) => Promise<unknown>) => ({
        created: result,
        result: await then(tx, result),
      }));
    }

    it('asks every pupil of the class who has no answer, as ALL guardians, and links the request to the list in the same transaction', async () => {
      const { tx, ack, service } = setup();
      school(tx);
      asking(tx, ack);
      const asked = await service.ask('l-1', {}, admin);
      expect(asked).toEqual({ requestId: 'req-9', pupils: 2, guardians: 3, withoutGuardian: ['p-5'] });
      expect(ack.createThen).toHaveBeenCalledTimes(1);
      const [dto, user, then] = ack.createThen.mock.calls[0]!;
      expect(dto).toEqual({
        title: 'Samtycke: Fotografering',
        body: `Vi får fotografera i skolans kanaler.\n\n${CONSENT_FOOTER}`,
        rule: 'ALL',
        // Bo and Eva: nobody has answered or been asked. Cia is waited for, and the rest have answered.
        studentIds: ['p-2', 'p-5'],
      });
      expect(user).toBe(admin);
      // The link is written by the callback, with the transaction Kvittens opened, and not before.
      expect(tx['consentAsk']!['createMany']).toHaveBeenCalledTimes(1);
      expect(tx['consentAsk']!['createMany']).toHaveBeenCalledWith({ data: [{ ackRequestId: 'req-9', schoolId: 'school-1', listId: 'l-1' }] });
      const other = setup();
      await then(other.tx, { id: 'req-10' });
      expect(other.tx['consentAsk']!['createMany']).toHaveBeenCalledWith({ data: [{ ackRequestId: 'req-10', schoolId: 'school-1', listId: 'l-1' }] });
    });

    it('asks the pupils it is told to, each once, after seeing that they are pupils of the school', async () => {
      const { tx, ack, service } = setup();
      school(tx);
      asking(tx, ack);
      await service.ask('l-1', { studentIds: ['p-4', 'p-2', 'p-4'] }, admin);
      expect(ack.createThen.mock.calls[0]![0].studentIds).toEqual(['p-4', 'p-2']);
      expect(tx['user']!['findMany']).toHaveBeenCalledWith({ where: { id: { in: ['p-4', 'p-2'] }, schoolId: 'school-1', role: 'STUDENT', isActive: true }, select: { id: true } });
    });

    it('does not read the class’s pupils when it is told which to ask', async () => {
      const { tx, ack, service } = setup();
      school(tx);
      asking(tx, ack);
      await service.ask('l-1', { studentIds: ['p-2'] }, admin);
      expect(tx['consentEntry']!['findMany']).not.toHaveBeenCalled();
    });

    it('finds nobody to ask for a läsare, who can write for no pupil', async () => {
      const { tx, ack, service } = setup();
      school(tx);
      asking(tx, ack);
      const reader = testUser({ schoolId: 'school-1', userId: 'admin-1', adminProfile: 'LASARE' as never });
      await expect(service.ask('l-1', {}, reader)).rejects.toMatchObject({ status: 422, response: { code: 'CONSENT_NOBODY_TO_ASK' } });
      expect(ack.createThen).not.toHaveBeenCalled();
    });

    it('asks, by default, only the pupils a teacher mentors who have no answer', async () => {
      const { tx, ack, service } = setup();
      school(tx);
      asking(tx, ack);
      answers(tx, {
        'app.checklist_visible_ids()': [{ ids: ['p-1', 'p-2', 'p-3', 'p-5'] }],
        'app.ack_mentee_ids()': [{ ids: ['p-3', 'p-5'] }],
        'app.ack_status': [status('req-1', 'p-3')],
      });
      await service.ask('l-1', {}, teacher);
      // Cia is a mentee but is waited for; Bo has no answer but is not theirs.
      expect(ack.createThen.mock.calls[0]![0].studentIds).toEqual(['p-5']);
    });

    it('lets a teacher ask about named pupils they mentor, and refuses others with 403 CHECKLIST_NOT_YOUR_PUPIL', async () => {
      const { tx, ack, service } = setup();
      school(tx);
      asking(tx, ack);
      answers(tx, { 'app.ack_mentee_ids()': [{ ids: ['p-2'] }] });
      await service.ask('l-1', { studentIds: ['p-2'] }, teacher);
      expect(ack.createThen).toHaveBeenCalledTimes(1);
      const error = await service.ask('l-1', { studentIds: ['p-2', 'p-5'] }, teacher).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error).toMatchObject({ response: { code: 'CHECKLIST_NOT_YOUR_PUPIL' } });
      expect(ack.createThen).toHaveBeenCalledTimes(1);
    });

    it('refuses a named pupil who is not an active pupil of the school with 422 CHECKLIST_UNKNOWN_PUPIL', async () => {
      const { tx, ack, service } = setup();
      school(tx);
      const error = await service.ask('l-1', { studentIds: ['p-2', 'p-7'] }, admin).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(error).toMatchObject({ response: { code: 'CHECKLIST_UNKNOWN_PUPIL' } });
      expect(ack.createThen).not.toHaveBeenCalled();
    });

    it('answers 422 CONSENT_NOBODY_TO_ASK when nobody lacks an answer', async () => {
      const { tx, ack, service } = setup();
      school(tx);
      tx['consentEntry']!['findMany']!.mockResolvedValue([
        entry('e-2', 'p-2', 'GRANTED', '2026-10-02T08:00:00Z'),
        entry('e-5', 'p-5', 'DECLINED', '2026-10-02T08:00:00Z'),
        entry('e-3', 'p-3', 'GRANTED', '2026-10-06T08:00:00Z'),
        entry('e-1', 'p-1', 'GRANTED', '2026-10-02T08:00:00Z'),
        entry('e-4', 'p-4', 'GRANTED', '2026-10-02T08:00:00Z'),
      ]);
      const error = await service.ask('l-1', {}, admin).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UnprocessableEntityException);
      expect(error).toMatchObject({
        response: {
          code: 'CONSENT_NOBODY_TO_ASK',
          message: 'Det finns ingen att fråga: ingen av eleverna har en vårdnadshavare, eller så saknar ingen samtycke.',
        },
      });
      expect(ack.createThen).not.toHaveBeenCalled();
    });

    it('answers 422 CONSENT_NOBODY_TO_ASK for a teacher who mentors none of the pupils, and for an empty choice', async () => {
      const { tx, ack, service } = setup();
      school(tx);
      await expect(service.ask('l-1', {}, teacher)).rejects.toMatchObject({ response: { code: 'CONSENT_NOBODY_TO_ASK' } });
      await expect(service.ask('l-1', { studentIds: [] }, admin)).rejects.toMatchObject({ response: { code: 'CONSENT_NOBODY_TO_ASK' } });
      expect(ack.createThen).not.toHaveBeenCalled();
    });

    it('answers 404 for a list that is not the school’s, and 409 CONSENT_LIST_CLOSED for a closed one', async () => {
      const { tx, ack, service } = setup();
      school(tx);
      tx['consentList']!['findFirst']!.mockResolvedValue(null);
      await expect(service.ask('l-x', {}, admin)).rejects.toMatchObject({ status: 404, response: { code: 'CHECKLIST_NOT_FOUND' } });
      tx['consentList']!['findFirst']!.mockResolvedValue(listRow({ closedAt: new Date('2026-10-20T12:00:00Z') }));
      const error = await service.ask('l-1', {}, admin).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error).toMatchObject({ response: { code: 'CONSENT_LIST_CLOSED' } });
      expect(ack.createThen).not.toHaveBeenCalled();
    });

    it('answers 409 ACK_DISABLED while the school has Kvittens off', async () => {
      const { tx, ack, service } = setup();
      school(tx);
      answers(tx, { 'app.ack_enabled()': [{ on: false }] });
      const error = await service.ask('l-1', {}, admin).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error).toMatchObject({ response: { code: 'ACK_DISABLED', message: 'Skolan har inte slagit på kvittens.' } });
      expect(ack.createThen).not.toHaveBeenCalled();
    });

    it('cuts the title to what Kvittens holds, and sends the list’s text and nothing else besides the footer', async () => {
      const { tx, ack, service } = setup();
      school(tx);
      asking(tx, ack);
      const title = 'T'.repeat(TITLE_MAX);
      tx['consentList']!['findFirst']!.mockResolvedValue(listRow({ title, body: 'Text' }));
      await service.ask('l-1', { studentIds: ['p-2'] }, admin);
      const sent = ack.createThen.mock.calls[0]![0];
      expect(sent.title).toHaveLength(TITLE_MAX);
      // Cut at 119 characters and shown as cut, not sliced without a word.
      expect(sent.title).toBe(`Samtycke: ${'T'.repeat(TITLE_MAX - 'Samtycke: '.length - 1)}…`);
      expect(sent.body).toBe(`Text\n\n${CONSENT_FOOTER}`);
    });

    it.each([
      [TITLE_MAX - 'Samtycke: '.length - 1, false],
      [TITLE_MAX - 'Samtycke: '.length, false],
      [TITLE_MAX - 'Samtycke: '.length + 1, true],
      [TITLE_MAX, true],
    ])('sends a list title of %i characters as the request’s title with an ellipsis: %s', async (length, cut) => {
      const { tx, ack, service } = setup();
      school(tx);
      asking(tx, ack);
      tx['consentList']!['findFirst']!.mockResolvedValue(listRow({ title: 'T'.repeat(length) }));
      await service.ask('l-1', { studentIds: ['p-2'] }, admin);
      const { title } = ack.createThen.mock.calls[0]![0];
      expect(title.length).toBeLessThanOrEqual(TITLE_MAX);
      if (cut) {
        expect(title).toHaveLength(TITLE_MAX);
        expect(title.endsWith('…')).toBe(true);
        expect(title.startsWith('Samtycke: T')).toBe(true);
      } else {
        expect(title).toBe(`Samtycke: ${'T'.repeat(length)}`);
        expect(title.endsWith('…')).toBe(false);
      }
    });

    it('sends a short title as the prefix and the title, as they are', async () => {
      const { tx, ack, service } = setup();
      school(tx);
      asking(tx, ack);
      await service.ask('l-1', { studentIds: ['p-2'] }, admin);
      expect(ack.createThen.mock.calls[0]![0].title).toBe('Samtycke: Fotografering');
    });

    it('answers a list that was closed while the request was written, as the database says it (CL409), as 409 CONSENT_LIST_CLOSED', async () => {
      const { tx, ack, service } = setup();
      school(tx);
      ack.createThen.mockRejectedValue(refusal('CL409', 'CONSENT_LIST_CLOSED'));
      await expect(service.ask('l-1', {}, admin)).rejects.toMatchObject({ status: 409, response: { code: 'CONSENT_LIST_CLOSED' } });
      ack.createThen.mockRejectedValue(refusal('CL404', 'CHECKLIST_NOT_FOUND'));
      await expect(service.ask('l-1', {}, admin)).rejects.toMatchObject({ status: 404, response: { code: 'CHECKLIST_NOT_FOUND' } });
    });

    it('lets Kvittens’ own refusals through as they are: the limits, no guardians, and every other error', async () => {
      const { tx, ack, service } = setup();
      school(tx);
      const limit = new HttpException({ code: 'ACK_TOO_MANY_REQUESTS', message: 'Du har skickat tio meddelanden den senaste timmen. Vänta en stund och försök igen.' }, HttpStatus.TOO_MANY_REQUESTS);
      ack.createThen.mockRejectedValue(limit);
      await expect(service.ask('l-1', {}, admin)).rejects.toBe(limit);
      const none = new UnprocessableEntityException({ code: 'ACK_NO_GUARDIANS', message: 'Ingen av eleverna har en vårdnadshavare.' });
      ack.createThen.mockRejectedValue(none);
      await expect(service.ask('l-1', {}, admin)).rejects.toBe(none);
      const other = new Error('connection reset');
      ack.createThen.mockRejectedValue(other);
      await expect(service.ask('l-1', {}, admin)).rejects.toBe(other);
    });

    it('refuses a login with no school', async () => {
      const { ack, service } = setup();
      await expect(service.ask('l-1', {}, testUser({ schoolId: undefined }))).rejects.toBeInstanceOf(ForbiddenException);
      expect(ack.createThen).not.toHaveBeenCalled();
    });
  });

  describe('student', () => {
    const anna = person('p-1', 'Anna', 'Andersson');

    function card(tx: TxMock) {
      directory(tx, [anna, staff('admin-1', 'Ada', 'Rektor', 'SCHOOL_ADMIN'), staff('teacher-1', 'Tora', 'Lind')]);
      tx['instructionProof']!['findMany']!.mockResolvedValue([
        {
          id: 'pr-1',
          schoolId: 'school-1',
          templateId: 't-1',
          studentId: 'p-1',
          instructedOn: new Date('2026-11-03T00:00:00Z'),
          instructorId: 'teacher-1',
          recordedById: 'admin-1',
          recordedAt: new Date('2026-11-03T09:15:00Z'),
          note: 'Grupp 2',
          voidedAt: null,
          voidedById: null,
          voidReason: null,
        },
        {
          id: 'pr-2',
          schoolId: 'school-1',
          templateId: 't-2',
          studentId: 'p-1',
          instructedOn: new Date('2026-09-10T00:00:00Z'),
          instructorId: null,
          recordedById: null,
          recordedAt: new Date('2026-09-10T09:00:00Z'),
          note: null,
          voidedAt: new Date('2026-09-11T08:00:00Z'),
          voidedById: 'admin-1',
          voidReason: 'Fel elev',
        },
        {
          id: 'pr-3',
          schoolId: 'school-1',
          templateId: 't-gone',
          studentId: 'p-1',
          instructedOn: new Date('2026-08-20T00:00:00Z'),
          instructorId: 'u-gone',
          recordedById: 'u-gone',
          recordedAt: new Date('2026-08-20T09:00:00Z'),
          note: null,
          voidedAt: null,
          voidedById: null,
          voidReason: null,
        },
        {
          id: 'pr-4',
          schoolId: 'school-1',
          templateId: 't-3',
          studentId: 'p-1',
          instructedOn: new Date('2026-08-19T00:00:00Z'),
          instructorId: null,
          recordedById: null,
          recordedAt: new Date('2026-08-19T09:00:00Z'),
          note: null,
          voidedAt: null,
          voidedById: null,
          voidReason: null,
        },
      ]);
      tx['instructionTemplate']!['findMany']!.mockResolvedValue([
        { id: 't-1', schoolId: 'school-1', subjectId: 's-1', title: 'Cirkelsågen', description: null, active: true },
        { id: 't-2', schoolId: 'school-1', subjectId: null, title: 'Kast och stöt', description: null, active: false },
        { id: 't-3', schoolId: 'school-1', subjectId: 's-gone', title: 'Kemikalier', description: null, active: true },
      ]);
      tx['subject']!['findMany']!.mockResolvedValue([{ id: 's-1', name: 'Slöjd' }]);
      tx['consentList']!['findMany']!.mockResolvedValue([
        listRow({ id: 'l-1', title: 'Fotografering' }),
        listRow({ id: 'l-2', title: 'Utflykt', closedAt: new Date('2026-10-20T12:00:00Z'), createdAt: new Date('2026-09-01T08:00:00Z') }),
        listRow({ id: 'l-3', title: 'Publicering', createdAt: new Date('2026-08-01T08:00:00Z') }),
        // A list of another class that the pupil is not part of: there is no row of theirs on it.
        listRow({ id: 'l-4', title: 'Annan klass', studentGroupId: 'c-9', groupName: '9C' }),
      ]);
      tx['consentEntry']!['findMany']!.mockResolvedValue([
        entry('e-1', 'p-1', 'GRANTED', '2026-10-03T08:00:00Z', { listId: 'l-1', givenBy: 'Mamma' }),
        entry('e-2', 'p-1', 'DECLINED', '2026-10-03T08:00:00Z', { listId: 'l-2' }),
      ]);
      answers(tx);
    }

    it('gives every tick, voided ones with who and why, and where the pupil stands on each list', async () => {
      const { tx, service } = setup();
      card(tx);
      const result = await service.student('p-1', admin);

      expect(result.student).toEqual({ id: 'p-1', name: 'Anna Andersson', className: '7A' });
      expect(result.proofs).toEqual([
        {
          id: 'pr-1',
          instructedOn: '2026-11-03',
          instructorId: 'teacher-1',
          instructorName: 'Tora Lind',
          recordedByName: 'Ada Rektor',
          recordedAt: '2026-11-03T09:15:00.000Z',
          note: 'Grupp 2',
          canVoid: true,
          templateId: 't-1',
          templateTitle: 'Cirkelsågen',
          subjectName: 'Slöjd',
          voidedAt: null,
          voidedByName: null,
          voidReason: null,
        },
        {
          id: 'pr-2',
          instructedOn: '2026-09-10',
          instructorId: null,
          instructorName: null,
          recordedByName: null,
          recordedAt: '2026-09-10T09:00:00.000Z',
          note: null,
          canVoid: true,
          templateId: 't-2',
          templateTitle: 'Kast och stöt',
          subjectName: null,
          voidedAt: '2026-09-11T08:00:00.000Z',
          voidedByName: 'Ada Rektor',
          voidReason: 'Fel elev',
        },
        // A template that is gone, and whose people have left: the proof stays, and says what it can.
        expect.objectContaining({ id: 'pr-3', templateId: 't-gone', templateTitle: '', subjectName: null, instructorId: 'u-gone', instructorName: null, recordedByName: null }),
        // A template whose subject is gone.
        expect.objectContaining({ id: 'pr-4', templateTitle: 'Kemikalier', subjectName: null }),
      ]);
      expect(result.consents.map((consent) => [consent.listId, consent.title, consent.className, consent.closed, consent.state])).toEqual([
        ['l-1', 'Fotografering', '7A', false, 'GRANTED'],
        ['l-2', 'Utflykt', '7A', true, 'DECLINED'],
        ['l-3', 'Publicering', '7A', false, 'MISSING'],
      ]);
      expect(result.consents[0]!.entry).toMatchObject({ id: 'e-1', kind: 'GRANTED', givenBy: 'Mamma', recordedByName: 'Ada Rektor' });
      expect(result.consents[2]!.entry).toBeNull();
      // The ticks are asked for with the voided ones, and the templates only for those the pupil has.
      expect(tx['instructionProof']!['findMany']).toHaveBeenCalledWith({
        where: { schoolId: 'school-1', studentId: 'p-1' },
        orderBy: [{ instructedOn: 'desc' }, { recordedAt: 'desc' }, { id: 'asc' }],
      });
      expect(tx['instructionTemplate']!['findMany']).toHaveBeenCalledWith({ where: { schoolId: 'school-1', id: { in: ['t-1', 't-2', 't-gone', 't-3'] } } });
      expect(tx['subject']!['findMany']).toHaveBeenCalledWith({ where: { id: { in: ['s-1', 's-gone'] } }, select: { id: true, name: true } });
    });

    it('looks for the lists the pupil has answered on and the open lists of their class', async () => {
      const { tx, service } = setup();
      card(tx);
      await service.student('p-1', admin);
      expect(tx['consentList']!['findMany']).toHaveBeenCalledWith({
        where: { schoolId: 'school-1', OR: [{ entries: { some: { studentId: 'p-1' } } }, { studentGroupId: 'c-1', closedAt: null }] },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      });
    });

    it('records the read of this one pupil as PEOPLE', async () => {
      const { tx, service } = setup();
      card(tx);
      await service.student('p-1', testUser({ schoolId: 'school-1', userId: 'admin-1', channel: 'WEB' }));
      expect(readLogged(tx)).toEqual(['PEOPLE', 'WEB', ['p-1']]);
    });

    it('asks for the lists of the answers alone for a pupil with no class, and says they have none', async () => {
      const { tx, service } = setup();
      card(tx);
      directory(tx, [person('p-1', 'Anna', 'Andersson', { studentGroupId: null, studentGroup: null })]);
      tx['consentList']!['findMany']!.mockResolvedValue([]);
      const result = await service.student('p-1', admin);
      expect(result.student.className).toBeNull();
      expect(result.consents).toEqual([]);
      expect(tx['consentList']!['findMany']).toHaveBeenCalledWith(expect.objectContaining({ where: { schoolId: 'school-1', OR: [{ entries: { some: { studentId: 'p-1' } } }] } }));
    });

    it('is empty, and asks no one’s name, for a pupil with no ticks and no lists', async () => {
      const { tx, service } = setup();
      directory(tx, [anna]);
      const result = await service.student('p-1', admin);
      expect(result).toEqual({ student: { id: 'p-1', name: 'Anna Andersson', className: '7A' }, proofs: [], consents: [] });
      expect(tx['consentEntry']!['findMany']).not.toHaveBeenCalled();
      expect(readLogged(tx)).toEqual(['PEOPLE', null, ['p-1']]);
    });

    it('shows a pupil who has left the school, with their answers, and no list of the class they no longer count in', async () => {
      const { tx, service } = setup();
      card(tx);
      directory(tx, [person('p-1', 'Anna', 'Andersson', { isActive: false }), staff('admin-1', 'Ada', 'Rektor', 'SCHOOL_ADMIN')]);
      const result = await service.student('p-1', admin);
      // l-3 is the class's and she has no answer there; as she is not in the class any more, there is no row.
      expect(result.consents.map((consent) => consent.listId)).toEqual(['l-1', 'l-2']);
    });

    it('answers 404 for a pupil that is not a pupil of the school', async () => {
      const { tx, service } = setup();
      card(tx);
      const error = await service.student('u-x', admin).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(NotFoundException);
      expect(error).toMatchObject({ response: { code: 'CHECKLIST_NOT_FOUND' } });
      await expect(service.student('teacher-1', admin)).rejects.toMatchObject({ status: 404 });
      expect(tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('answers 404 for a pupil a teacher can not see, before it reads anything of them', async () => {
      const { tx, service } = setup();
      card(tx);
      answers(tx, { 'app.checklist_visible_ids()': [{ ids: ['p-2'] }] });
      await expect(service.student('p-1', teacher)).rejects.toMatchObject({ status: 404, response: { code: 'CHECKLIST_NOT_FOUND' } });
      expect(tx['user']!['findFirst']).not.toHaveBeenCalled();
      expect(tx['instructionProof']!['findMany']).not.toHaveBeenCalled();
      expect(tx.$executeRaw).not.toHaveBeenCalled();
      // No answer at all means nobody is visible.
      raw(tx, {});
      await expect(service.student('p-1', teacher)).rejects.toMatchObject({ status: 404 });
    });

    describe('who may void a tick', () => {
      /** pr-1 by admin-1, pr-2 by nobody, pr-3 by a person who is gone; the teacher's own is pr-mine. */
      async function ticks(tx: TxMock) {
        card(tx);
        const rows = (await tx['instructionProof']!['findMany']!({})) as Array<Record<string, unknown>>;
        rows.push({ ...rows[0]!, id: 'pr-mine', recordedById: 'teacher-1' });
        return rows;
      }
      const voidable = (result: { proofs: Array<{ id: string; canVoid: boolean }> }) => Object.fromEntries(result.proofs.map((view) => [view.id, view.canVoid]));

      it('lets a teacher void their own ticks and no one else’s, on the card as on the roster', async () => {
        const { tx, service } = setup();
        await ticks(tx);
        answers(tx, { 'app.checklist_visible_ids()': [{ ids: ['p-1'] }] });
        expect(voidable(await service.student('p-1', teacher))).toEqual({ 'pr-1': false, 'pr-2': false, 'pr-3': false, 'pr-4': false, 'pr-mine': true });
      });

      it('lets an administrator who writes Drift void any, a voided one too (the database makes a second void change nothing)', async () => {
        const { tx, service } = setup();
        await ticks(tx);
        const result = await service.student('p-1', testUser({ schoolId: 'school-1', userId: 'admin-1', adminProfile: 'SCHEMALAGGARE' as never }));
        expect(voidable(result)).toEqual({ 'pr-1': true, 'pr-2': true, 'pr-3': true, 'pr-4': true, 'pr-mine': true });
      });

      it('lets a läsare void none', async () => {
        const { tx, service } = setup();
        await ticks(tx);
        const result = await service.student('p-1', testUser({ schoolId: 'school-1', userId: 'admin-1', adminProfile: 'LASARE' as never }));
        expect(Object.values(voidable(result)).every((may) => may === false)).toBe(true);
        expect(result.proofs).toHaveLength(5);
      });
    });

    it('shows a teacher a pupil they can see', async () => {
      const { tx, service } = setup();
      card(tx);
      answers(tx, { 'app.checklist_visible_ids()': [{ ids: ['p-1'] }], 'app.ack_mentee_ids()': [{ ids: [] }] });
      const result = await service.student('p-1', teacher);
      expect(result.student.id).toBe('p-1');
      expect(result.consents.map((consent) => consent.state)).toEqual(['GRANTED', 'DECLINED', 'MISSING']);
      expect(readLogged(tx)).toEqual(['PEOPLE', null, ['p-1']]);
    });

    it('refuses a login with no school', async () => {
      const { service } = setup();
      await expect(service.student('p-1', testUser({ schoolId: undefined }))).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
