import { Controller, Get, Header, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { Roles } from '../../auth/decorators/roles.decorator';
import { Role } from '../../auth/enums/role.enum';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard';
import { RolesGuard } from '../../auth/roles.guard';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { ScbFileService } from './scb-file.service';
import type { ScbFile } from './scb-pedpers';

/**
 * SCB:s Pedagogisk personal, the file (scb-pedpers.ts). The admin's: it names
 * every teacher with their post, its anställningsform and its karriärtjänst,
 * and each download is in the läslogg (EMPLOYMENT and PEOPLE). Of the
 * administrators, those who read HR data (Roller i skolan): the service
 * refuses the rest with HR_NOT_YOURS, since RolesGuard holds an @Area only
 * on a write and lets every administrator's GET through.
 *
 * JSON rather than the file as a body: the web saves `text` as SCB's .txt,
 * writes `rows` as a CSV for Excel, and lists `missing` and `notices` beside
 * the download, all from one read and one läslogg entry. no-store: a whole
 * school's posts have no business in a browser's cache.
 */
@Controller('api/v1/staffing')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class ScbFileController {
  constructor(private readonly scb: ScbFileService) {}

  /** `?academicYearId=` — the läsår's file, its rows as on SCB's mätdatum. */
  @Get('scb-file')
  @Header('Cache-Control', 'no-store')
  file(
    @Query('academicYearId', new ParseUUIDPipe({ version: '4' })) academicYearId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ScbFile> {
    return this.scb.build(academicYearId, user);
  }
}
