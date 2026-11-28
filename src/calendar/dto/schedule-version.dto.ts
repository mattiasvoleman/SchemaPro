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

/** Byter namn på en version (E9). Allt annat i en version är en ögonblicksbild och ändras inte. */
export class RenameScheduleVersionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;
}
