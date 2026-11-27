import type { ConfigService } from '@nestjs/config';
import type { AuthMailConfig } from '../config/configuration';
import { InvitationChannelService } from './invitation-channel';
import type { SupabaseAdminService } from './supabase-admin.service';

describe('InvitationChannelService', () => {
  const channel = (mail: AuthMailConfig | undefined, configured = true) =>
    new InvitationChannelService(
      { get: (key: string) => (key === 'authMail' ? mail : undefined) } as unknown as ConfigService,
      { isConfigured: configured } as unknown as SupabaseAdminService,
    ).read();

  it('says what the operator said: its own SMTP, and the limit', () => {
    expect(channel({ smtp: 'custom', perHour: 30 })).toEqual({ configured: true, smtp: 'CUSTOM', perHour: 30 });
    expect(channel({ smtp: 'custom', perHour: null })).toEqual({ configured: true, smtp: 'CUSTOM', perHour: null });
  });

  it('says that nobody has said, which is what an unset variable is, and does not guess that Supabase\'s own sender is not in use', () => {
    expect(channel({ smtp: 'not-stated', perHour: null })).toEqual({ configured: true, smtp: 'NOT_STATED', perHour: null });
    expect(channel(undefined)).toEqual({ configured: true, smtp: 'NOT_STATED', perHour: null });
  });

  it('says that no invitation can go where the API has no way to make a login', () => {
    expect(channel({ smtp: 'custom', perHour: 30 }, false).configured).toBe(false);
  });
});
