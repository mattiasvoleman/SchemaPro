import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { Area } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CreateSiteDto, PutSiteTravelTimesDto, UpdateSiteDto } from './dto/site.dto';
import { SitesService } from './sites.service';

/** The school's skolområden and the restid between them: read by its administrators, written by planering. */
@Controller('api/v1/sites')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
// Roller i skolan: sites are grunddata beside the rooms, planering's.
@Area('PLANERING')
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.sites.list(user);
  }

  @Post()
  create(@Body() dto: CreateSiteDto, @CurrentUser() user: AuthenticatedUser) {
    return this.sites.create(dto, user);
  }

  /** Declared before ':id' so the literal path is never read as an id. */
  @Put('travel-times')
  putTravelTimes(@Body() dto: PutSiteTravelTimesDto, @CurrentUser() user: AuthenticatedUser) {
    return this.sites.putTravelTimes(dto, user);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateSiteDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.sites.update(id, dto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.sites.remove(id, user);
  }
}
