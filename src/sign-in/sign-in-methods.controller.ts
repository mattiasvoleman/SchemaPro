import { Body, Controller, Delete, Get, Header, Param, Put, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { Area } from '../auth/decorators/area.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { SignInMethodDto } from './dto';
import { SignInMethodsService } from './sign-in-methods.service';

/**
 * The school's "Logga in med skolkonto" (/admin/integrations, Inloggning).
 * SCHOOL_ADMIN only; any other role gets 403.
 */
@Controller('api/v1/sign-in-method')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Area('INTEGRATIONER')
export class SignInMethodController {
  constructor(private readonly methods: SignInMethodsService) {}

  @Get()
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.methods.get(user);
  }

  @Put()
  put(@Body() body: SignInMethodDto, @CurrentUser() user: AuthenticatedUser) {
    return this.methods.put(user, body);
  }

  @Delete()
  remove(@CurrentUser() user: AuthenticatedUser) {
    return this.methods.remove(user);
  }
}

/**
 * Per caller address. A whole school, or every school of a kommun, often
 * reaches the API from one public address, and the morning a school starts
 * requiring the school account its staff all take this route within the
 * hour. The answer is one read of a small table, so the limit is set for
 * that crowd rather than for one person retyping: 600 a minute, ten a
 * second. The web and the app say a 429 as "wait a minute", not as a
 * failure, and remember a domain's answer for the page or the app's life.
 */
export const LOOKUPS_PER_MINUTE = 600;

/**
 * /login's lookup, before anyone has signed in: which school-account
 * provider an e-mail domain signs in with. The web and the app send the
 * domain, never the address.
 *
 * It answers 200 with { provider } either way, null when no school names the
 * domain or when the schools naming it disagree (which the domain trigger
 * keeps from happening). The status is the same for every domain, the body
 * is not: anyone can learn from it which e-mail domains sign in with a
 * school account, and with which provider, as with any home-realm
 * discovery. That is accepted. It names no school, tenant or setting, and
 * the alternative, a button per provider and no lookup, would put a Google
 * and a Microsoft button in front of every guardian who signs in with a
 * password. Never cached: an admin's change applies to the next click.
 */
@Controller('public/v1/sign-in-methods')
@Public()
export class PublicSignInMethodController {
  constructor(private readonly methods: SignInMethodsService) {}

  @Get(':domain')
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: LOOKUPS_PER_MINUTE, ttl: 60_000 } })
  async lookup(@Param('domain') domain: string) {
    return { provider: await this.methods.providerFor(domain) };
  }
}
