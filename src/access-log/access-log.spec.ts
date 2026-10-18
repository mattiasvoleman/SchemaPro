import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
      'GUARDIANS', 'EMPLOYMENT', 'STAFF_ABSENCES', 'ACCESS_LOG', 'SCHEDULE', 'TEACHING_TIME',
    ]);
  });
});

/*
 * A kind is named in four places: the enum (and the migration that adds it),
 * this module, the web's list on /admin/dataskydd and its labels. One left out
 * fails quietly — a recordRead the type checker accepts and Postgres refuses
 * (22P02, the read fails), or a row the page shows as its raw key.
 */
describe('the read log\'s kinds across the schema, the gateway and the web', () => {
  const ROOT = join(__dirname, '..', '..');
  const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
  const ENUM = /enum PersonalDataAccessKind \{([^}]*)\}/
    .exec(read('prisma/schema.prisma'))![1]!
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('///'));

  it('the gateway knows exactly the enum, and a migration adds every value', () => {
    expect([...ACCESS_KINDS]).toEqual(ENUM);
    const migrations = readdirSync(join(ROOT, 'prisma', 'migrations'))
      .filter((dir) => !dir.endsWith('.toml'))
      .map((dir) => read(`prisma/migrations/${dir}/migration.sql`))
      .join('\n');
    for (const kind of ENUM) {
      expect(migrations).toMatch(new RegExp(`'${kind}'`));
    }
  });

  it('the web lists every kind and labels it in Swedish and English', () => {
    const web = /export const ACCESS_KINDS = \[([^\]]*)\]/.exec(read('web/app/[locale]/(app)/admin/dataskydd/use-access-log.ts'))![1]!;
    expect([...web.matchAll(/"([A-Z_]+)"/g)].map((match) => match[1])).toEqual(ENUM);
    for (const locale of ['sv', 'en']) {
      const messages = JSON.parse(read(`web/messages/${locale}.json`)) as Record<string, unknown>;
      const kinds = (((messages['dataProtection'] as Record<string, unknown>)['accessLog'] as Record<string, unknown>)['kinds'] ?? {}) as Record<string, string>;
      expect(Object.keys(kinds).sort()).toEqual([...ENUM].sort());
      for (const kind of ENUM) expect(kinds[kind]?.trim()).toBeTruthy();
    }
  });
});

/*
 * A read that hands out something about other people either records itself
 * or is in access-log.ts's NOT RECORDED list with its own reason. The list is
 * prose, so what is pinned is that an entry is there and says why — not the
 * wording — and that the service it names writes no recordRead.
 */
describe('reads not recorded, by decision', () => {
  const ROOT = join(__dirname, '..', '..');
  const source = readFileSync(join(__dirname, 'access-log.ts'), 'utf8');
  const notRecorded = source.slice(source.indexOf('NOT RECORDED, by decision'), source.indexOf('export const ACCESS_KINDS'));

  it('lists schemaförslag with its own reason: admin-only, ids and aggregates, no pupil', () => {
    const entry = /- schemaförslag \(GET \/optimization\/candidates[\s\S]*?;\n/.exec(notRecorded)?.[0] ?? '';
    expect(entry).not.toBe('');
    expect(entry).toMatch(/administrators/);
    expect(entry).toMatch(/schedule-versions\/:id/);
    expect(entry).toMatch(/no\s+(\*\s+)?studentIds\s+(\*\s+)?and\s+(\*\s+)?no\s+(\*\s+)?participants/);
  });

  it('keeps the decisions it already held beside the new one', () => {
    // The list is the record of each decision; an entry added beside another
    // must not take its place (the counts entry was lost once that way).
    expect(notRecorded).toMatch(/counts and summaries that name nobody \(\/users\/counts/);
  });

  it('and the candidate service records nothing', () => {
    const service = readFileSync(join(ROOT, 'src', 'optimization', 'schedule-candidates.service.ts'), 'utf8');
    expect(service).not.toMatch(/recordRead/);
  });
});
