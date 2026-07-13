import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

/** Saves a named snapshot of the current master timetable. */
export class CreateScheduleVersionDto {
  @IsUUID('4')
  academicYearId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;
}
