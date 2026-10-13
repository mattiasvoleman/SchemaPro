import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Area } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { TeachingBlocksService } from './teaching-blocks.service';
import { CreateTeachingBlockDto, UpdateTeachingBlockDto } from './dto/teaching-block.dto';

/**
 * Parallella block. Written here and read through PostgREST, as the
 * timplansposter it groups are: the web lists a year's blocks with the rows.
 */
@Controller('api/v1/teaching-blocks')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
// Roller i skolan: a block and its requirements are the timplan's, planering's.
@Area('PLANERING')
export class TeachingBlocksController {
  constructor(private readonly blocks: TeachingBlocksService) {}

  @Post()
  create(@Body() dto: CreateTeachingBlockDto, @CurrentUser() user: AuthenticatedUser) {
    return this.blocks.create(dto, user);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateTeachingBlockDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.blocks.update(id, dto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.blocks.remove(id, user);
  }
}
