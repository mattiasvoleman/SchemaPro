import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthMailConfig } from '../config/configuration';
import { SupabaseAdminService } from './supabase-admin.service';

/** What the administrator's start page says of how an invitation reaches the person: GET /api/v1/users/invitation-channel. */
export interface InvitationChannelView {
  /** False where the API has no way to make a login (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not set): no invitation can go. */
  configured: boolean;
  /**
   * What the operator has said of the project's sender (AUTH_SMTP): its own SMTP, or nothing. Supabase's own sender lets two an hour
   * through, so "nothing said" is the one the page warns about. The API cannot read the project's setting (the token that does is the
   * operator's, docs/DEPLOYMENT.md §7.1), and does not pretend to.
   */
  smtp: 'CUSTOM' | 'NOT_STATED';
  /** The project's mail limit an hour, as the operator said it (AUTH_EMAIL_LIMIT_PER_HOUR), or null. */
  perHour: number | null;
}

@Injectable()
export class InvitationChannelService {
  constructor(
    private readonly config: ConfigService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  read(): InvitationChannelView {
    const mail = this.config.get<AuthMailConfig>('authMail');
    return {
      configured: this.supabaseAdmin.isConfigured,
      smtp: mail?.smtp === 'custom' ? 'CUSTOM' : 'NOT_STATED',
      perHour: mail?.perHour ?? null,
    };
  }
}
