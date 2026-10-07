import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsUUID } from 'class-validator';

/** The layers GET /timplan-coverage answers today; P3 adds the other two. */
export const COVERAGE_LAYERS = ['planned'] as const;
export type CoverageLayer = (typeof COVERAGE_LAYERS)[number];

export class TimplanCoverageQueryDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.toLowerCase() : value))
  @IsUUID('4', { message: 'academicYearId: läsåret anges med sitt id.' })
  academicYearId!: string;

  /**
   * Optional, 'planned' by default. "Schemalagt" and "genomfört" are the next
   * phase; asking for them is a 400 that says so, not a planned answer under
   * another name.
   */
  @IsOptional()
  @IsIn(COVERAGE_LAYERS, {
    message: "layer: bara 'planned' (planerat mot timplan) finns ännu; schemalagt och genomfört kommer senare.",
  })
  layer?: CoverageLayer;
}
