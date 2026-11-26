/**
 * Make a new school and its first administrator: docs/DEPLOYMENT.md §7, in place of the SQL that section used to hand the operator.
 *
 *   DIRECT_URL=… SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     npm run operator:new-school -- --name "Ekeby skola" --slug ekeby-skola --admin-email rektor@ekeby.example \
 *       --admin-first-name Anna --admin-last-name Andersson --web-url https://app.ekeby.example \
 *       --expect-host db.<ref>.supabase.co --apply
 *
 * Without --apply it reads and says what it would do. `--help` lists the options.
 *
 * WHAT IT HOLDS TO
 *  - It reads no .env file and no variable but the ones it names (DIRECT_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *    SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, and the one --password-env names). Which database it writes in is on the line the
 *    operator typed: --apply needs --expect-host, which is compared with the host DIRECT_URL names before anything is written.
 *  - The school and its administrator are written in ONE transaction, so there is no moment when the school has nobody in it (the
 *    demo seed takes such a school for no school at all; §7 used to warn about the gap between two statements).
 *  - The administrator's `invitedAt` is set when the login is attached, which is what makes gallring and the school-account checks
 *    count the person (§7, §11). The row is written before the login is made, and the login is attached last, as UsersService
 *    does: a login that could not be made leaves a row that is nobody's, and the same command continues from there.
 *  - It is safe to run twice. A school and an administrator that exist are found by the slug and the address and not made again. A
 *    slug that holds anything else is refused, and nothing is written.
 *  - It never prints a key, a password or the database password.
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { createClient } from '@supabase/supabase-js';
import { createPgAdapter } from '../../src/database/pool-config';
import { checkAuthSettings, describeAuthSettings, type AuthSettingsReport } from '../../src/operator/auth-settings';
import { makeFirstLogin, FirstLoginError, type AuthAdminClient, type FirstLoginResult } from '../../src/operator/first-login';
import {
  describeAuthProject,
  describeDatabase,
  NEW_SCHOOL_USAGE,
  parseNewSchoolArgs,
  projectRefOfDatabase,
  type NewSchoolArgs,
} from '../../src/operator/new-school-args';

/** What the database holds under the slug the operator named. People are counted, never named. */
export type SchoolState =
  | { kind: 'ABSENT' }
  /** The school and its one administrator exist and the administrator has no login yet: a run that stopped before the login. */
  | { kind: 'ADMIN_WAITING'; schoolId: string; adminId: string }
  | { kind: 'DONE'; schoolId: string; adminId: string; invitedAt: Date }
  | { kind: 'OCCUPIED'; reason: string };

type Db = Pick<PrismaClient, 'school' | 'user' | '$transaction'>;

export async function readSchoolState(db: Pick<PrismaClient, 'school'>, args: NewSchoolArgs): Promise<SchoolState> {
  const school = await db.school.findUnique({
    where: { slug: args.slug },
    select: { id: true, name: true, users: { select: { id: true, email: true, role: true, invitedAt: true } } },
  });
  if (!school) return { kind: 'ABSENT' };
  const [only] = school.users;
  // `email` is nullable from the migration 20270310090000 (a pupil or a guardian may have none), which is not on this branch: read as
  // the column is, so that the script compiles and answers the same on both sides of that merge. An administrator always has one.
  if (school.users.length === 1 && only && only.role === 'SCHOOL_ADMIN' && (only.email ?? '').toLowerCase() === args.admin.email.toLowerCase()) {
    return only.invitedAt
      ? { kind: 'DONE', schoolId: school.id, adminId: only.id, invitedAt: only.invitedAt }
      : { kind: 'ADMIN_WAITING', schoolId: school.id, adminId: only.id };
  }
  const people = school.users.length;
  return {
    kind: 'OCCUPIED',
    reason: `A school with the slug "${args.slug}" exists and is not the one this command makes: it has ${people} ${people === 1 ? 'person' : 'people'}, and ${people === 1 ? 'that person is' : 'they are'} not the administrator named. Nothing is written. Pick another slug, or look at the school in Admin → People.`,
  };
}

/** The school and the administrator, in one transaction, the administrator with no login yet (a placeholder authId nobody holds). */
export async function makeSchoolAndAdministrator(db: Pick<PrismaClient, '$transaction'>, args: NewSchoolArgs): Promise<{ schoolId: string; adminId: string }> {
  return db.$transaction(async (tx) => {
    const school = await tx.school.create({ data: { name: args.name, slug: args.slug, timezone: args.timezone }, select: { id: true } });
    const admin = await tx.user.create({
      data: {
        schoolId: school.id,
        authId: randomUUID(),
        invitedAt: null,
        role: 'SCHOOL_ADMIN',
        adminProfile: 'FULL',
        hrRead: false,
        firstName: args.admin.firstName,
        lastName: args.admin.lastName,
        email: args.admin.email,
      },
      select: { id: true },
    });
    return { schoolId: school.id, adminId: admin.id };
  });
}

/** Attaches the login to the administrator's row and stamps `invitedAt`: the row says the person has a login from here on. */
export async function attachLogin(db: Pick<PrismaClient, 'user'>, adminId: string, authId: string, now: Date): Promise<void> {
  await db.user.update({ where: { id: adminId }, data: { authId, invitedAt: now } });
}

export interface NewSchoolDeps {
  db: Db;
  /** The project's Admin API; null when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY were not given. */
  auth: AuthAdminClient | null;
  /** What `checkAuthSettings` read, or null when it was not asked. */
  settings: AuthSettingsReport | null;
  /** What DIRECT_URL names, without its password. `ref` is the Supabase project it belongs to, when it says so. */
  database: { host: string; port: string; database: string; ref?: string | null };
  /** What SUPABASE_URL names: the Auth project the login is made in. Absent when it was not given. */
  authProject?: { host: string; ref: string | null };
  /** The password --password-env named, when it was set. */
  password?: string;
  now?: () => Date;
}

export interface NewSchoolOutcome {
  exitCode: 0 | 1 | 2;
  lines: string[];
  /** For a caller that is a probe: what was done. */
  state: SchoolState['kind'] | 'MADE' | 'REFUSED';
  login?: FirstLoginResult['how'];
}

const MIN_PASSWORD = 12;

export async function runNewSchool(args: NewSchoolArgs, deps: NewSchoolDeps): Promise<NewSchoolOutcome> {
  const lines: string[] = [];
  const say = (...text: string[]) => lines.push(...text);
  const { host, port, database } = deps.database;

  say(`Database:         ${host}:${port}/${database}`);
  if (args.apply && args.expectHost !== host) {
    say(`DIRECT_URL names the host "${host}", and --expect-host says "${args.expectHost ?? ''}". Nothing is written. Say which database you mean.`);
    return { exitCode: 2, lines, state: 'REFUSED' };
  }
  // The login is made at the project SUPABASE_URL names and the row in the database DIRECT_URL names, and a stale variable in the shell can
  // pick either: --expect-host holds the database, so the project is said, and refused when both say which Supabase project they are
  // and it is not the same one (a school's row in one project's database with a login made, and a mail sent, from another's).
  if (deps.authProject) {
    say(`Auth project:     ${deps.authProject.host}`);
    const databaseRef = deps.database.ref ?? null;
    if (databaseRef !== null && deps.authProject.ref !== null && databaseRef !== deps.authProject.ref) {
      say(`DIRECT_URL is the database of Supabase project ${databaseRef} and SUPABASE_URL is project ${deps.authProject.ref}. Nothing is written. Say which project you mean.`);
      return { exitCode: 2, lines, state: 'REFUSED' };
    }
  }
  say(`School:           ${args.name} (slug ${args.slug}, ${args.timezone})`);
  say(`Administrator:    ${args.admin.firstName} ${args.admin.lastName} <${args.admin.email}>`);
  say(`Login:            ${args.login.mode === 'INVITE' ? 'an invitation mail, the person sets their own password' : 'a confirmed login with the password the operator gave'}`);

  if (deps.settings) say('', ...describeAuthSettings(deps.settings), '');
  else say('', 'The Supabase Auth project was not checked (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set).', '');

  if (args.requireSmtp && deps.settings?.smtp.kind !== 'CUSTOM') {
    say('--require-smtp: the project\'s own SMTP is not verified, so nothing is written.');
    return { exitCode: 2, lines, state: 'REFUSED' };
  }

  const state = await readSchoolState(deps.db, args);
  if (state.kind === 'OCCUPIED') {
    say(state.reason);
    return { exitCode: 1, lines, state: 'OCCUPIED' };
  }
  if (state.kind === 'DONE') {
    say(
      `The school and its administrator are made already (the administrator was given a login ${state.invitedAt.toISOString()}). Nothing is done.`,
      'If the administrator never got a mail, "Forgot password" on the sign-in page sends one through the same sender.',
    );
    return { exitCode: 0, lines, state: 'DONE' };
  }

  say(
    state.kind === 'ADMIN_WAITING'
      ? 'The school and the administrator\'s row exist from an earlier run that stopped before the login. It continues from the login.'
      : 'The school and the administrator do not exist. They are made in one transaction, then the login.',
  );
  if (!args.apply) {
    say('', 'Dry run: nothing was written and no mail was sent. Run the same command with --apply --expect-host <host> to do it.');
    return { exitCode: 0, lines, state: state.kind };
  }

  if (!deps.auth) {
    say('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are needed to make the login. Nothing is written.');
    return { exitCode: 2, lines, state: 'REFUSED' };
  }
  if (args.login.mode === 'PASSWORD' && (deps.password === undefined || deps.password.length < MIN_PASSWORD)) {
    say(`${args.login.passwordEnv} is not set, or is shorter than ${MIN_PASSWORD} characters. Nothing is written.`);
    return { exitCode: 2, lines, state: 'REFUSED' };
  }

  let adminId: string;
  if (state.kind === 'ADMIN_WAITING') {
    adminId = state.adminId;
  } else {
    const made = await makeSchoolAndAdministrator(deps.db, args);
    adminId = made.adminId;
    say(`Made the school and the administrator's row (${made.schoolId}).`);
  }

  let login: FirstLoginResult;
  try {
    login = await makeFirstLogin(deps.auth, {
      email: args.admin.email,
      userId: adminId,
      ...(args.webUrl ? { redirectTo: `${args.webUrl}/update-password` } : {}),
      ...(args.login.mode === 'PASSWORD' ? { password: deps.password! } : {}),
    });
  } catch (error) {
    say('', error instanceof FirstLoginError ? error.message : `The login could not be made: ${error instanceof Error ? error.message : String(error)}`);
    say('The school and the administrator\'s row stay as they are. Run the same command again to continue from the login.');
    return { exitCode: 1, lines, state: 'MADE' };
  }

  try {
    await attachLogin(deps.db, adminId, login.authId, (deps.now ?? (() => new Date()))());
  } catch (error) {
    say(
      '',
      `The login exists at Supabase, but the administrator's row could not take it: ${error instanceof Error ? error.message.split('\n').pop() : String(error)}`,
      'That is what happens when the login is another school\'s too: a person joins a second school by that school\'s own invitation, not from here. Use another address for this administrator, or invite the person from the other school.',
    );
    return { exitCode: 1, lines, state: 'MADE', login: login.how };
  }

  say(
    login.how === 'INVITED'
      ? `An invitation mail has gone to ${args.admin.email}. The first sign-in is from the link in it, where the person sets a password. If it does not arrive in a few minutes, look in the spam folder, and at Authentication → SMTP.`
      : login.how === 'CREATED'
        ? `The login is made with the password you gave, confirmed. Sign in at the web app with ${args.admin.email} and change it.`
        : `The address already had a login at Supabase. It was adopted, no mail went out, and the person signs in as before.`,
  );
  return { exitCode: 0, lines, state: 'MADE', login: login.how };
}

async function main(): Promise<number> {
  const parsed = parseNewSchoolArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.problems.map((problem) => `  ${problem}`).join('\n'));
    console.error('\nSee --help.');
    return 2;
  }
  if (parsed.args.help) {
    console.log(NEW_SCHOOL_USAGE);
    return 0;
  }
  const { args } = parsed;
  const env = process.env;

  const databaseUrl = env.DIRECT_URL;
  const database = databaseUrl ? describeDatabase(databaseUrl) : null;
  if (!databaseUrl || !database) {
    console.error('Set DIRECT_URL to the owner connection, a postgresql:// address. This script reads no .env file.');
    return 2;
  }

  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  let auth: AuthAdminClient | null = null;
  let settings: AuthSettingsReport | null = null;
  if (supabaseUrl && serviceKey) {
    auth = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } }) as unknown as AuthAdminClient;
    settings = await checkAuthSettings({
      supabaseUrl,
      apiKey: serviceKey,
      ...(env.SUPABASE_ACCESS_TOKEN ? { accessToken: env.SUPABASE_ACCESS_TOKEN } : {}),
      ...(env.SUPABASE_PROJECT_REF ? { projectRef: env.SUPABASE_PROJECT_REF } : {}),
    });
  }

  const password = args.login.mode === 'PASSWORD' ? env[args.login.passwordEnv] : undefined;
  const prisma = new PrismaClient({ adapter: createPgAdapter(databaseUrl) });
  try {
    const authProject = supabaseUrl ? describeAuthProject(supabaseUrl) : null;
    const outcome = await runNewSchool(args, {
      db: prisma,
      auth,
      settings,
      database: { ...database, ref: projectRefOfDatabase(databaseUrl) },
      ...(authProject ? { authProject } : {}),
      ...(password !== undefined ? { password } : {}),
    });
    console.log(outcome.lines.join('\n'));
    return outcome.exitCode;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
