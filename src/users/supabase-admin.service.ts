import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient, type User as AuthUser } from '@supabase/supabase-js';
import type { AppConfig, SupabaseAdminConfig } from '../config/configuration';

/**
 * The app_metadata key naming the Users row an auth user was created for
 * (see inviteUser). app_metadata is the service role's to write: a signed-in
 * person can rewrite their own user_metadata, but not this.
 */
export const CREATED_FOR_ROW = 'schemaproUserId';

/**
 * The app_metadata key marking a login that rows at more than one school
 * hold (Flera skolor per inloggning; see markSeveralSchools). The web asks
 * the gateway for a login's schools only when it is set (web/lib/auth.ts,
 * web/lib/school-choice.ts names it too).
 */
export const SEVERAL_SCHOOLS = 'rastraSeveralSchools';

/** The user_metadata key carrying inviteUser()'s one-off value. */
const INVITATION_NONCE = 'schemaproInvitation';

/**
 * The Users row a login must belong to before it is moved or deleted for
 * that row (see belongsTo).
 */
export interface LoginOwner {
  userId: string;
  /**
   * When the row was last invited: its `invitedAt` before this invitation.
   * Every invitation restamps it, also one that leaves the row on the login
   * it had, so the row has held its login since then.
   */
  since: Date;
}

/** What SupabaseAdminService.changeUserEmail did with a login. */
export type EmailChange =
  | { outcome: 'unchanged' | 'changed'; confirmed: boolean }
  | { outcome: 'taken' | 'missing' | 'foreign' };

/** What SupabaseAdminService.deleteOwnedUser did with a login. */
export type OwnedUserDeletion = 'deleted' | 'missing' | 'foreign';

/** A login could not be read, so whose it is was not decided. */
export class UserLookupError extends Error {}

/**
 * Thin wrapper around the Supabase Admin (GoTrue) API.
 *
 * Uses the service-role key, which bypasses RLS — therefore this service is
 * ONLY used for identity lifecycle (invite, re-address and delete auth
 * users) and never for reading or writing tenant data. All tenant data access
 * goes through `PrismaService.withRls`.
 *
 * When `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are not configured
 * (e.g. local development against plain PostgreSQL), the service degrades
 * gracefully: `isConfigured` is false and callers fall back to creating
 * catalog-only users that cannot sign in until linked to an identity.
 */
@Injectable()
export class SupabaseAdminService {
  private readonly logger = new Logger(SupabaseAdminService.name);
  private readonly client: SupabaseClient | null = null;
  private readonly inviteRedirectUrl: string | undefined;

  constructor(configService: ConfigService) {
    const supabase = configService.getOrThrow<SupabaseAdminConfig>('supabase');
    const app = configService.getOrThrow<AppConfig>('app');

    if (supabase.url && supabase.serviceRoleKey) {
      this.client = createClient(supabase.url, supabase.serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });
    } else {
      this.logger.warn(
        'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — user invitations are disabled.',
      );
    }

    // Send invited users to the web app's set-password page.
    const webOrigin = app.corsOrigins[0];
    this.inviteRedirectUrl = webOrigin
      ? `${webOrigin.replace(/\/$/, '')}/update-password`
      : undefined;
  }

  get isConfigured(): boolean {
    return this.client !== null;
  }

  /**
   * Invites a user by email and returns the Supabase Auth user id
   * (`auth.users.id`), which becomes `Users.authId`.
   *
   * `emailSent` is false when the address already had an identity: GoTrue
   * answers 422 for those and sends nothing, so we look the id up instead of
   * failing. Reporting that honestly matters — an admin pressing "send
   * invitation" on someone who already has an account must not be told an
   * email went out when none did.
   *
   * A user the invitation creates is tagged with `userId`, the row it was
   * created for (app_metadata, CREATED_FOR_ROW). A login this call resolves
   * by address is somebody's already and is left as it is: only the row a
   * login was made for may later move or delete it (changeUserEmail,
   * deleteOwnedUser). A 200 does not say which happened, because GoTrue
   * answers an address whose user has not confirmed it by sending that user
   * the invitation again and returning it. The invitation's `data` reaches
   * user_metadata only when GoTrue creates the user, so a one-off value sent
   * with it and found on the user that comes back is what says this call
   * made it.
   */
  async inviteUser(
    email: string,
    userId: string,
  ): Promise<{ authId: string; emailSent: boolean }> {
    if (!this.client) {
      throw new Error('Supabase admin client is not configured.');
    }
    const nonce = randomUUID();
    const { data, error } = await this.client.auth.admin.inviteUserByEmail(email, {
      ...(this.inviteRedirectUrl ? { redirectTo: this.inviteRedirectUrl } : {}),
      data: { [INVITATION_NONCE]: nonce },
    });
    if (error || !data.user) {
      // 422 "already registered" → look the auth user up instead of failing.
      const existing = await this.findUserIdByEmail(email);
      if (existing) return { authId: existing, emailSent: false };
      throw new Error(`Supabase invite failed: ${error?.message ?? 'unknown error'}`);
    }
    if (data.user.user_metadata?.[INVITATION_NONCE] === nonce) {
      await this.tagCreatedUser(data.user.id, userId);
    }
    return { authId: data.user.id, emailSent: true };
  }

  /**
   * Sends the invitation again to a user who has not accepted it.
   *
   * Unlike inviteUser() this resolves nothing: the caller already knows the
   * user the address belongs to, so any refusal is a failure to send. GoTrue
   * sends an unconfirmed user the invitation again, and a 429 (the project's
   * e-mail limit) or a mail server error rolls the send back. inviteUser()
   * would read either as "already registered" and find the same user.
   */
  async resendInvitation(email: string): Promise<void> {
    if (!this.client) {
      throw new Error('Supabase admin client is not configured.');
    }
    const { error } = await this.client.auth.admin.inviteUserByEmail(
      email,
      this.inviteRedirectUrl ? { redirectTo: this.inviteRedirectUrl } : {},
    );
    if (error) {
      throw new Error(`Supabase invite failed: ${error.message}`);
    }
  }

  /**
   * Gives an existing auth user another address, keeping its password and
   * the identities linked to it. The admin API applies the change directly:
   * no confirmation mail goes to either address, and a confirmed address
   * stays confirmed.
   *
   * - `unchanged`: the user already has the address (in any case), so
   *   nothing is written;
   * - `changed`: the user now has the address;
   * - `taken`: another auth user holds the address, and GoTrue refuses
   *   (email_exists);
   * - `missing`: there is no such user (404);
   * - `foreign`: the user is not `owner`'s own (see belongsTo), so nothing
   *   is written. A login resolved by address can be anybody's, and the
   *   row's address is whatever its school, or the school's SS12000 source,
   *   says it is.
   *
   * For the first two, `confirmed` says whether the user has confirmed an
   * address (accepted an invitation, or signed in with a linked school
   * account): GoTrue sends such a user no invitation. Anything else throws.
   *
   * A login from before the tag that belongs to `owner` is tagged with it
   * here, in the same write as the address, or alone when the address is
   * already right, so that the next invitation, which restamps the row's
   * `invitedAt`, need not find a sign-in again. That tag alone is best effort.
   */
  async changeUserEmail(authId: string, email: string, owner: LoginOwner): Promise<EmailChange> {
    if (!this.client) {
      throw new Error('Supabase admin client is not configured.');
    }
    const found = await this.client.auth.admin.getUserById(authId);
    if (found.error) {
      if (found.error.status === 404) return { outcome: 'missing' };
      throw new UserLookupError(`Supabase user lookup failed: ${found.error.message}`);
    }
    const login = found.data.user;
    const confirmed = Boolean(login.email_confirmed_at);
    const own = belongsTo(login, owner);
    const tag =
      own && login.app_metadata?.[CREATED_FOR_ROW] !== owner.userId
        ? { app_metadata: { [CREATED_FOR_ROW]: owner.userId } }
        : null;

    if (login.email?.toLowerCase() === email.toLowerCase()) {
      if (tag) await this.tagLogin(authId, owner.userId, tag);
      return { outcome: 'unchanged', confirmed };
    }
    if (!own) return { outcome: 'foreign' };

    const { error } = await this.client.auth.admin.updateUserById(authId, { email, ...tag });
    if (!error) return { outcome: 'changed', confirmed };
    if (error.code === 'email_exists') return { outcome: 'taken' };
    if (error.status === 404) return { outcome: 'missing' };
    throw new Error(`Supabase e-mail change failed: ${error.message}`);
  }

  /**
   * Marks a login that a row at another school took too (SEVERAL_SCHOOLS),
   * so that the web renders the school switcher for it and asks the gateway
   * for no other login's schools. Best effort, after the row took the login:
   * unmarked, the person keeps seeing the school their login came from,
   * without a switcher, until an invitation marks it; the failure is logged
   * with the login. A mark left on a login one school holds again costs the
   * web that question and nothing else.
   */
  async markSeveralSchools(authId: string): Promise<void> {
    if (!this.client) return;
    try {
      const { error } = await this.client.auth.admin.updateUserById(authId, {
        app_metadata: { [SEVERAL_SCHOOLS]: true },
      });
      if (!error) return;
    } catch {
      // Not marked all the same; the rows and the login are right without it.
    }
    this.logger.warn(`A login held at several schools was not marked [authId=${authId}]`);
  }

  /** Deletes a Supabase Auth user. Missing users are treated as success. */
  async deleteUser(authId: string): Promise<void> {
    if (!this.client) return;
    const { error } = await this.client.auth.admin.deleteUser(authId);
    if (error && error.status !== 404) {
      throw new Error(`Supabase delete failed: ${error.message}`);
    }
  }

  /**
   * Deletes an auth user only if it is `owner`'s own (see belongsTo), read
   * again just before: `foreign` leaves it as it is, `missing` had nothing
   * to delete. A read that fails throws UserLookupError, and nothing was
   * deleted; anything else throws.
   */
  async deleteOwnedUser(authId: string, owner: LoginOwner): Promise<OwnedUserDeletion> {
    if (!this.client) {
      throw new Error('Supabase admin client is not configured.');
    }
    const found = await this.client.auth.admin.getUserById(authId);
    if (found.error) {
      if (found.error.status === 404) return 'missing';
      throw new UserLookupError(`Supabase user lookup failed: ${found.error.message}`);
    }
    if (!belongsTo(found.data.user, owner)) return 'foreign';
    await this.deleteUser(authId);
    return 'deleted';
  }

  /**
   * Tags a user this service's invitation just created with its row, and
   * takes the one-off value off it again.
   *
   * Best effort: the invitation has gone out, and the login works without
   * the tag. Untagged, it counts as the row's only once somebody signs in
   * with it (belongsTo), and until then a new address for the row gets a
   * login of its own. The failure is logged with the row and the login.
   */
  private async tagCreatedUser(authId: string, userId: string): Promise<void> {
    await this.tagLogin(authId, userId, {
      app_metadata: { [CREATED_FOR_ROW]: userId },
      user_metadata: { [INVITATION_NONCE]: null },
    });
  }

  private async tagLogin(
    authId: string,
    userId: string,
    attributes: { app_metadata: object; user_metadata?: object },
  ): Promise<void> {
    try {
      const { error } = await this.client!.auth.admin.updateUserById(authId, attributes);
      if (!error) return;
    } catch {
      // Not tagged all the same, and the login works without it.
    }
    this.logger.warn(`A login was not tagged with its row [user=${userId}] [authId=${authId}]`);
  }

  private async findUserIdByEmail(email: string): Promise<string | null> {
    if (!this.client) return null;
    // GoTrue has no direct lookup-by-email admin endpoint in supabase-js;
    // page through users (fine at school scale) to find a match.
    for (let page = 1; page <= 20; page++) {
      const { data, error } = await this.client.auth.admin.listUsers({
        page,
        perPage: 200,
      });
      if (error) return null;
      const match = data.users.find(
        (candidate) => candidate.email?.toLowerCase() === email.toLowerCase(),
      );
      if (match) return match.id;
      if (data.users.length < 200) break;
    }
    return null;
  }
}

/**
 * Whether a login is `owner`'s own to move or delete: inviteUser() created
 * it for that row and tagged it so. A tag naming another row means the login
 * was made for that one.
 *
 * A login created before the tag existed carries none. It counts as the
 * row's once somebody has signed in with it since the row was last invited
 * (`owner.since`): the row has held it since then, so that sign-in was a
 * sign-in as the row's person, and the login is in use as the row's. One the
 * row was given by address and nobody has used since is not the row's. The
 * price is the person's own login when they last signed in before an
 * invitation sent again: that restamped `invitedAt` and recorded nothing,
 * so until they sign in again it is not the row's either, and a new address
 * gets a login of its own.
 */
function belongsTo(login: AuthUser, owner: LoginOwner): boolean {
  const tag: unknown = login.app_metadata?.[CREATED_FOR_ROW];
  if (tag !== undefined && tag !== null) return tag === owner.userId;
  return login.last_sign_in_at ? new Date(login.last_sign_in_at) > owner.since : false;
}
