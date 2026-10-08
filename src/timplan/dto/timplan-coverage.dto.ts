import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsUUID } from 'class-validator';

/**
 * The layers GET /timplan-coverage answers: planerat mot timplan (P2),
 * schemalagt mot planerat and genomfört mot schemalagt (P3).
 */
export const COVERAGE_LAYERS = ['planned', 'scheduled', 'delivered'] as const;
export type CoverageLayer = (typeof COVERAGE_LAYERS)[number];

export class TimplanCoverageQueryDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @IsUUID('4', { message: 'academicYearId: läsåret anges med sitt id.' })
  academicYearId!: string;

  /** Optional, 'planned' by default — P2's answer, unchanged. */
  @IsOptional()
  @IsIn(COVERAGE_LAYERS, {
    message: "layer: 'planned', 'scheduled' eller 'delivered'.",
  })
  layer?: CoverageLayer;

  /**
   * The drill-down of layers 2 and 3: an admin gets every pupil of this
   * group with their lines; a teacher gets the same group-level answer as
   * without it. Refused with layer=planned (the service says so), so P2's
   * answer keeps its one shape.
   */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @IsUUID('4', { message: 'studentGroupId: gruppen anges med sitt id.' })
  studentGroupId?: string;
}
