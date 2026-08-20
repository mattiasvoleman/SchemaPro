import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AppConfig, SupabaseAdminConfig } from '../config/configuration';

/**
 * Thin wrapper around the Supabase Admin (GoTrue) API.
 *
 * Uses the service-role key, which bypasses RLS — therefore this service is
 * ONLY used for identity lifecycle (invite / delete auth users) and never for
 * reading or writing tenant data. All tenant data access goes through
 * `PrismaService.withRls`.
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
   */
  async inviteUser(email: string): Promise<{ authId: string; emailSent: boolean }> {
    if (!this.client) {
      throw new Error('Supabase admin client is not configured.');
    }
    const { data, error } = await this.client.auth.admin.inviteUserByEmail(
      email,
      this.inviteRedirectUrl ? { redirectTo: this.inviteRedirectUrl } : {},
    );
    if (error || !data.user) {
      // 422 "already registered" → look the auth user up instead of failing.
      const existing = await this.findUserIdByEmail(email);
      if (existing) return { authId: existing, emailSent: false };
      throw new Error(`Supabase invite failed: ${error?.message ?? 'unknown error'}`);
    }
    return { authId: data.user.id, emailSent: true };
  }

  /** Deletes a Supabase Auth user. Missing users are treated as success. */
  async deleteUser(authId: string): Promise<void> {
    if (!this.client) return;
    const { error } = await this.client.auth.admin.deleteUser(authId);
    if (error && error.status !== 404) {
      throw new Error(`Supabase delete failed: ${error.message}`);
    }
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
