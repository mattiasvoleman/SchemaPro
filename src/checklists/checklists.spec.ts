import { HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BODY_MAX, PUPILS_MAX, TITLE_MAX as ACK_TITLE_MAX } from '../ack/ack';
import type { PrismaClient } from '@prisma/client';
import { createTxMock, testUser } from '../../test/utils/prisma-mock';
import {
  ASK_MAX,
  CHECKLIST_DATE_INVALID,
  CHECKLIST_DATE_IN_THE_FUTURE,
  CHECKLIST_INSTRUCTOR_IS_NOT_STAFF,
  CHECKLIST_NOT_FOUND,
  CHECKLIST_NOT_STAFF,
  CHECKLIST_NOT_YOUR_PUPIL,
  CHECKLIST_REASON_NEEDED,
  CHECKLIST_TEMPLATE_EXISTS,
  CHECKLIST_TEMPLATE_RETIRED,
  CHECKLIST_UNKNOWN_PUPIL,
  CHECKLIST_UNKNOWN_SUBJECT,
  CONSENT_ASK_ALREADY_ANSWERED,
  CONSENT_ASK_NEEDS_ALL,
  CONSENT_FOOTER,
  CONSENT_LIST_CLOSED,
  CONSENT_LIST_EXISTS,
  CONSENT_NOBODY_TO_ASK,
  CONSENT_NOT_A_CLASS,
  CONSENT_NOT_YOUR_CLASS,
  LIST_BODY_MAX,
  TITLE_MAX,
  adminWrites,
  canVoidProof,
  messageOf,
  protectedAmong,
  refusalName,
  sqlStateOf,
  translateRefusal,
} from './checklists';

/** A raw statement's refusal as the adapter reports it: P2010 with the SQLSTATE in driverAdapterError.cause. */
function raw(code: unknown, message = 'Raw query failed'): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code: 'P2010',
    clientVersion: 'test',
    meta: { driverAdapterError: { cause: { originalCode: code } } },
  });
}

/** Asserts the result is an HttpException and describes it. */
function described(error: HttpException | null): { status: number; code: string; message: string } {
  expect(error).toBeInstanceOf(HttpException);
  const response = error!.getResponse() as { code: string; message: string };
  return { status: error!.getStatus(), code: response.code, message: response.message };
}

describe('checklists', () => {
  describe('the limits', () => {
    it('keep a consent list’s request inside the request’s own limits', () => {
      // The request to the guardians is the list's text, a blank line and CONSENT_FOOTER: it has to fit Kvittens' body.
      expect(LIST_BODY_MAX + '\n\n'.length + CONSENT_FOOTER.length).toBeLessThanOrEqual(BODY_MAX);
      // The title is cut to the one limit both share, and a list may be asked for as many pupils as a request holds.
      expect(TITLE_MAX).toBe(ACK_TITLE_MAX);
      expect(ASK_MAX).toBe(PUPILS_MAX);
    });
  });

  describe('sqlStateOf', () => {
    it('reads the code from driverAdapterError.cause of a raw refusal (P2010)', () => {
      expect(sqlStateOf(raw('CL404'))).toBe('CL404');
      expect(sqlStateOf(raw('CL409'))).toBe('CL409');
    });

    it('prefers the adapter’s code to the one in the message', () => {
      expect(sqlStateOf(raw('CL403', 'Raw query failed. Code: `CL404`.'))).toBe('CL403');
    });

    it('reads "Code: `…`" from the message of a model query a trigger refused', () => {
      expect(sqlStateOf(new Error('Invalid `prisma.consentEntry.createMany()` invocation: Code: `CL409`. Message: `CONSENT_LIST_CLOSED`'))).toBe('CL409');
      expect(sqlStateOf(new Error('Raw query failed. Code: `CL404`. Message: `CHECKLIST_NOT_FOUND`'))).toBe('CL404');
    });

    it('reads any five-character code the message names, ours or not', () => {
      expect(sqlStateOf(new Error('Raw query failed. Code: `23505`.'))).toBe('23505');
      expect(sqlStateOf(new Error('Raw query failed. Code: `KV429`.'))).toBe('KV429');
    });

    it('falls back to a bare CL403, CL404, CL409 or CL422 in the message', () => {
      expect(sqlStateOf(new Error('ERROR: CHECKLIST_NOT_FOUND (CL404)'))).toBe('CL404');
      expect(sqlStateOf(new Error('boom CL403 boom'))).toBe('CL403');
      expect(sqlStateOf(new Error('CL409'))).toBe('CL409');
      expect(sqlStateOf(new Error('x CL422'))).toBe('CL422');
    });

    it('does not take another CL code, or one glued to other letters, for ours', () => {
      expect(sqlStateOf(new Error('CL410'))).toBeNull();
      expect(sqlStateOf(new Error('XCL404'))).toBeNull();
      expect(sqlStateOf(new Error('CL4040'))).toBeNull();
    });

    it('falls back to the message when the adapter’s code is not text, or there is no cause', () => {
      expect(sqlStateOf(raw(404, 'Raw query failed. Code: `CL404`.'))).toBe('CL404');
      expect(sqlStateOf(Object.assign(new Error('nope'), { meta: { driverAdapterError: {} } }))).toBeNull();
      expect(sqlStateOf(Object.assign(new Error('nope'), { meta: {} }))).toBeNull();
    });

    it('is null for anything else', () => {
      expect(sqlStateOf(new Error('connection reset'))).toBeNull();
      expect(sqlStateOf(null)).toBeNull();
      expect(sqlStateOf(undefined)).toBeNull();
      expect(sqlStateOf('CL404')).toBeNull();
      expect(sqlStateOf({ message: 'CL404' })).toBeNull();
    });
  });

  describe('refusalName', () => {
    it('is the name the database gave the refusal, when the message carries it', () => {
      expect(refusalName(new Error('Raw query failed. Message: `CONSENT_LIST_CLOSED`'))).toBe('CONSENT_LIST_CLOSED');
      expect(refusalName(new Error('ERROR: CHECKLIST_DATE_IN_THE_FUTURE'))).toBe('CHECKLIST_DATE_IN_THE_FUTURE');
      expect(refusalName(new Error('CHECKLIST_NOT_A_PUPIL'))).toBe('CHECKLIST_NOT_A_PUPIL');
    });

    it('is the first one when the message names several', () => {
      expect(refusalName(new Error('CONSENT_LIST_CLOSED then CHECKLIST_NOT_FOUND'))).toBe('CONSENT_LIST_CLOSED');
    });

    it('is null when the message names none, and for what is not an Error', () => {
      expect(refusalName(new Error('connection reset'))).toBeNull();
      expect(refusalName(new Error('ACK_DISABLED'))).toBeNull();
      expect(refusalName(new Error('checklist_not_found'))).toBeNull();
      expect(refusalName('CHECKLIST_NOT_FOUND')).toBeNull();
      expect(refusalName(null)).toBeNull();
      expect(refusalName({ message: 'CHECKLIST_NOT_FOUND' })).toBeNull();
    });
  });

  describe('messageOf', () => {
    it('is the Swedish sentence for a code the module knows', () => {
      expect(messageOf(CHECKLIST_NOT_FOUND)).toBe('Det finns inte, eller är inte ditt att se.');
      expect(messageOf(CONSENT_LIST_CLOSED)).toBe('Listan är avslutad. Det går inte att skriva mer i den.');
      expect(messageOf(CHECKLIST_TEMPLATE_EXISTS)).toBe('Det momentet finns redan i det ämnet.');
    });

    it.each([
      CHECKLIST_NOT_FOUND,
      CHECKLIST_NOT_STAFF,
      CHECKLIST_NOT_YOUR_PUPIL,
      CHECKLIST_UNKNOWN_PUPIL,
      CHECKLIST_TEMPLATE_RETIRED,
      CHECKLIST_TEMPLATE_EXISTS,
      CHECKLIST_UNKNOWN_SUBJECT,
      CHECKLIST_DATE_IN_THE_FUTURE,
      CHECKLIST_DATE_INVALID,
      CHECKLIST_INSTRUCTOR_IS_NOT_STAFF,
      CHECKLIST_REASON_NEEDED,
      CONSENT_ASK_NEEDS_ALL,
      CONSENT_ASK_ALREADY_ANSWERED,
      CONSENT_LIST_CLOSED,
      CONSENT_LIST_EXISTS,
      CONSENT_NOT_A_CLASS,
      CONSENT_NOT_YOUR_CLASS,
      CONSENT_NOBODY_TO_ASK,
    ])('has a sentence of its own for %s', (code) => {
      expect(messageOf(code)).not.toBe(code);
      expect(messageOf(code).length).toBeGreaterThan(10);
    });

    it('is the code itself for one it does not know', () => {
      expect(messageOf('SOMETHING_ELSE')).toBe('SOMETHING_ELSE');
      expect(messageOf('')).toBe('');
    });
  });

  describe('protectedAmong', () => {
    const setup = () => {
      const tx = createTxMock();
      return { tx, client: tx as unknown as PrismaClient };
    };

    it('asks the database which of the pupils are marked, with the ids as a uuid array, and answers them as a set', async () => {
      const { tx, client } = setup();
      tx.$queryRaw.mockResolvedValue([{ ids: ['p-2', 'p-9'] }]);
      const marked = await protectedAmong(client, ['p-1', 'p-2', 'p-3']);
      expect(marked).toEqual(new Set(['p-2', 'p-9']));
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      const [strings, ...values] = tx.$queryRaw.mock.calls[0]!;
      expect((strings as string[]).join('?')).toContain('app.checklist_protected_ids(');
      expect((strings as string[]).join('?')).toContain('::uuid[]');
      expect(values).toEqual([['p-1', 'p-2', 'p-3']]);
    });

    it('answers nobody, without asking, for no pupils', async () => {
      const { tx, client } = setup();
      expect(await protectedAmong(client, [])).toEqual(new Set());
      expect(tx.$queryRaw).not.toHaveBeenCalled();
    });

    it('answers nobody when the database names none, says null, or says nothing', async () => {
      const { tx, client } = setup();
      tx.$queryRaw.mockResolvedValue([{ ids: [] }]);
      expect(await protectedAmong(client, ['p-1'])).toEqual(new Set());
      tx.$queryRaw.mockResolvedValue([{ ids: null }]);
      expect(await protectedAmong(client, ['p-1'])).toEqual(new Set());
      tx.$queryRaw.mockResolvedValue([]);
      expect(await protectedAmong(client, ['p-1'])).toEqual(new Set());
    });

    it('hands the database a copy, so that the caller’s list is its own', async () => {
      const { tx, client } = setup();
      tx.$queryRaw.mockResolvedValue([{ ids: [] }]);
      const ids = ['p-1', 'p-2'] as const;
      await protectedAmong(client, ids);
      expect(tx.$queryRaw.mock.calls[0]![1]).not.toBe(ids);
      expect(tx.$queryRaw.mock.calls[0]![1]).toEqual(['p-1', 'p-2']);
    });

    it('lets a database error through', async () => {
      const { tx, client } = setup();
      const error = new Error('connection reset');
      tx.$queryRaw.mockRejectedValue(error);
      await expect(protectedAmong(client, ['p-1'])).rejects.toBe(error);
    });
  });

  describe('canVoidProof', () => {
    const ME = '22222222-2222-4222-8222-222222222222';
    const OTHER = '99999999-9999-4999-8999-999999999999';

    it.each(['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION'])('lets an administrator with the profile %s, who writes Drift, void a tick of anyone’s', (profile) => {
      const user = testUser({ userId: ME, adminProfile: profile as never });
      expect(canVoidProof(user, OTHER)).toBe(true);
      expect(canVoidProof(user, ME)).toBe(true);
      expect(canVoidProof(user, null)).toBe(true);
    });

    it('lets an administrator whose request carries no profile void, as it always did', () => {
      expect(canVoidProof(testUser({ adminProfile: undefined }), OTHER)).toBe(true);
    });

    it('does not let a läsare void, not even a tick they wrote', () => {
      const lasare = testUser({ userId: ME, adminProfile: 'LASARE' as never });
      expect(canVoidProof(lasare, OTHER)).toBe(false);
      expect(canVoidProof(lasare, ME)).toBe(false);
      expect(canVoidProof(lasare, null)).toBe(false);
    });

    it('lets a teacher void a tick they wrote, and not another’s', () => {
      const teacher = testUser({ userId: ME, role: 'TEACHER' as never });
      expect(canVoidProof(teacher, ME)).toBe(true);
      expect(canVoidProof(teacher, OTHER)).toBe(false);
    });

    it('does not let a teacher void a tick nobody wrote (the writer is gone), even a teacher with no user id', () => {
      expect(canVoidProof(testUser({ userId: ME, role: 'TEACHER' as never }), null)).toBe(false);
      expect(canVoidProof(testUser({ userId: undefined, role: 'TEACHER' as never }), null)).toBe(false);
      expect(canVoidProof(testUser({ userId: undefined, role: 'TEACHER' as never }), OTHER)).toBe(false);
    });

    it.each(['GUARDIAN', 'STUDENT', 'HUVUDMAN'])('does not let a %s void, whoever wrote the tick', (role) => {
      const user = testUser({ userId: ME, role: role as never });
      expect(canVoidProof(user, ME)).toBe(false);
      expect(canVoidProof(user, null)).toBe(false);
    });
  });

  describe('adminWrites', () => {
    it.each(['FULL', 'REKTOR', 'SCHEMALAGGARE', 'EXPEDITION'])('is true for an administrator with the profile %s, which writes Drift', (profile) => {
      expect(adminWrites(testUser({ adminProfile: profile as never }))).toBe(true);
    });

    it('is false for a läsare, who writes nothing', () => {
      expect(adminWrites(testUser({ adminProfile: 'LASARE' as never }))).toBe(false);
    });

    it('is true for an administrator whose request carries no profile', () => {
      expect(adminWrites(testUser({ adminProfile: undefined }))).toBe(true);
    });

    it.each(['TEACHER', 'GUARDIAN', 'STUDENT', 'HUVUDMAN'])('is false for a %s, whatever profile the request carries', (role) => {
      expect(adminWrites(testUser({ role: role as never }))).toBe(false);
      expect(adminWrites(testUser({ role: role as never, adminProfile: 'FULL' as never }))).toBe(false);
    });
  });

  describe('translateRefusal', () => {
    it('answers CL403 as 403 CHECKLIST_NOT_STAFF', () => {
      expect(described(translateRefusal(raw('CL403')))).toEqual({
        status: HttpStatus.FORBIDDEN,
        code: 'CHECKLIST_NOT_STAFF',
        message: messageOf(CHECKLIST_NOT_STAFF),
      });
    });

    it('answers CL404 as 404 CHECKLIST_NOT_FOUND', () => {
      expect(described(translateRefusal(raw('CL404')))).toEqual({
        status: HttpStatus.NOT_FOUND,
        code: 'CHECKLIST_NOT_FOUND',
        message: messageOf(CHECKLIST_NOT_FOUND),
      });
    });

    describe('CL409', () => {
      it('is a closed list when the refusal is named CONSENT_LIST_CLOSED', () => {
        expect(described(translateRefusal(raw('CL409', 'Raw query failed. Message: `CONSENT_LIST_CLOSED`')))).toEqual({
          status: HttpStatus.CONFLICT,
          code: 'CONSENT_LIST_CLOSED',
          message: messageOf(CONSENT_LIST_CLOSED),
        });
      });

      it('is a retired template when the refusal is named so', () => {
        expect(described(translateRefusal(raw('CL409', 'Raw query failed. Message: `CHECKLIST_TEMPLATE_RETIRED`')))).toEqual({
          status: HttpStatus.CONFLICT,
          code: 'CHECKLIST_TEMPLATE_RETIRED',
          message: messageOf(CHECKLIST_TEMPLATE_RETIRED),
        });
      });

      it('is a retired template when the message carries no name', () => {
        expect(described(translateRefusal(raw('CL409'))).code).toBe('CHECKLIST_TEMPLATE_RETIRED');
        expect(described(translateRefusal(new Error('CL409'))).code).toBe('CHECKLIST_TEMPLATE_RETIRED');
      });

      it('is a retired template when the name is one of another refusal', () => {
        expect(described(translateRefusal(raw('CL409', 'Message: `CHECKLIST_NOT_FOUND`'))).code).toBe('CHECKLIST_TEMPLATE_RETIRED');
      });
    });

    describe('CL422', () => {
      it.each([
        ['CHECKLIST_DATE_IN_THE_FUTURE', CHECKLIST_DATE_IN_THE_FUTURE],
        ['CHECKLIST_INSTRUCTOR_IS_NOT_STAFF', CHECKLIST_INSTRUCTOR_IS_NOT_STAFF],
        ['CHECKLIST_REASON_NEEDED', CHECKLIST_REASON_NEEDED],
        ['CONSENT_NOT_A_CLASS', CONSENT_NOT_A_CLASS],
      ])('keeps the name of a refusal it knows (%s) as the code', (name, code) => {
        expect(described(translateRefusal(raw('CL422', `Raw query failed. Message: \`${name}\``)))).toEqual({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          code,
          message: messageOf(code),
        });
      });

      it('is an unknown pupil when the name is not one it has a sentence for (CHECKLIST_NOT_A_PUPIL)', () => {
        expect(described(translateRefusal(raw('CL422', 'Raw query failed. Message: `CHECKLIST_NOT_A_PUPIL`')))).toEqual({
          status: HttpStatus.UNPROCESSABLE_ENTITY,
          code: 'CHECKLIST_UNKNOWN_PUPIL',
          message: messageOf(CHECKLIST_UNKNOWN_PUPIL),
        });
      });

      it('is an unknown pupil when the message carries no name', () => {
        expect(described(translateRefusal(raw('CL422'))).code).toBe('CHECKLIST_UNKNOWN_PUPIL');
        expect(described(translateRefusal(new Error('x CL422'))).code).toBe('CHECKLIST_UNKNOWN_PUPIL');
      });
    });

    it('answers a refusal that only a message carries, as the adapter reports a model query’s', () => {
      const error = new Error('Invalid `prisma.consentAsk.createMany()` invocation: Code: `CL409`. Message: `CONSENT_LIST_CLOSED`');
      expect(described(translateRefusal(error))).toMatchObject({ status: 409, code: 'CONSENT_LIST_CLOSED' });
    });

    it('is null for anything that is not one of ours', () => {
      expect(translateRefusal(new Error('connection reset'))).toBeNull();
      expect(translateRefusal(raw('KV429'))).toBeNull();
      expect(translateRefusal(raw('23505'))).toBeNull();
      expect(translateRefusal(new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }))).toBeNull();
      expect(translateRefusal(new HttpException('Too many', HttpStatus.TOO_MANY_REQUESTS))).toBeNull();
      expect(translateRefusal(null)).toBeNull();
      expect(translateRefusal(undefined)).toBeNull();
      expect(translateRefusal('CL404')).toBeNull();
    });
  });
});
