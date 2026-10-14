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
  UseGuards,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CreateSchoolUnitDto, UpdateSchoolUnitDto } from './dto/school-unit.dto';
import { SchoolUnitsService } from './school-units.service';

/** The school's skolenheter: read and written by its administrator only. */
@Controller('api/v1/school-units')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class SchoolUnitsController {
  constructor(private readonly units: SchoolUnitsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.units.list(user);
  }

  @Post()
  create(@Body() dto: CreateSchoolUnitDto, @CurrentUser() user: AuthenticatedUser) {
    return this.units.create(dto, user);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateSchoolUnitDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.units.update(id, dto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.units.remove(id, user);
  }
}
