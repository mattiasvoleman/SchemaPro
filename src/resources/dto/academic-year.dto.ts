import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class CreateAcademicYearDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name!: string;

  @Matches(ISO_DATE, { message: 'startDate must be YYYY-MM-DD.' })
  startDate!: string;

  @Matches(ISO_DATE, { message: 'endDate must be YYYY-MM-DD.' })
  endDate!: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateAcademicYearDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @Matches(ISO_DATE, { message: 'startDate must be YYYY-MM-DD.' })
  startDate?: string;

  @IsOptional()
  @Matches(ISO_DATE, { message: 'endDate must be YYYY-MM-DD.' })
  endDate?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
