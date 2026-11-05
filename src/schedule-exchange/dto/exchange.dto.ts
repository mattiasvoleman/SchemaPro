import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { EXCHANGE_FORMATS, type ExchangeFormat } from '../exchange-files';

/** `POST /schedule-exchange/export`. */
export class ExportDto {
  @IsUUID('4')
  academicYearId!: string;

  @IsIn(EXCHANGE_FORMATS)
  format!: ExchangeFormat;
}

export class SummaryQueryDto {
  @IsUUID('4')
  academicYearId!: string;
}

/**
 * A file, as the browser reads it: base64, because JSON carries no bytes and
 * the formats are three kinds of text and one zip. The whole body is held to
 * the API's 1 MB (MAX_BODY_SIZE), so a file is at most about 700 kB, which is
 * some 2 500 lessons of the largest format.
 */
export class UploadedFileDto {
  @IsString()
  @MaxLength(200)
  name!: string;

  @IsString()
  @MaxLength(1_000_000)
  @Matches(/^[A-Za-z0-9+/]*={0,2}$/, { message: 'contentBase64 must be base64.' })
  contentBase64!: string;
}

export class PreviewImportDto {
  @IsUUID('4')
  academicYearId!: string;

  @IsIn(EXCHANGE_FORMATS)
  format!: ExchangeFormat;

  /** One file for the table and aSc formats; the Untis files (up to GPU001, GPU002 and GPU011), or one zip of them. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ValidateNested({ each: true })
  @Type(() => UploadedFileDto)
  files!: UploadedFileDto[];

  /**
   * The school's period times for a period-numbered Untis file, one period a
   * line ("1 08:10-09:10"). Untis writes no file with its time grid, so a
   * GPU001 that carries only period numbers needs it from the school.
   */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  periods?: string;
}

export class ApplyImportDto extends PreviewImportDto {
  /** The fingerprint of the preview this apply is for. */
  @IsString()
  @Matches(/^[0-9a-f]{32}$/)
  fingerprint!: string;
}
