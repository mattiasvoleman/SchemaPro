import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsNumber, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import { IsCalendarDate } from '../../resources/dto/is-calendar-date';
import { COST_CATEGORIES, PAYROLL_FORMATS, type PayrollFormat } from '../analysis.types';
import { SCHOOL_PART_ACCOUNT_MAX, SCHOOL_PART_NAME_MAX } from '../school-part-rules';

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase() : value);

/** GET /api/v1/analysis/key-figures and .../cost-basis: the läsår. */
export class AnalysisYearQueryDto {
  @Transform(lower)
  @IsUUID('4', { message: 'academicYearId: läsåret anges med sitt id.' })
  academicYearId!: string;
}

/**
 * GET /api/v1/analysis/cost-basis. `from` and `to` bound the held cover lessons the vikarie's hours are counted
 * over; without them the year's start to the school's yesterday. Both or neither (the service says so).
 */
export class CostBasisQueryDto extends AnalysisYearQueryDto {
  @IsOptional()
  @IsCalendarDate({ message: 'from: periodens början anges som ÅÅÅÅ-MM-DD.' })
  from?: string;

  @IsOptional()
  @IsCalendarDate({ message: 'to: periodens slut anges som ÅÅÅÅ-MM-DD.' })
  to?: string;
}

/** GET /api/v1/analysis/payroll-basis: the period, both ends, at most 93 days like the vikarie export. */
export class PayrollQueryDto extends AnalysisYearQueryDto {
  @IsCalendarDate({ message: 'from: periodens början anges som ÅÅÅÅ-MM-DD.' })
  from!: string;

  @IsCalendarDate({ message: 'to: periodens slut anges som ÅÅÅÅ-MM-DD.' })
  to!: string;
}

/** POST /api/v1/analysis/payroll-basis/export. */
export class PayrollExportDto extends PayrollQueryDto {
  @IsIn(PAYROLL_FORMATS as readonly string[], { message: 'format: CSV eller XLSX.' })
  format!: PayrollFormat;
}

/** A skoldel as the school writes it. */
export class CreateSchoolPartDto {
  @IsString()
  @MaxLength(SCHOOL_PART_NAME_MAX, { message: `name: högst ${SCHOOL_PART_NAME_MAX} tecken.` })
  name!: string;

  @IsString()
  @MaxLength(SCHOOL_PART_ACCOUNT_MAX, { message: `account: högst ${SCHOOL_PART_ACCOUNT_MAX} tecken.` })
  account!: string;

  @IsInt({ message: 'gradeFrom: en årskurs, 0 (förskoleklass) till 9.' })
  @Min(0, { message: 'gradeFrom: en årskurs, 0 (förskoleklass) till 9.' })
  @Max(9, { message: 'gradeFrom: en årskurs, 0 (förskoleklass) till 9.' })
  gradeFrom!: number;

  @IsInt({ message: 'gradeTo: en årskurs, 0 (förskoleklass) till 9.' })
  @Min(0, { message: 'gradeTo: en årskurs, 0 (förskoleklass) till 9.' })
  @Max(9, { message: 'gradeTo: en årskurs, 0 (förskoleklass) till 9.' })
  gradeTo!: number;
}

export class UpdateSchoolPartDto {
  @IsOptional()
  @IsString()
  @MaxLength(SCHOOL_PART_NAME_MAX, { message: `name: högst ${SCHOOL_PART_NAME_MAX} tecken.` })
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(SCHOOL_PART_ACCOUNT_MAX, { message: `account: högst ${SCHOOL_PART_ACCOUNT_MAX} tecken.` })
  account?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9)
  gradeFrom?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9)
  gradeTo?: number;
}

/** PUT /api/v1/analysis/cost-rates/:category. */
export class CostRateDto {
  @IsNumber({ allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 }, { message: 'hourlyCost: kronor per timme, högst två decimaler.' })
  @Min(0, { message: 'hourlyCost: 0 till 100 000 kronor per timme.' })
  @Max(100_000, { message: 'hourlyCost: 0 till 100 000 kronor per timme.' })
  hourlyCost!: number;
}

/** The :category of a rate route. */
export const COST_CATEGORY_PARAM = new RegExp(`^(${COST_CATEGORIES.join('|')})$`);
