/**
 * What the operator script can read about the Supabase Auth project before it sends anything (docs/DEPLOYMENT.md §1 and §7).
 *
 * Two readings, both read-only:
 *
 *  - the project's public settings (`GET <url>/auth/v1/settings`), which any client may ask and which says whether public signups are on;
 *  - the project's auth config through Supabase's Management API (`GET https://api.supabase.com/v1/projects/<ref>/config/auth`), which
 *    needs an access token of the operator's own and says whether the project sends through its own SMTP, and how many mails an hour
 *    it lets out. The gateway never has that token, which is why only the operator's own machine can read it.
 *
 * The SMTP password and user are never read out of the answer, and nothing the answer holds but the host, port, sender and the hourly
 * limit is kept.
 */

export type SmtpVerdict =
  /** The project sends through the school's or the operator's own SMTP server. */
  | { kind: 'CUSTOM'; host: string; port: number | null; sender: string | null; perHour: number | null }
  /** Supabase's own sender: a handful of mails an hour, then HTTP 429 over_email_send_rate_limit. */
  | { kind: 'BUILT_IN'; perHour: number | null }
  /** Not read: no access token, or the answer could not be read. */
  | { kind: 'UNKNOWN'; why: string };

export type SignupVerdict = 'DISABLED' | 'ENABLED' | 'UNKNOWN';

export interface AuthSettingsReport {
  signup: SignupVerdict;
  smtp: SmtpVerdict;
}

export interface AuthSettingsInput {
  supabaseUrl: string;
  /** Sent as the `apikey` header of the public settings read; the service-role key the invitation already needs is accepted. */
  apiKey: string;
  accessToken?: string;
  projectRef?: string;
  fetchImpl?: typeof fetch;
  /** Seconds. A project that does not answer is "not read", not a script that hangs. */
  timeoutSeconds?: number;
}

const MANAGEMENT_API = 'https://api.supabase.com';
const PROJECT_REF = /^[a-z0-9]{10,40}$/;

async function getJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>, timeoutSeconds: number): Promise<unknown> {
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutSeconds * 1000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function integerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Whether public signups are off, from the project's public settings. */
export function signupOf(settings: unknown): SignupVerdict {
  const record = asRecord(settings);
  if (!record || typeof record.disable_signup !== 'boolean') return 'UNKNOWN';
  return record.disable_signup ? 'DISABLED' : 'ENABLED';
}

/** The SMTP verdict from the Management API's auth config. Reads host, port, sender and the hourly limit; nothing else. */
export function smtpOf(config: unknown): SmtpVerdict {
  const record = asRecord(config);
  if (!record) return { kind: 'UNKNOWN', why: 'The Management API answered something that is not a config.' };
  const perHour = integerOrNull(record.rate_limit_email_sent);
  const host = typeof record.smtp_host === 'string' ? record.smtp_host.trim() : '';
  if (host === '') return { kind: 'BUILT_IN', perHour };
  const sender = typeof record.smtp_admin_email === 'string' && record.smtp_admin_email.trim() !== '' ? record.smtp_admin_email.trim() : null;
  const rawPort = typeof record.smtp_port === 'string' ? Number(record.smtp_port) : record.smtp_port;
  return { kind: 'CUSTOM', host, port: integerOrNull(rawPort), sender, perHour };
}

export async function checkAuthSettings(input: AuthSettingsInput): Promise<AuthSettingsReport> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeout = input.timeoutSeconds ?? 15;
  const report: AuthSettingsReport = { signup: 'UNKNOWN', smtp: { kind: 'UNKNOWN', why: 'SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF are not set.' } };

  try {
    const settings = await getJson(fetchImpl, `${input.supabaseUrl.replace(/\/+$/, '')}/auth/v1/settings`, { apikey: input.apiKey }, timeout);
    report.signup = signupOf(settings);
  } catch {
    // Not read: the report says UNKNOWN and the operator is told to look in the dashboard.
  }

  if (input.accessToken && input.projectRef) {
    if (!PROJECT_REF.test(input.projectRef)) {
      report.smtp = { kind: 'UNKNOWN', why: 'SUPABASE_PROJECT_REF is the project reference from the dashboard URL, lower case letters and digits.' };
    } else {
      try {
        const config = await getJson(
          fetchImpl,
          `${MANAGEMENT_API}/v1/projects/${input.projectRef}/config/auth`,
          { authorization: `Bearer ${input.accessToken}` },
          timeout,
        );
        report.smtp = smtpOf(config);
        // The config says whether signups are off too; the public settings are asked first and stay the answer when they were read.
        if (report.signup === 'UNKNOWN') {
          const record = asRecord(config);
          if (record && typeof record.disable_signup === 'boolean') report.signup = record.disable_signup ? 'DISABLED' : 'ENABLED';
        }
      } catch (error) {
        const status = error instanceof Error ? error.message : 'no answer';
        report.smtp = { kind: 'UNKNOWN', why: `The Management API could not be read (${status}).` };
      }
    }
  } else if (input.accessToken || input.projectRef) {
    report.smtp = { kind: 'UNKNOWN', why: 'Both SUPABASE_ACCESS_TOKEN and SUPABASE_PROJECT_REF are needed.' };
  }
  return report;
}

/** The report as the lines the operator reads. */
export function describeAuthSettings(report: AuthSettingsReport): string[] {
  const lines: string[] = [];
  if (report.signup === 'DISABLED') lines.push('Public signups:   off (as they should be)');
  else if (report.signup === 'ENABLED') {
    lines.push('Public signups:   ON. Turn off "Allow new users to sign up" (Authentication → Providers → Email): every account here is made by invitation.');
  } else lines.push('Public signups:   not read. Look at Authentication → Providers → Email: "Allow new users to sign up" must be off.');

  const smtp = report.smtp;
  if (smtp.kind === 'CUSTOM') {
    const where = `${smtp.host}${smtp.port ? `:${smtp.port}` : ''}`;
    const limit = smtp.perHour === null ? '' : `, at most ${smtp.perHour} mails an hour`;
    lines.push(`Sender (SMTP):    the project's own SMTP, ${where}${smtp.sender ? ` as ${smtp.sender}` : ''}${limit}`);
    if (smtp.perHour !== null && smtp.perHour > 0 && smtp.perHour <= 30) {
      lines.push(`                  At ${smtp.perHour} an hour a school of 300 people takes ${Math.ceil(300 / smtp.perHour)} hours to invite. Raise the limit under Authentication → Rate Limits before the mass invitation.`);
    }
  } else if (smtp.kind === 'BUILT_IN') {
    lines.push(
      `Sender (SMTP):    Supabase's own sender${smtp.perHour === null ? '' : ` (${smtp.perHour} mails an hour)`}. It is meant for trying things out and lets very few mails through an hour: the first invitations arrive and the rest are refused with HTTP 429. Set the project's own SMTP (Authentication → SMTP) before inviting more than a couple of people.`,
    );
  } else {
    lines.push(`Sender (SMTP):    not read. ${smtp.why} Look at Authentication → SMTP in the dashboard.`);
  }
  return lines;
}
