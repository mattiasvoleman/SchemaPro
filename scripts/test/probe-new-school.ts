/**
 * The operator script that makes a school and its first administrator (P3 Första veckan utan operatören, scripts/operator/new-school.ts)
 * against a real database, with a stand-in for the Supabase Auth admin API (what the real one answers is shown by the proof the PR
 * describes, run against Supabase's own GoTrue and a mailbox).
 *
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-new-school.ts
 *
 * The jest specs (src/operator) hold the argument rules, the Auth settings reading and the login calls with no database. This holds
 * what a database adds:
 *
 *   (1) a DRY RUN writes nothing, and says what it would do;
 *   (2) --apply makes the school and the administrator in ONE transaction: a failure inside leaves neither (no school with nobody in
 *       it), and a made school has its administrator as SCHOOL_ADMIN with the FULL profile and `invitedAt` set when the login is
 *       attached, never before;
 *   (3) a run that stopped before the login (the project refused to send) leaves the school and a row nobody can sign in as
 *       (`invitedAt` null), and the same command continues from the login: ONE school, ONE administrator, and the login made once;
 *   (4) run again after it is done, nothing is made and nothing is sent;
 *   (5) a slug that holds another school (other people, or another administrator) is REFUSED and its rows are the same after;
 *   (6) the wrong host is refused before anything is read or written, and so is --apply without --expect-host;
 *   (6b) an Auth project that is not the database's project (a stale SUPABASE_URL) is said and refused before anything is written;
 *   (7) a login another school's person holds is NOT taken by this administrator: the row stays un-invited (the database's trigger,
 *       Users_a_login_joins_another_school_by_invitation), and the other school's row is the same after;
 *   (8) --require-smtp writes nothing unless the project's own SMTP was verified.
 *
 * It makes its own schools (a slug with the run's tag in it) and drops every one of them.
 */
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createPgAdapter } from '../../src/database/pool-config';
import { type AuthSettingsReport } from '../../src/operator/auth-settings';
import { type AuthAdminAnswer, type AuthAdminClient } from '../../src/operator/first-login';
import { parseNewSchoolArgs, type NewSchoolArgs } from '../../src/operator/new-school-args';
import { makeSchoolAndAdministrator, runNewSchool, type NewSchoolDeps } from '../operator/new-school';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
}

let failures = 0;
async function check(label: string, body: () => Promise<void>): Promise<void> {
  try {
    await body();
    console.log(`ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${label}\n     ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  }
}

const tag = randomUUID().slice(0, 8);
const slugOf = (key: string): string => `probe-ns-${key}-${tag}`;
const emailOf = (key: string): string => `rektor-${key}-${tag}@example.com`;

/** The admin API as far as the script uses it: a login per address, a mail counted per invitation, and a refusal that can be switched on. */
class FakeAuth implements AuthAdminClient {
  readonly logins = new Map<string, string>();
  invitations = 0;
  refuseWith: { message: string; status: number; code?: string } | null = null;
  auth = {
    admin: {
      inviteUserByEmail: async (email: string, options?: { data?: object }): Promise<AuthAdminAnswer> => {
        if (this.refuseWith) return { data: { user: null }, error: this.refuseWith };
        const known = this.logins.get(email.toLowerCase());
        if (known) return { data: { user: null }, error: { message: 'A user with this email address has already been registered', status: 422, code: 'email_exists' } };
        const id = randomUUID();
        this.logins.set(email.toLowerCase(), id);
        this.invitations += 1;
        return { data: { user: { id, email, user_metadata: options?.data as Record<string, unknown> } }, error: null };
      },
      createUser: async (attributes: { email: string }): Promise<AuthAdminAnswer> => {
        const id = randomUUID();
        this.logins.set(attributes.email.toLowerCase(), id);
        return { data: { user: { id, email: attributes.email } }, error: null };
      },
      updateUserById: async () => ({ error: null }),
      listUsers: async () => ({
        data: { users: [...this.logins].map(([email, id]) => ({ id, email })) },
        error: null,
      }),
    },
  };
}

function argsOf(key: string, extra: string[] = []): NewSchoolArgs {
  const parsed = parseNewSchoolArgs([
    '--name', `Probe skola ${key} ${tag}`,
    '--slug', slugOf(key),
    '--admin-email', emailOf(key),
    '--admin-first-name', 'Anna',
    '--admin-last-name', `Probe${key}`,
    '--expect-host', 'localhost',
    ...extra,
  ]);
  if (!parsed.ok) throw new Error(parsed.problems.join('; '));
  return parsed.args;
}

const CUSTOM_SMTP: AuthSettingsReport = { signup: 'DISABLED', smtp: { kind: 'CUSTOM', host: 'smtp.example.com', port: 587, sender: 'noreply@example.com', perHour: 100 } };

async function main(): Promise<void> {
  const ownerUrl = requiredEnv('PROBE_OWNER_URL');
  const prisma = new PrismaClient({ adapter: createPgAdapter(ownerUrl) });
  const database = { host: 'localhost', port: '5432', database: 'schemapro' };
  const made: string[] = [];

  const deps = (auth: FakeAuth | null, settings: AuthSettingsReport | null = null): NewSchoolDeps => ({ db: prisma, auth, settings, database });
  const schoolOf = (slug: string) =>
    prisma.school.findUnique({ where: { slug }, select: { id: true, name: true, timezone: true, users: { select: { id: true, role: true, adminProfile: true, invitedAt: true, authId: true, email: true, isActive: true } } } });

  try {
    await check('(1) a dry run writes nothing and says what it would do', async () => {
      const args = argsOf('dry');
      const outcome = await runNewSchool(args, deps(new FakeAuth()));
      assert.equal(outcome.exitCode, 0);
      assert.equal(outcome.state, 'ABSENT');
      assert.match(outcome.lines.join('\n'), /Dry run: nothing was written/);
      assert.equal(await schoolOf(args.slug), null);
    });

    await check('(2) --apply makes the school and its administrator, and the login is attached last', async () => {
      const auth = new FakeAuth();
      const args = argsOf('one', ['--apply']);
      const outcome = await runNewSchool(args, deps(auth));
      assert.equal(outcome.exitCode, 0, outcome.lines.join('\n'));
      assert.equal(outcome.login, 'INVITED');
      const school = await schoolOf(args.slug);
      assert.ok(school);
      made.push(school.id);
      assert.equal(school.timezone, 'Europe/Stockholm');
      assert.equal(school.users.length, 1);
      const [admin] = school.users;
      assert.equal(admin!.role, 'SCHOOL_ADMIN');
      assert.equal(admin!.adminProfile, 'FULL');
      assert.equal(admin!.isActive, true);
      assert.ok(admin!.invitedAt, 'invitedAt is set: the row says the person has a login');
      assert.equal(admin!.authId, auth.logins.get(args.admin.email.toLowerCase()), 'the row holds the login Supabase made');
      assert.equal(auth.invitations, 1);
    });

    await check('(2b) the school and the administrator are made in one transaction: a failure after the school leaves neither', async () => {
      const args = argsOf('tx', ['--apply']);
      // The real transaction, with the administrator's insert made to fail after the school's has gone in.
      const failing = {
        $transaction: <T>(body: (tx: PrismaClient) => Promise<T>) =>
          prisma.$transaction((tx) =>
            body(Object.assign(Object.create(tx), { user: { create: () => Promise.reject(new Error('the administrator could not be written')) } })),
          ),
      } as unknown as Pick<PrismaClient, '$transaction'>;
      await assert.rejects(makeSchoolAndAdministrator(failing, args), /could not be written/);
      assert.equal(await schoolOf(args.slug), null, 'no school with nobody in it was left behind');
      assert.equal(await prisma.user.count({ where: { email: args.admin.email } }), 0);
    });

    await check('(3) a project that refuses to send leaves a row nobody can sign in as, and the same command continues', async () => {
      const auth = new FakeAuth();
      auth.refuseWith = { message: 'email rate limit exceeded', status: 429, code: 'over_email_send_rate_limit' };
      const args = argsOf('resume', ['--apply']);
      const first = await runNewSchool(args, deps(auth));
      assert.equal(first.exitCode, 1);
      assert.match(first.lines.join('\n'), /mail limit is spent/);
      const school = await schoolOf(args.slug);
      made.push(school!.id);
      assert.equal(school!.users.length, 1);
      assert.equal(school!.users[0]!.invitedAt, null, 'nobody invited: the row is no login');
      const placeholder = school!.users[0]!.authId;

      auth.refuseWith = null;
      const second = await runNewSchool(args, deps(auth));
      assert.equal(second.exitCode, 0, second.lines.join('\n'));
      assert.equal(second.state, 'MADE');
      assert.match(second.lines.join('\n'), /continues from the login/);
      const after = await schoolOf(args.slug);
      assert.equal(after!.users.length, 1, 'one administrator, not two');
      assert.ok(after!.users[0]!.invitedAt);
      assert.notEqual(after!.users[0]!.authId, placeholder);
      assert.equal(auth.invitations, 1, 'the invitation went out once');
      assert.equal(await prisma.school.count({ where: { slug: args.slug } }), 1);
    });

    await check('(4) run again when it is done: nothing is made and nothing is sent', async () => {
      const auth = new FakeAuth();
      const args = argsOf('one', ['--apply']);
      const before = await schoolOf(args.slug);
      const outcome = await runNewSchool(args, deps(auth));
      assert.equal(outcome.exitCode, 0);
      assert.equal(outcome.state, 'DONE');
      assert.equal(auth.invitations, 0);
      assert.deepEqual(await schoolOf(args.slug), before);
    });

    await check('(5) a slug that holds another school is refused, and its rows are the same after', async () => {
      const auth = new FakeAuth();
      const base = argsOf('one', ['--apply']);
      const other: NewSchoolArgs = { ...base, admin: { email: emailOf('other'), firstName: 'Bo', lastName: 'Berg' } };
      const before = await schoolOf(base.slug);
      const outcome = await runNewSchool(other, deps(auth));
      assert.equal(outcome.exitCode, 1);
      assert.equal(outcome.state, 'OCCUPIED');
      assert.match(outcome.lines.join('\n'), /not the one this command makes/);
      assert.equal(auth.invitations, 0);
      assert.deepEqual(await schoolOf(base.slug), before);
    });

    await check('(6) the wrong host is refused before anything is written', async () => {
      const auth = new FakeAuth();
      const args: NewSchoolArgs = { ...argsOf('wrong', ['--apply']), expectHost: 'db.example.supabase.co' };
      const outcome = await runNewSchool(args, deps(auth));
      assert.equal(outcome.exitCode, 2);
      assert.equal(await schoolOf(args.slug), null);
      assert.equal(auth.invitations, 0);
      const noHost = parseNewSchoolArgs(['--name', 'X', '--slug', 'x', '--admin-email', 'a@b.example', '--admin-first-name', 'A', '--admin-last-name', 'B', '--apply']);
      assert.equal(noHost.ok, false);
    });

    await check('(6b) an Auth project that is not the database\'s is said, and refused before anything is written', async () => {
      const auth = new FakeAuth();
      const args = argsOf('stale', ['--apply']);
      const mine = { host: 'localhost', port: '5432', database: 'schemapro', ref: 'aaaaaaaaaaaa' };
      const refused = await runNewSchool(args, { ...deps(auth), database: mine, authProject: { host: 'bbbbbbbbbbbb.supabase.co', ref: 'bbbbbbbbbbbb' } });
      assert.equal(refused.exitCode, 2, refused.lines.join('\n'));
      assert.equal(refused.state, 'REFUSED');
      assert.match(refused.lines.join('\n'), /project aaaaaaaaaaaa and SUPABASE_URL is project bbbbbbbbbbbb/);
      assert.equal(await schoolOf(args.slug), null, 'nothing was written');
      assert.equal(auth.invitations, 0, 'no mail went from the other project');
      // The same project is said and goes on; an Auth url that names no project (a local GoTrue) is said and goes on.
      const dry = argsOf('stale');
      const same = await runNewSchool(dry, { ...deps(auth), database: mine, authProject: { host: 'aaaaaaaaaaaa.supabase.co', ref: 'aaaaaaaaaaaa' } });
      assert.equal(same.exitCode, 0);
      assert.match(same.lines.join('\n'), /Auth project:     aaaaaaaaaaaa\.supabase\.co/);
      const local = await runNewSchool(dry, { ...deps(auth), database: mine, authProject: { host: '127.0.0.1', ref: null } });
      assert.equal(local.exitCode, 0);
    });

    await check('(7) a login another school holds is not taken: the row stays un-invited, and the other school is untouched', async () => {
      const auth = new FakeAuth();
      const holder = argsOf('one');
      // The login the fake hands out for this address is the one school (2) holds.
      auth.logins.set(emailOf('shared'), (await schoolOf(holder.slug))!.users[0]!.authId);
      const args = argsOf('shared', ['--apply']);
      const before = await schoolOf(holder.slug);
      const outcome = await runNewSchool(args, deps(auth));
      assert.equal(outcome.exitCode, 1, outcome.lines.join('\n'));
      assert.match(outcome.lines.join('\n'), /another school/);
      const school = await schoolOf(args.slug);
      made.push(school!.id);
      assert.equal(school!.users.length, 1);
      assert.equal(school!.users[0]!.invitedAt, null, 'the row did not take the login');
      assert.deepEqual(await schoolOf(holder.slug), before, 'the school that holds the login is the same row for row');
    });

    await check('(8) --require-smtp writes nothing unless the project\'s own SMTP is verified', async () => {
      const auth = new FakeAuth();
      const args = argsOf('smtp', ['--apply', '--require-smtp']);
      const unknown = await runNewSchool(args, deps(auth, { signup: 'DISABLED', smtp: { kind: 'UNKNOWN', why: 'no token' } }));
      assert.equal(unknown.exitCode, 2);
      const builtIn = await runNewSchool(args, deps(auth, { signup: 'DISABLED', smtp: { kind: 'BUILT_IN', perHour: 2 } }));
      assert.equal(builtIn.exitCode, 2);
      const none = await runNewSchool(args, deps(auth, null));
      assert.equal(none.exitCode, 2);
      assert.equal(await schoolOf(args.slug), null);
      assert.equal(auth.invitations, 0);
      const custom = await runNewSchool(args, deps(auth, CUSTOM_SMTP));
      assert.equal(custom.exitCode, 0, custom.lines.join('\n'));
      made.push((await schoolOf(args.slug))!.id);
      assert.equal(auth.invitations, 1);
    });
  } finally {
    // The schools, and the people in them, are the probe's own: a delete cascades through the school's rows.
    for (const slug of [slugOf('one'), slugOf('tx'), slugOf('resume'), slugOf('shared'), slugOf('smtp'), slugOf('dry'), slugOf('wrong')]) {
      await prisma.school.deleteMany({ where: { slug } });
    }
    await prisma.$disconnect();
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
