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
import { RoomPreferencesService } from './room-preferences.service';
import {
  CreateRoomPreferenceDto,
  UpdateRoomPreferenceDto,
} from './dto/room-preference.dto';

/** Soft room wishes, managed alongside the school's other scheduling rules. */
@Controller('api/v1/room-preferences')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class RoomPreferencesController {
  constructor(private readonly preferences: RoomPreferencesService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.preferences.list(user);
  }

  @Post()
  create(
    @Body() dto: CreateRoomPreferenceDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.preferences.create(dto, user);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateRoomPreferenceDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.preferences.update(id, dto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.preferences.remove(id, user);
  }
}
