import { describeAuthProject, describeDatabase, parseNewSchoolArgs, projectRefOfDatabase, SLUG } from './new-school-args';

const BASE = [
  '--name', 'Ekeby skola',
  '--slug', 'ekeby-skola',
  '--admin-email', 'rektor@ekeby.example',
  '--admin-first-name', 'Anna',
  '--admin-last-name', 'Andersson',
];

function ok(argv: string[]) {
  const parsed = parseNewSchoolArgs(argv);
  if (!parsed.ok) throw new Error(parsed.problems.join('; '));
  return parsed.args;
}
function problemsOf(argv: string[]): string[] {
  const parsed = parseNewSchoolArgs(argv);
  if (parsed.ok) throw new Error('expected problems');
  return parsed.problems;
}

describe('parseNewSchoolArgs', () => {
  it('reads the required options and defaults the rest: a dry run, an invitation, Stockholm', () => {
    expect(ok(BASE)).toEqual({
      name: 'Ekeby skola',
      slug: 'ekeby-skola',
      timezone: 'Europe/Stockholm',
      admin: { email: 'rektor@ekeby.example', firstName: 'Anna', lastName: 'Andersson' },
      login: { mode: 'INVITE' },
      apply: false,
      requireSmtp: false,
      help: false,
    });
  });

  it('reads --option=value as well as --option value', () => {
    const args = ok(['--name=Ekeby skola', '--slug=ekeby-skola', '--admin-email=a@ekeby.example', '--admin-first-name=Anna', '--admin-last-name=Andersson', '--timezone=Europe/London']);
    expect(args.name).toBe('Ekeby skola');
    expect(args.timezone).toBe('Europe/London');
  });

  it('--apply needs --expect-host, and keeps it in lower case', () => {
    expect(problemsOf([...BASE, '--apply'])).toEqual([expect.stringContaining('--apply needs --expect-host')]);
    const args = ok([...BASE, '--apply', '--expect-host', 'DB.Ref.Supabase.CO']);
    expect(args.apply).toBe(true);
    expect(args.expectHost).toBe('db.ref.supabase.co');
  });

  it('a dry run may name the host too, and it changes nothing', () => {
    expect(ok([...BASE, '--expect-host', 'localhost']).apply).toBe(false);
  });

  it('--password-env takes the name of a variable and never the password itself', () => {
    expect(ok([...BASE, '--password-env', 'ADMIN_PASSWORD']).login).toEqual({ mode: 'PASSWORD', passwordEnv: 'ADMIN_PASSWORD' });
    expect(problemsOf([...BASE, '--password-env', 'hunter2 is my password'])).toEqual([expect.stringContaining('not the password itself')]);
    expect(problemsOf([...BASE, '--password-env', 'a-b'])).toHaveLength(1);
  });

  it('--web-url becomes its origin, and only an http(s) address is one', () => {
    expect(ok([...BASE, '--web-url', 'https://app.ekeby.example/some/path?x=1']).webUrl).toBe('https://app.ekeby.example');
    expect(problemsOf([...BASE, '--web-url', 'javascript:alert(1)'])).toEqual([expect.stringContaining('--web-url')]);
    expect(problemsOf([...BASE, '--web-url', 'not a url'])).toHaveLength(1);
  });

  it.each([
    ['Ekeby', false],
    ['ekeby skola', false],
    ['ekeby--skola', false],
    ['-ekeby', false],
    ['ekeby-', false],
    ['ekeby_skola', false],
    ['', false],
    ['ekeby', true],
    ['ekeby-skola-2', true],
    ['7a', true],
    ['x'.repeat(63), true],
  ])('the slug %j is %s', (slug, valid) => {
    expect(SLUG.test(slug) && slug.length <= 63 && slug !== '').toBe(valid);
  });

  it('a slug of 64 characters is refused', () => {
    expect(problemsOf(['--name', 'X', '--slug', 'a'.repeat(64), '--admin-email', 'a@b.example', '--admin-first-name', 'A', '--admin-last-name', 'B'])).toEqual([expect.stringContaining('--slug')]);
  });

  it('refuses an e-mail address that is not one, a time zone that is not one, and names that are too long', () => {
    expect(problemsOf(BASE.map((v) => (v === 'rektor@ekeby.example' ? 'rektor@' : v)))).toEqual([expect.stringContaining('--admin-email')]);
    expect(problemsOf([...BASE, '--timezone', 'Mars/Olympus'])).toEqual([expect.stringContaining('--timezone')]);
    expect(problemsOf(BASE.map((v) => (v === 'Anna' ? 'A'.repeat(121) : v)))).toEqual([expect.stringContaining('--admin-first-name')]);
    expect(problemsOf(BASE.map((v) => (v === 'Ekeby skola' ? 'E'.repeat(201) : v)))).toEqual([expect.stringContaining('--name')]);
  });

  it('names every missing option at once', () => {
    expect(problemsOf([])).toEqual([
      '--name is required.',
      '--slug is required.',
      '--admin-email is required.',
      '--admin-first-name is required.',
      '--admin-last-name is required.',
    ]);
  });

  it('refuses an unknown option, a stray word, a value-less option, a repeated one and a flag with a value', () => {
    expect(problemsOf([...BASE, '--frobnicate'])).toEqual(['Unknown option --frobnicate.']);
    expect(problemsOf([...BASE, 'stray'])).toEqual([expect.stringContaining('Unexpected argument "stray"')]);
    expect(problemsOf([...BASE, '--timezone'])).toEqual(['--timezone needs a value.']);
    expect(problemsOf([...BASE, '--timezone', '--apply'])).toContain('--timezone needs a value.');
    expect(problemsOf([...BASE, '--slug', 'x'])).toEqual(['--slug is given twice.']);
    expect(problemsOf([...BASE, '--apply=yes', '--expect-host', 'h'])).toEqual(['--apply takes no value.']);
  });

  it('--help needs nothing else and says so', () => {
    expect(ok(['--help']).help).toBe(true);
    expect(problemsOf(['--help', '--nope'])).toHaveLength(1);
  });

  it('--require-smtp is a flag', () => {
    expect(ok([...BASE, '--require-smtp']).requireSmtp).toBe(true);
  });
});

describe('describeDatabase', () => {
  it('names the host, the port and the database, and never the password', () => {
    const named = describeDatabase('postgresql://postgres:s3cret@DB.ref.supabase.co:5432/postgres?sslmode=require');
    expect(named).toEqual({ host: 'db.ref.supabase.co', port: '5432', database: 'postgres' });
    expect(JSON.stringify(named)).not.toContain('s3cret');
  });

  it('defaults the port, and reads postgres:// too', () => {
    expect(describeDatabase('postgres://u:p@localhost/schemapro')).toEqual({ host: 'localhost', port: '5432', database: 'schemapro' });
  });

  it('is null for anything that is not a Postgres address', () => {
    expect(describeDatabase('mysql://u:p@h/db')).toBeNull();
    expect(describeDatabase('not a url')).toBeNull();
  });
});

describe('which Supabase project an address belongs to', () => {
  it('reads the project from the direct host and from the pooler user, and from nothing else', () => {
    expect(projectRefOfDatabase('postgresql://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres?sslmode=require')).toBe('abcdefghijklmnop');
    expect(projectRefOfDatabase('postgresql://postgres.abcdefghijklmnop:pw@aws-0-eu-north-1.pooler.supabase.com:5432/postgres')).toBe('abcdefghijklmnop');
    expect(projectRefOfDatabase('postgresql://postgres:pw@localhost:5432/schemapro')).toBeNull();
    expect(projectRefOfDatabase('postgresql://postgres:pw@db.short.supabase.co/postgres')).toBeNull();
    expect(projectRefOfDatabase('not an address')).toBeNull();
  });

  it('reads the project of the Auth url, and its host, and says nothing of an address that is not one', () => {
    expect(describeAuthProject('https://abcdefghijklmnop.supabase.co')).toEqual({ host: 'abcdefghijklmnop.supabase.co', ref: 'abcdefghijklmnop' });
    expect(describeAuthProject('http://127.0.0.1:8946')).toEqual({ host: '127.0.0.1', ref: null });
    expect(describeAuthProject('auth.skolan.example')).toBeNull();
  });
});
