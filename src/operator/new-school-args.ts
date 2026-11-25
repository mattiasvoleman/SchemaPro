import { isEmail } from 'class-validator';

/**
 * What `npm run operator:new-school` is asked to do (docs/DEPLOYMENT.md §7). Read from the command line only: the script reads no .env
 * file and no variable but the ones the operator names (see scripts/operator/new-school.ts), so a value that is not on the line the
 * operator typed cannot decide which school is made, or in which database.
 */
export interface NewSchoolArgs {
  name: string;
  slug: string;
  timezone: string;
  admin: { email: string; firstName: string; lastName: string };
  /** The web app's origin: where the invitation's link lands (`<origin>/update-password`). Without it Supabase's own Site URL is used. */
  webUrl?: string;
  /**
   * How the first administrator gets a login. INVITE sends the invitation mail and the person sets their own password, which is also
   * the proof that the project's sender works. PASSWORD makes a confirmed login with a password read from the named environment
   * variable, for an operator who has no sender yet; the password is never an argument and is never printed.
   */
  login: { mode: 'INVITE' } | { mode: 'PASSWORD'; passwordEnv: string };
  /** The host the operator believes DIRECT_URL names. Required with --apply: a stale variable in the shell must not pick the database. */
  expectHost?: string;
  /** False (the default) reads and says what would be done; nothing is written and no mail is sent. */
  apply: boolean;
  /** Write nothing unless the project's own SMTP is verified (Management API). */
  requireSmtp: boolean;
  help: boolean;
}

export type ParsedNewSchoolArgs = { ok: true; args: NewSchoolArgs } | { ok: false; problems: string[] };

const VALUE_OPTIONS = [
  'name',
  'slug',
  'timezone',
  'admin-email',
  'admin-first-name',
  'admin-last-name',
  'web-url',
  'password-env',
  'expect-host',
] as const;
const FLAG_OPTIONS = ['apply', 'require-smtp', 'help'] as const;

export const DEFAULT_TIMEZONE = 'Europe/Stockholm';

/** The slug is the school's short name in URLs and in this script's own idempotence: lower case, digits and single hyphens. */
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function validTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The origin of an http(s) address, or null for anything else. */
function originOf(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

/** An environment variable's name, which is all `--password-env` may be: never the password itself. */
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

export function parseNewSchoolArgs(argv: readonly string[]): ParsedNewSchoolArgs {
  const problems: string[] = [];
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(token);
    if (!match) {
      problems.push(`Unexpected argument "${token}". Every option starts with --.`);
      continue;
    }
    const [, name, inline] = match as unknown as [string, string, string | undefined];
    if ((FLAG_OPTIONS as readonly string[]).includes(name)) {
      if (inline !== undefined) problems.push(`--${name} takes no value.`);
      flags.add(name);
    } else if ((VALUE_OPTIONS as readonly string[]).includes(name)) {
      const value = inline ?? argv[i + 1];
      if (value === undefined || (inline === undefined && value.startsWith('--'))) {
        problems.push(`--${name} needs a value.`);
        continue;
      }
      if (inline === undefined) i += 1;
      if (values.has(name)) problems.push(`--${name} is given twice.`);
      values.set(name, value);
    } else {
      problems.push(`Unknown option --${name}.`);
    }
  }

  const help = flags.has('help');
  if (help) {
    return problems.length ? { ok: false, problems } : { ok: true, args: helpArgs() };
  }

  const need = (name: string): string => {
    const value = values.get(name)?.trim();
    if (!value) problems.push(`--${name} is required.`);
    return value ?? '';
  };

  const name = need('name');
  if (name.length > 200) problems.push('--name is at most 200 characters.');
  const slug = need('slug');
  if (slug && (!SLUG.test(slug) || slug.length > 63)) {
    problems.push('--slug is lower case letters and digits with single hyphens between them, at most 63 characters (for example "ekeby-skola").');
  }
  const timezone = values.get('timezone')?.trim() || DEFAULT_TIMEZONE;
  if (!validTimezone(timezone)) problems.push(`--timezone "${timezone}" is not a time zone name (for example Europe/Stockholm).`);

  const email = need('admin-email');
  if (email && (email.length > 254 || !isEmail(email))) problems.push('--admin-email is not an e-mail address.');
  const firstName = need('admin-first-name');
  const lastName = need('admin-last-name');
  if (firstName.length > 120) problems.push('--admin-first-name is at most 120 characters.');
  if (lastName.length > 120) problems.push('--admin-last-name is at most 120 characters.');

  let webUrl: string | undefined;
  const rawWebUrl = values.get('web-url')?.trim();
  if (rawWebUrl) {
    const origin = originOf(rawWebUrl);
    if (!origin) problems.push('--web-url is the web app\'s address, for example https://app.skolan.se.');
    else webUrl = origin;
  }

  const passwordEnv = values.get('password-env')?.trim();
  if (passwordEnv !== undefined && !ENV_NAME.test(passwordEnv)) {
    problems.push('--password-env names an environment variable (for example ADMIN_PASSWORD), not the password itself.');
  }

  const expectHost = values.get('expect-host')?.trim().toLowerCase();
  const apply = flags.has('apply');
  if (apply && !expectHost) {
    problems.push('--apply needs --expect-host <the database host you mean>: it is compared with the host DIRECT_URL names before anything is written.');
  }

  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    args: {
      name,
      slug,
      timezone,
      admin: { email, firstName, lastName },
      ...(webUrl ? { webUrl } : {}),
      login: passwordEnv ? { mode: 'PASSWORD', passwordEnv } : { mode: 'INVITE' },
      ...(expectHost ? { expectHost } : {}),
      apply,
      requireSmtp: flags.has('require-smtp'),
      help: false,
    },
  };
}

function helpArgs(): NewSchoolArgs {
  return {
    name: '',
    slug: '',
    timezone: DEFAULT_TIMEZONE,
    admin: { email: '', firstName: '', lastName: '' },
    login: { mode: 'INVITE' },
    apply: false,
    requireSmtp: false,
    help: true,
  };
}

/** What the database URL names, without its password: the host the operator checks, and the database. */
export function describeDatabase(databaseUrl: string): { host: string; port: string; database: string } | null {
  try {
    const url = new URL(databaseUrl);
    if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') return null;
    return { host: url.hostname.toLowerCase(), port: url.port || '5432', database: url.pathname.replace(/^\//, '') };
  } catch {
    return null;
  }
}

export const NEW_SCHOOL_USAGE = `Make a new school and its first administrator (docs/DEPLOYMENT.md §7).

  DIRECT_URL=<owner connection> SUPABASE_URL=<project url> SUPABASE_SERVICE_ROLE_KEY=<key> \\
    npm run operator:new-school -- --name "Ekeby skola" --slug ekeby-skola \\
      --admin-email rektor@ekeby.example --admin-first-name Anna --admin-last-name Andersson \\
      --web-url https://app.ekeby.example --expect-host db.<ref>.supabase.co --apply

Without --apply nothing is written and no mail is sent: the script reads, checks the Supabase Auth project and says what it would do.

  --name, --slug, --admin-email, --admin-first-name, --admin-last-name   required
  --timezone <zone>      default ${DEFAULT_TIMEZONE}
  --web-url <origin>     where the invitation's link lands; default: the project's Site URL
  --password-env <NAME>  make a confirmed login with the password in this variable instead of sending an invitation
  --expect-host <host>   the database host you mean; required with --apply
  --require-smtp         write nothing unless the project's own SMTP is verified (needs SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF)
  --apply                do it

The script reads no .env file. It uses only DIRECT_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and, for the checks of the project's
settings, SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF, and the variable --password-env names. Run it again with the same arguments
to continue after a failure: a school and administrator that exist are not made twice.
`;
