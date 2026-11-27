import { Injectable } from '@nestjs/common';
import { PerLoginThrottlerGuard } from './per-login-throttler.guard';

/**
 * Per login, a part of the mass invitation a minute (POST /api/v1/users/invitations): the web sends a hundred people in parts of
 * twenty, one part at a time, and a part is a few seconds of Supabase calls, so a run is a part every five seconds or so. Thirty a
 * minute is six times that, and a second tab or a second administrator is still far under it.
 *
 * It was five a minute PER ADDRESS (@Throttle on the route), and a school is one address: the web calls the API from every person's
 * browser, and a whole school's staff sit behind one NAT. A run of fifteen parts was refused at the sixth, and the block of a minute
 * was every other administrator's of the school too (memory throttle-per-login-not-per-address). The controller gives the global guard
 * a ceiling of its own for the route (PER_ADDRESS_INVITATIONS), and this keys on the verified login.
 */
export const PER_LOGIN_INVITATIONS = { limit: 30, ttl: 60_000 };
/** Per address, the global ThrottlerGuard's bucket for this route alone: high, because it is the school's address and not a person. */
export const PER_ADDRESS_INVITATIONS = { limit: 1200, ttl: 60_000 };

@Injectable()
export class InvitationThrottlerGuard extends PerLoginThrottlerGuard {
  protected override readonly limits = PER_LOGIN_INVITATIONS;
  protected override readonly route = 'users/invitations';
}
