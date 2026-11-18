import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Area } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { CreateImportTemplateDto, ListImportTemplatesQueryDto, UpdateImportTemplateDto } from './dto/import-template.dto';
import { ImportTemplatesService, type ImportTemplateView } from './import-templates.service';

/**
 * A school's saved column mappings for its imports (Kolumnmappning, X2). Every administrator reads them, a läsare
 * included (the guard holds the area only on a request that can write); Planering makes, changes and removes them,
 * and the database's arms say the same. The mapping is applied in the browser, so no route here reads a file.
 */
@Controller('api/v1/import-templates')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Area('PLANERING')
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class ImportTemplatesController {
  constructor(private readonly templates: ImportTemplatesService) {}

  /** `GET /import-templates?kind=` - the school's templates for one kind of import, or for all of them. */
  @Get()
  list(@Query() query: ListImportTemplatesQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<ImportTemplateView[]> {
    return this.templates.list(query, user);
  }

  @Post()
  create(@Body() dto: CreateImportTemplateDto, @CurrentUser() user: AuthenticatedUser): Promise<ImportTemplateView> {
    return this.templates.create(dto, user);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateImportTemplateDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ImportTemplateView> {
    return this.templates.update(id, dto, user);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.templates.remove(id, user);
  }
}
