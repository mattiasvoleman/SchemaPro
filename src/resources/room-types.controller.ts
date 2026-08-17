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
import { RoomTypesService } from './room-types.service';
import { CreateRoomTypeDto, UpdateRoomTypeDto } from './dto/room-type.dto';

@Controller('api/v1/room-types')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class RoomTypesController {
  constructor(private readonly roomTypes: RoomTypesService) {}

  /** Listing includes usage counts, which the delete guard depends on. */
  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.roomTypes.list(user);
  }

  @Post()
  create(@Body() dto: CreateRoomTypeDto, @CurrentUser() user: AuthenticatedUser) {
    return this.roomTypes.create(dto, user);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateRoomTypeDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.roomTypes.update(id, dto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.roomTypes.remove(id, user);
  }
}
