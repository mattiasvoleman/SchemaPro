import type { PrismaClient } from '@prisma/client';
import { createTxMock } from '../../test/utils/prisma-mock';
import { recordedReads } from '../../test/utils/recorded-reads';
import { ACCESS_KINDS, channelOf, recordRead } from './access-log';

const A = '0b2f6a52-6f4e-4a3e-9d8c-1a2b3c4d5e6f';
const B = '1c3a7b63-7a5f-4b4f-8e9d-2b3c4d5e6f70';

describe('channelOf', () => {
  it('is APP when the app says so, in any case and with spaces', () => {
    expect(channelOf({ 'x-schemapro-client': 'app' })).toBe('APP');
    expect(channelOf({ 'x-schemapro-client': [' APP ', 'web'] })).toBe('APP');
  });

  it('is WEB for a request with an Origin, the browser calling the gateway cross-origin', () => {
    expect(channelOf({ origin: 'https://schemapro.example' })).toBe('WEB');
  });

  it('is OTHER without either, and for a name it does not know', () => {
    expect(channelOf(undefined)).toBe('OTHER');
    expect(channelOf({})).toBe('OTHER');
    expect(channelOf({ 'x-schemapro-client': 'web' })).toBe('OTHER');
    expect(channelOf({ origin: '   ' })).toBe('OTHER');
  });
});

describe('recordRead', () => {
  it('sends one app.personal_data_read with the kind, the channel and each id once', async () => {
    const tx = createTxMock();
    await recordRead(tx as unknown as PrismaClient, 'ROSTER', [A, B, A, '', null, undefined], 'APP');
    expect(recordedReads(tx)).toEqual([{ kind: 'ROSTER', channel: 'APP', ids: [A, B] }]);
    const [statement] = (tx as unknown as { $executeRaw: jest.Mock }).$executeRaw.mock.calls[0] as [{ strings: string[] }];
    expect(statement.strings.join('?')).toMatch(/::"PersonalDataAccessKind"/);
    expect(statement.strings.join('?')).toMatch(/::"PersonalDataAccessChannel"/);
    expect(statement.strings.join('?')).toMatch(/::uuid\[\]/);
  });

  it('sends nothing for a read that names nobody', async () => {
    const tx = createTxMock();
    await recordRead(tx as unknown as PrismaClient, 'PEOPLE', []);
    await recordRead(tx as unknown as PrismaClient, 'PEOPLE', [null, '']);
    expect((tx as unknown as { $executeRaw: jest.Mock }).$executeRaw).not.toHaveBeenCalled();
  });

  it('leaves the channel NULL when the caller has none: the database says OTHER, or INTEGRATION for a key', async () => {
    const tx = createTxMock();
    await recordRead(tx as unknown as PrismaClient, 'EMPLOYMENT', [A]);
    expect(recordedReads(tx)).toEqual([{ kind: 'EMPLOYMENT', channel: null, ids: [A] }]);
  });

  it('fails the read when the log cannot be written', async () => {
    const tx = createTxMock();
    (tx as unknown as { $executeRaw: jest.Mock }).$executeRaw.mockRejectedValueOnce(new Error('PD403'));
    await expect(recordRead(tx as unknown as PrismaClient, 'ROSTER', [A], 'WEB')).rejects.toThrow('PD403');
  });

  it('names the kinds the migration names, the mentor\'s leave reason among them', () => {
    expect(ACCESS_KINDS).toEqual([
      'PEOPLE', 'ROSTER', 'ATTENDANCE', 'ABSENCE_REPORTS', 'LEAVE_REQUESTS', 'LEAVE_REASON_AS_MENTOR',
      'GUARDIANS', 'EMPLOYMENT', 'STAFF_ABSENCES', 'ACCESS_LOG',
    ]);
  });
});
