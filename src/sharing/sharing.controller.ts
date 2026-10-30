import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import { Area } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CreateRoomLoanDto, PutSchoolTravelDto } from './dto/sharing.dto';
import { RoomLoansService } from './room-loans.service';
import { SharingService } from './sharing.service';

/**
 * What a school shares with the other schools of its huvudman (Delade
 * lokaler och lärare): the minutes between them and the teachers they
 * share. Read by the school's administrators, written by planering.
 */
@Controller('api/v1/sharing')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
// Roller i skolan: the travel between schools is grunddata beside the sites.
@Area('PLANERING')
export class SharingController {
  constructor(private readonly sharing: SharingService) {}

  @Get()
  view(@CurrentUser() user: AuthenticatedUser) {
    return this.sharing.view(user);
  }

  @Put('travel/:schoolId')
  putTravel(
    @Param('schoolId', new ParseUUIDPipe()) schoolId: string,
    @Body() dto: PutSchoolTravelDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.sharing.putTravel(schoolId, dto.minutes, user);
  }
}

/**
 * Salslån: a room of another school of the huvudman for weekly windows. The
 * borrower's planner asks and withdraws, the owner's planner approves,
 * declines and ends; the database's functions hold each to its own side.
 */
@Controller('api/v1/room-loans')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
// Roller i skolan: a loan binds the rooms of the grundschema, planering's.
@Area('PLANERING')
export class RoomLoansController {
  constructor(private readonly loans: RoomLoansService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.loans.list(user);
  }

  /** Declared before ':id' so the literal path is never read as an id. */
  @Get('rooms')
  rooms(@CurrentUser() user: AuthenticatedUser) {
    return this.loans.rooms(user);
  }

  @Post()
  request(@Body() dto: CreateRoomLoanDto, @CurrentUser() user: AuthenticatedUser) {
    return this.loans.request(dto, user);
  }

  @Post(':id/approve')
  approve(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.loans.decide(id, true, user);
  }

  @Post(':id/decline')
  decline(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.loans.decide(id, false, user);
  }

  @Post(':id/withdraw')
  withdraw(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.loans.withdraw(id, user);
  }

  @Post(':id/revoke')
  revoke(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.loans.revoke(id, user);
  }
}
