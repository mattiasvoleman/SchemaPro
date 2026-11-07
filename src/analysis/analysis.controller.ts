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
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AnyAdministrator, Decides } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { AnalysisThrottlerGuard, PER_ADDRESS } from './analysis-throttler.guard';
import { AnalysisService } from './analysis.service';
import {
  COST_CATEGORIES,
  type CostBasisResponse,
  type CostCategory,
  type CostRateView,
  type KeyFiguresResponse,
  type PayrollBasisResponse,
  type PayrollFileResponse,
  type SchoolPartView,
} from './analysis.types';
import { CostRatesService } from './cost-rates.service';
import {
  AnalysisYearQueryDto,
  CostBasisQueryDto,
  CostRateDto,
  CreateSchoolPartDto,
  KeyFiguresQueryDto,
  PayrollExportDto,
  PayrollQueryDto,
  UpdateSchoolPartDto,
} from './dto/analysis.dto';
import { SchoolPartsService } from './school-parts.service';

const categoryOf = (value: string): CostCategory => {
  if (!(COST_CATEGORIES as readonly string[]).includes(value)) {
    throw new BadRequestException({ message: `category: ${COST_CATEGORIES.join(', ')}.`, code: 'ANALYSIS_CATEGORY' });
  }
  return value as CostCategory;
};

/**
 * Analys och planering: the three views. Administrators only (a teacher has
 * none of it: their own load is where it always was, GET /staffing/load);
 * every route reads, so every administrator profile may ask and the service
 * answers each what it is given (analysis.service.ts: who sees what). The
 * huvudman's reader reads as the school's läsare and is handed aggregates.
 *
 * Limited per login (AnalysisThrottlerGuard): the views build a school's
 * figures in the API process. The one POST only reads and returns a file.
 */
@Controller('api/v1/analysis')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
@AnyAdministrator('Reads only: the views and the payroll file write nothing of the school\'s. The skoldelar and the rates are Decides.')
export class AnalysisController {
  constructor(
    private readonly analysis: AnalysisService,
    private readonly parts: SchoolPartsService,
    private readonly rates: CostRatesService,
  ) {}

  /**
   * `?academicYearId=[&schedule=true]` - nyckeltal per lärare (leaving out tjänstgöringsgrad without HR-läs) and
   * per skola; with `schedule` each teacher's undervisning according to the grundschema too.
   */
  @Get('key-figures')
  @UseGuards(AnalysisThrottlerGuard)
  @Throttle({ default: PER_ADDRESS })
  keyFigures(@Query() query: KeyFiguresQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<KeyFiguresResponse> {
    return this.analysis.keyFigures(query.academicYearId, user, { schedule: query.schedule === true });
  }

  /** `?academicYearId=&from=&to=` - lärartid per elev gånger skolans kostnad per timme, per skoldel och årskurs. */
  @Get('cost-basis')
  @UseGuards(AnalysisThrottlerGuard)
  @Throttle({ default: PER_ADDRESS })
  costBasis(@Query() query: CostBasisQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<CostBasisResponse> {
    return this.analysis.costBasis(query, user);
  }

  /** `?academicYearId=&from=&to=` - kontering per anställning och skoldel; for those who read HR data. */
  @Get('payroll-basis')
  @UseGuards(AnalysisThrottlerGuard)
  @Throttle({ default: PER_ADDRESS })
  payrollBasis(@Query() query: PayrollQueryDto, @CurrentUser() user: AuthenticatedUser): Promise<PayrollBasisResponse> {
    return this.analysis.payrollBasis(query, user);
  }

  /**
   * `POST /analysis/payroll-basis/export` - the löneunderlag as a file, as JSON with the bytes in base64 (the web's
   * client carries JSON, as schedule-exchange does): Excel's Swedish CSV (windows-1252, semicolon) or an .xlsx.
   * Names people, so it is listed in src/common/people-files.ts.
   */
  @Post('payroll-basis/export')
  @UseGuards(AnalysisThrottlerGuard)
  @Throttle({ default: PER_ADDRESS })
  payrollFile(@Body() dto: PayrollExportDto, @CurrentUser() user: AuthenticatedUser): Promise<PayrollFileResponse> {
    return this.analysis.payrollFile(dto, user);
  }

  // ---- The school's skoldelar

  @Get('school-parts')
  listParts(@CurrentUser() user: AuthenticatedUser): Promise<SchoolPartView[]> {
    return this.parts.list(user);
  }

  @Post('school-parts')
  @Decides()
  createPart(@Body() dto: CreateSchoolPartDto, @CurrentUser() user: AuthenticatedUser): Promise<SchoolPartView> {
    return this.parts.create(dto, user);
  }

  @Patch('school-parts/:id')
  @Decides()
  updatePart(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateSchoolPartDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<SchoolPartView> {
    return this.parts.update(id, dto, user);
  }

  @Delete('school-parts/:id')
  @Decides()
  @HttpCode(HttpStatus.NO_CONTENT)
  async removePart(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.parts.remove(id, user);
  }

  // ---- The school's cost of an hour

  @Get('cost-rates')
  listRates(@CurrentUser() user: AuthenticatedUser): Promise<CostRateView[]> {
    return this.rates.list(user);
  }

  @Put('cost-rates/:category')
  @Decides()
  putRate(@Param('category') category: string, @Body() dto: CostRateDto, @CurrentUser() user: AuthenticatedUser): Promise<CostRateView> {
    return this.rates.put(categoryOf(category), dto.hourlyCost, user);
  }

  @Delete('cost-rates/:category')
  @Decides()
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeRate(@Param('category') category: string, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.rates.remove(categoryOf(category), user);
  }
}
