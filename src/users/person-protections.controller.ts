import { Controller, Delete, Get, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Area } from '../auth/decorators/area.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PersonProtectionsService, type ProtectionView } from './person-protections';

/**
 * Skyddad identitet (20270107090000): the school's marks. Every
 * administrator reads them (they write the files the marks keep people out
 * of); those who write Personal set and remove them.
 */
@Controller('api/v1/person-protections')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Area('PERSONAL')
export class PersonProtectionsController {
  constructor(private readonly protections: PersonProtectionsService) {}

  /** The school's marked persons and where each mark comes from; recorded in the läslogg. */
  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<ProtectionView[]> {
    return this.protections.list(user);
  }

  /** Marks the person by hand; a person already marked keeps their mark. */
  @Put(':userId')
  set(
    @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ProtectionView> {
    return this.protections.set(userId, user);
  }

  /** Removes the person's mark, whichever wrote it. */
  @Delete(':userId')
  remove(
    @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ProtectionView> {
    return this.protections.remove(userId, user);
  }
}
