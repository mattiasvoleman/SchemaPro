import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { AnyAdministrator, Decides } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { HuvudmanRoute } from '../auth/huvudman-reader';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CreateHuvudmanKeyDto, InviteMemberDto, RequestSchoolDto, UpdateMemberDto } from './huvudman.dto';
import { HuvudmanOwnershipService } from './huvudman-ownership.service';
import { HuvudmanService } from './huvudman.service';

const uuid = new ParseUUIDPipe({ version: '4' });

/**
 * The huvudman's own pages (Huvudman, 20261212090000). Any signed-in login
 * may ask, whatever its role at whichever school the request names: the
 * database holds every read and write to the login's membership of the
 * huvudman, and a kommunadministratör's acts to that role. The huvudman's
 * reader and a member at no school may write here (@HuvudmanRoute), and
 * nowhere else.
 */
@Controller('api/v1/huvudman')
@Roles(Role.HUVUDMAN, Role.SCHOOL_ADMIN, Role.TEACHER, Role.STUDENT, Role.GUARDIAN)
@HuvudmanRoute()
@AnyAdministrator("the huvudman's own tables, held to the membership in the database and no school's area")
export class HuvudmanController {
  constructor(private readonly huvudman: HuvudmanService) {}

  @Get()
  mine(@CurrentUser() user: AuthenticatedUser) {
    return this.huvudman.mine(user);
  }

  @Get(':id')
  view(@Param('id', uuid) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.huvudman.view(user, id);
  }

  @Post(':id/requests')
  requestSchool(@Param('id', uuid) id: string, @Body() dto: RequestSchoolDto, @CurrentUser() user: AuthenticatedUser) {
    return this.huvudman.requestSchool(user, id, dto.slug);
  }

  @Delete(':id/requests/:schoolId')
  @HttpCode(HttpStatus.NO_CONTENT)
  withdrawRequest(@Param('id', uuid) id: string, @Param('schoolId', uuid) schoolId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.huvudman.withdrawRequest(user, id, schoolId);
  }

  @Delete(':id/schools/:schoolId')
  @HttpCode(HttpStatus.NO_CONTENT)
  releaseSchool(@Param('id', uuid) id: string, @Param('schoolId', uuid) schoolId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.huvudman.releaseSchool(user, id, schoolId);
  }

  @Post(':id/members')
  invite(@Param('id', uuid) id: string, @Body() dto: InviteMemberDto, @CurrentUser() user: AuthenticatedUser) {
    return this.huvudman.invite(user, id, dto);
  }

  @Patch(':id/members/:memberId')
  @HttpCode(HttpStatus.NO_CONTENT)
  updateMember(
    @Param('id', uuid) id: string,
    @Param('memberId', uuid) memberId: string,
    @Body() dto: UpdateMemberDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.huvudman.updateMember(user, id, memberId, dto);
  }

  @Post(':id/keys')
  createKey(@Param('id', uuid) id: string, @Body() dto: CreateHuvudmanKeyDto, @CurrentUser() user: AuthenticatedUser) {
    return this.huvudman.createKey(user, id, dto);
  }

  @Delete(':id/keys/:keyId')
  @HttpCode(HttpStatus.NO_CONTENT)
  revokeKey(@Param('id', uuid) id: string, @Param('keyId', uuid) keyId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.huvudman.revokeKey(user, id, keyId);
  }
}

/**
 * The school's side (Huvudman, 20261212090000): every administrator reads
 * who owns the school and who reads it; rektor or a full administrator
 * answers a huvudman's question, and ends the ownership.
 */
@Controller('api/v1/huvudman-ownership')
@Roles(Role.SCHOOL_ADMIN)
@Decides()
export class HuvudmanOwnershipController {
  constructor(private readonly ownership: HuvudmanOwnershipService) {}

  @Get()
  view(@CurrentUser() user: AuthenticatedUser) {
    return this.ownership.view(user);
  }

  @Post('requests/:huvudmanId/accept')
  @HttpCode(HttpStatus.NO_CONTENT)
  accept(@Param('huvudmanId', uuid) huvudmanId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.ownership.accept(user, huvudmanId);
  }

  @Post('requests/:huvudmanId/decline')
  @HttpCode(HttpStatus.NO_CONTENT)
  decline(@Param('huvudmanId', uuid) huvudmanId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.ownership.decline(user, huvudmanId);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  leave(@CurrentUser() user: AuthenticatedUser) {
    return this.ownership.leave(user);
  }
}
