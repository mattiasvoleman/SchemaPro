import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsOptional, Matches } from 'class-validator';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A query flag as a URL carries it: "true" or "false", nothing else. */
const flag = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);

/** GET /print/timetables: every class's, teacher's or room's week of a date. */
export class PrintTimetablesQueryDto {
  @IsIn(['GROUP', 'TEACHER', 'ROOM'], { message: "kind: 'GROUP', 'TEACHER' eller 'ROOM'." })
  kind!: 'GROUP' | 'TEACHER' | 'ROOM';

  /** Any day of the week to print. */
  @Matches(ISO_DATE, { message: 'date: YYYY-MM-DD.' })
  date!: string;

  /** How the sheets name teachers; the school's own choice for Schemavisaren when absent. */
  @IsOptional()
  @IsIn(['NONE', 'SIGNATURE', 'NAME'], { message: "teachers: 'NONE', 'SIGNATURE' eller 'NAME'." })
  teachers?: 'NONE' | 'SIGNATURE' | 'NAME';

  /** Whether a class's sheet draws its meals; the school's setting when absent. */
  @IsOptional()
  @Transform(flag)
  @IsBoolean({ message: "meals: 'true' eller 'false'." })
  meals?: boolean;
}

/** GET /timetable-validity: the week of a date and what its days are valid for. */
export class TimetableValidityQueryDto {
  @Matches(ISO_DATE, { message: 'week: YYYY-MM-DD.' })
  week!: string;
}
