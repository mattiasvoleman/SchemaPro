import { Controller, Delete, Get, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Area, Decides } from '../auth/decorators/area.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PersonProtectionsService, type PersonProtectionView, type ProtectionRow } from './person-protections';

/**
 * Skyddad identitet (20270107090000): the school's marks. Every
 * administrator reads them (they write the files the marks keep people out
 * of); those who write Personal set one by hand; those who decide remove
 * one, since lifting a protection is a decision.
 */
@Controller('api/v1/person-protections')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Area('PERSONAL')
export class PersonProtectionsController {
  constructor(private readonly protections: PersonProtectionsService) {}

  /** The school's marks, a row per source, for the exports; recorded in the läslogg. */
  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<ProtectionRow[]> {
    return this.protections.list(user);
  }

  /** One person's marks and who set or removed them; recorded in the läslogg. */
  @Get(':userId')
  one(
    @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PersonProtectionView> {
    return this.protections.one(userId, user);
  }

  /** Marks the person by hand; the mark stands until an administrator removes it. */
  @Put(':userId')
  set(
    @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PersonProtectionView> {
    return this.protections.set(userId, user);
  }

  /** Removes the person's marks, the sync's and an administrator's: rektor or a full administrator. */
  @Delete(':userId')
  @Decides()
  remove(
    @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PersonProtectionView> {
    return this.protections.remove(userId, user);
  }
}
