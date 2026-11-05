import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AnyAdministrator, Area } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { ApplyImportDto, ExportDto, PreviewImportDto, SummaryQueryDto, type UploadedFileDto } from './dto/exchange.dto';
import { ScheduleExchangeService } from './exchange.service';
import type { UploadedFile } from './exchange-files';

const filesOf = (files: UploadedFileDto[]): UploadedFile[] =>
  files.map((f) => ({ name: f.name, bytes: Buffer.from(f.contentBase64, 'base64') }));

/**
 * Schemat som tabell och i öppna format: the grundschema out as CSV, Excel,
 * Untis GPU or aSc XML, and a file of those formats in as locked lessons.
 *
 * The export and the preview write nothing and are open to every
 * administrator, a läsare included; the apply writes the grundschema and the
 * timplansposter it implies, so it asks for Schemaläggning and Planering.
 * Heavy: a preview runs the clash scan once per row, so the routes are
 * throttled hard.
 */
@Controller('api/v1/schedule-exchange')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@Throttle({ default: { limit: 10, ttl: 60_000 } })
export class ScheduleExchangeController {
  constructor(private readonly exchange: ScheduleExchangeService) {}

  /** `GET /schedule-exchange/summary?academicYearId=` - what an export would hold, for the page. */
  @Get('summary')
  summary(@Query() query: SummaryQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return this.exchange.summary(query.academicYearId, user);
  }

  /**
   * `POST /schedule-exchange/export` - the file, as JSON with the bytes in
   * base64. A POST, because the web's client (api.post) carries JSON and its
   * session header, and a download link would need neither; the export only
   * reads, which AnyAdministrator says.
   */
  @Post('export')
  @AnyAdministrator('Exporten läser schemat och skriver ingenting av skolans.')
  async export(@Body() dto: ExportDto, @CurrentUser() user: AuthenticatedUser) {
    const file = await this.exchange.export(dto.academicYearId, dto.format, user);
    return { filename: file.filename, contentType: file.contentType, contentBase64: file.body.toString('base64') };
  }

  /** `POST /schedule-exchange/import/preview` - the plan, writing nothing. */
  @Post('import/preview')
  @AnyAdministrator('Förhandsvisningen skriver ingenting av skolans: den läser schemat som exporten gör.')
  preview(@Body() dto: PreviewImportDto, @CurrentUser() user: AuthenticatedUser) {
    return this.exchange.preview({ ...dto, files: filesOf(dto.files) }, user);
  }

  /** `POST /schedule-exchange/import/apply` - the previewed plan, all of it or none. */
  @Post('import/apply')
  @Area('SCHEMALAGGNING', 'PLANERING')
  apply(@Body() dto: ApplyImportDto, @CurrentUser() user: AuthenticatedUser) {
    return this.exchange.apply({ ...dto, files: filesOf(dto.files) }, user);
  }
}
