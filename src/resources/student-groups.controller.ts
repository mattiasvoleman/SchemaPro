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
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { StudentGroupsService } from './student-groups.service';
import {
  CreateStudentGroupDto,
  SetGroupMembersDto,
  UpdateStudentGroupDto,
} from './dto/student-group.dto';

@Controller('api/v1/student-groups')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class StudentGroupsController {
  constructor(private readonly studentGroups: StudentGroupsService) {}

  @Post()
  create(@Body() dto: CreateStudentGroupDto, @CurrentUser() user: AuthenticatedUser) {
    return this.studentGroups.create(dto, user);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateStudentGroupDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.studentGroups.update(id, dto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    await this.studentGroups.remove(id, user);
  }

  @Get(':id/members')
  listMembers(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.studentGroups.listMembers(id, user);
  }

  @Put(':id/members')
  setMembers(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: SetGroupMembersDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.studentGroups.setMembers(id, dto, user);
  }
}
