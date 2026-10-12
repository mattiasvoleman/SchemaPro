import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PERSONAL_MAIL_DOMAINS, SignInMethodDto } from './dto';

/*
 * The personal mail domains no school may list or pin are written three
 * times: the DTO here, the table's CHECK (migration 20261020090000) and the
 * admin card (sign-in-types.ts), which says so at the field before anything
 * is sent. A domain added to one and not the others would be refused by one
 * layer and offered by another.
 */

const repo = join(__dirname, '..', '..');
const quoted = (text: string) => [...text.matchAll(/['"]([a-z0-9.-]+\.[a-z]+)['"]/g)].map((match) => match[1]).sort();

function listIn(path: string, start: RegExp, end: string): string[] {
  const text = readFileSync(join(repo, path), 'utf8');
  const from = text.search(start);
  expect(from).toBeGreaterThanOrEqual(0);
  return quoted(text.slice(from, text.indexOf(end, from)));
}

const errorsOf = async (body: Record<string, unknown>) =>
  (await validate(plainToInstance(SignInMethodDto, body))).flatMap((error) => Object.keys(error.constraints ?? {}).map((key) => `${error.property}:${key}`));

describe('SignInMethodDto', () => {
  it('refuses a personal mail domain among the domains, after trimming and lowering', async () => {
    expect(await errorsOf({ provider: 'azure', domains: ['skola.example', ' Gmail.COM '], entraTenantId: '2f6a1c3e-8b4d-4f5a-9c7e-1d2b3a4c5e6f' })).toEqual([
      'domains:isNotIn',
    ]);
  });

  it('refuses a personal mail domain as the Workspace domain', async () => {
    expect(await errorsOf({ provider: 'google', domains: ['skola.example'], googleHostedDomain: 'hotmail.se' })).toEqual([
      'googleHostedDomain:isNotIn',
    ]);
  });

  it('takes a school domain, and one that merely contains a personal one', async () => {
    expect(await errorsOf({ provider: 'google', domains: ['skola.example', 'gmail.com.skola.example'], googleHostedDomain: 'skola.example' })).toEqual([]);
  });

  it('holds the same list as the table\'s CHECK and the admin card', () => {
    const own = [...PERSONAL_MAIL_DOMAINS].sort();
    expect(own).toEqual([...new Set(own)].sort());
    expect(
      listIn(
        'prisma/migrations/20261020090000_en_skola_kan_logga_in_med_skolkonto/migration.sql',
        /CONSTRAINT "SchoolSignInMethods_no_personal_mail_domains"/,
        ']::text[]',
      ),
    ).toEqual(own);
    expect(listIn('web/app/[locale]/(app)/admin/integrations/sign-in-types.ts', /export const PERSONAL_MAIL_DOMAINS/, '] as const')).toEqual(own);
  });
});
