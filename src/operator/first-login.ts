import { randomUUID } from 'node:crypto';
import { CREATED_FOR_ROW } from '../users/supabase-admin.service';

/**
 * The first administrator's login at Supabase Auth, made by the operator script (docs/DEPLOYMENT.md §7).
 *
 * The gateway makes every other login: UsersService invites through SupabaseAdminService. The first one cannot go that way (nobody
 * can sign in to ask), and it is the one that proves the project can send mail at all, so it is made here with the same admin calls
 * and the same tag (CREATED_FOR_ROW), which is what later lets the row's invitation move or delete the login as its own.
 */

/** The corner of supabase-js's admin client this uses, so that a spec can stand in for it. */
export interface AuthAdminClient {
  auth: {
    admin: {
      inviteUserByEmail(email: string, options?: { redirectTo?: string; data?: object }): Promise<AuthAdminAnswer>;
      createUser(attributes: {
        email: string;
        password: string;
        email_confirm: boolean;
        app_metadata?: object;
      }): Promise<AuthAdminAnswer>;
      updateUserById(id: string, attributes: { app_metadata?: object; user_metadata?: object }): Promise<{ error: AuthAdminError | null }>;
      listUsers(params: { page: number; perPage: number }): Promise<{ data: { users: AuthAdminUser[] }; error: AuthAdminError | null }>;
    };
  };
}

export interface AuthAdminError {
  message: string;
  status?: number;
  code?: string;
}
export interface AuthAdminUser {
  id: string;
  email?: string | undefined;
  user_metadata?: Record<string, unknown> | undefined;
  app_metadata?: Record<string, unknown> | undefined;
}
export type AuthAdminAnswer = { data: { user: AuthAdminUser | null }; error: AuthAdminError | null };

export interface FirstLoginInput {
  email: string;
  /** The Users row the login is made for: it is the tag on the login. */
  userId: string;
  /** Where the invitation's link lands, or undefined for the project's Site URL. */
  redirectTo?: string;
  /** Set for a confirmed login with a password; undefined sends the invitation. */
  password?: string;
}

export type FirstLoginResult =
  /** The invitation went out, to a login this call made. */
  | { how: 'INVITED'; authId: string }
  /** A confirmed login with the password was made. */
  | { how: 'CREATED'; authId: string }
  /** The address already had a login (made by hand in the dashboard, as §7 used to say): it is adopted and no mail went out. */
  | { how: 'EXISTED'; authId: string };

/** A refusal the operator can act on, with the sentence to say. */
export class FirstLoginError extends Error {
  constructor(
    message: string,
    readonly kind: 'RATE_LIMITED' | 'SENDER' | 'OTHER',
  ) {
    super(message);
    this.name = 'FirstLoginError';
  }
}

const INVITATION_NONCE = 'schemaproInvitation';

/** GoTrue answers 429 over_email_send_rate_limit when the project's mail limit is spent. */
export function isRateLimited(error: AuthAdminError): boolean {
  return error.status === 429 || error.code === 'over_email_send_rate_limit';
}

/** What Supabase said, or its code when its message is empty (a failure inside GoTrue can answer with none). */
function saidBy(error: AuthAdminError): string {
  const message = error.message?.trim();
  return message && message !== '{}' ? message : (error.code ?? 'no message');
}

function refusal(action: string, error: AuthAdminError): FirstLoginError {
  if (isRateLimited(error)) {
    return new FirstLoginError(
      `Supabase refused to send: the project's mail limit is spent (HTTP 429, ${error.code ?? 'rate limit'}). With Supabase's own sender that is 2 mails an hour; with the project's own SMTP it is the limit under Authentication → Rate Limits. Wait, raise the limit or set SMTP (Authentication → SMTP), and run the same command again, or use --password-env to make the login without mail.`,
      'RATE_LIMITED',
    );
  }
  if (error.status !== undefined && error.status >= 500) {
    return new FirstLoginError(
      `Supabase could not ${action}: ${saidBy(error)} (HTTP ${error.status}). For an invitation that is most often the SMTP server refusing the mail: check the host, port, user and password under Authentication → SMTP, and that the sender address is one the server lets this user send as. Then run the same command again.`,
      'SENDER',
    );
  }
  return new FirstLoginError(`Supabase could not ${action}: ${saidBy(error)}${error.status ? ` (HTTP ${error.status})` : ''}.`, 'OTHER');
}

async function findByEmail(client: AuthAdminClient, email: string): Promise<string | null> {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 200 });
    if (error) return null;
    const users = data.users;
    const match = users.find((candidate) => candidate.email?.toLowerCase() === email.toLowerCase());
    if (match) return match.id;
    if (users.length < 200) break;
  }
  return null;
}

export async function makeFirstLogin(client: AuthAdminClient, input: FirstLoginInput): Promise<FirstLoginResult> {
  const tag = { app_metadata: { [CREATED_FOR_ROW]: input.userId } };

  if (input.password !== undefined) {
    const { data, error } = await client.auth.admin.createUser({ email: input.email, password: input.password, email_confirm: true, ...tag });
    if (!error && data.user) return { how: 'CREATED', authId: data.user.id };
    if (error && (error.code === 'email_exists' || error.status === 422)) {
      const existing = await findByEmail(client, input.email);
      if (existing) return { how: 'EXISTED', authId: existing };
    }
    throw refusal('make the login', error ?? { message: 'no user was returned' });
  }

  const nonce = randomUUID();
  const { data, error } = await client.auth.admin.inviteUserByEmail(input.email, {
    ...(input.redirectTo ? { redirectTo: input.redirectTo } : {}),
    data: { [INVITATION_NONCE]: nonce },
  });
  if (error || !data.user) {
    // An address Supabase knows is answered with 422 and no mail; that login is the person's, and it is adopted as it is.
    if (error && !isRateLimited(error) && (error.code === 'email_exists' || error.status === 422)) {
      const existing = await findByEmail(client, input.email);
      if (existing) return { how: 'EXISTED', authId: existing };
    }
    throw refusal('send the invitation', error ?? { message: 'no user was returned' });
  }
  // Only a login this call made carries its one-off value, and only such a login is tagged: GoTrue also answers an address whose
  // user never confirmed it by sending that user the invitation again and returning it.
  if (data.user.user_metadata?.[INVITATION_NONCE] === nonce) {
    await client.auth.admin.updateUserById(data.user.id, { ...tag, user_metadata: { [INVITATION_NONCE]: null } });
  }
  return { how: 'INVITED', authId: data.user.id };
}
