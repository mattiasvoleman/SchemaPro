import { Body, Controller, Delete, Get, Header, Param, Put, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Public } from '../auth/decorators/public.decorator';
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

/** Per caller address: a person retyping their address, not a list being walked. */
export const LOOKUPS_PER_MINUTE = 30;

/**
 * /login's lookup, before anyone has signed in: which school-account
 * provider an e-mail domain signs in with. The web and the app send the
 * domain, never the address.
 *
 * It answers 200 with { provider } either way, null when no school names the
 * domain or the schools naming it disagree, so a domain that is no customer
 * looks like any other answer in a log and a browser console. It names no
 * school, tenant or setting. Never cached: an admin's change applies to the
 * next click.
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
