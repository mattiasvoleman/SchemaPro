import { Transform } from 'class-transformer';
import { IsOptional, IsUUID } from 'class-validator';

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase() : value);

/** GET /timplan-stages: the year (the active one answers), and optionally a class to drill into. */
export class TimplanStageQueryDto {
  @Transform(lower)
  @IsUUID('4', { message: 'academicYearId: läsåret anges med sitt id.' })
  academicYearId!: string;

  /** The drill-down: every pupil of this home class, ids only. */
  @IsOptional()
  @Transform(lower)
  @IsUUID('4', { message: 'studentGroupId: klassen anges med sitt id.' })
  studentGroupId?: string;
}

/** POST /timplan-stages/statements: publish for the active year. */
export class PublishTimplanStatementDto {
  @Transform(lower)
  @IsUUID('4', { message: 'academicYearId: läsåret anges med sitt id.' })
  academicYearId!: string;
}

/** GET /timplan-stages/card: whose card. A pupil's is always their own. */
export class TeachingTimeCardQueryDto {
  @IsOptional()
  @Transform(lower)
  @IsUUID('4', { message: 'studentId: eleven anges med sitt id.' })
  studentId?: string;
}
