import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IMPORT_TEMPLATE_KINDS, type ImportTemplateKind } from '../import-fields';

/** The most posts a template holds: a file with two hundred columns is as wide as a school's sheet gets. */
export const IMPORT_TEMPLATE_MAX_PLACEMENTS = 200;

/**
 * One column of the school's file, and what it is. `key` is the header with case, spaces, punctuation and
 * diacritics dropped (web/lib/csv-export.ts normalizeHeader), with `#2`, `#3` for a header that stands twice and
 * `kolumn<n>` for one that normalises to nothing, so it is letters, digits and at most one `#`. `label` is the
 * header as written, for the dialog to show; empty for a header that looks like a personnummer. `field` is one of
 * the kind's fields, or null for "read nothing from this column". Which fields belong to which kind is the
 * service's to say (it needs the kind); the DTO says the field is a name.
 */
export class ImportTemplatePlacementDto {
  @IsString()
  @Matches(/^[a-z0-9]{1,100}(#[0-9]{1,3})?$/, { message: 'key: en normaliserad rubrik, bara små bokstäver och siffror.' })
  key!: string;

  @IsString()
  @MaxLength(120)
  label!: string;

  @ValidateIf((_: object, value: unknown) => value !== null)
  @IsString()
  @Matches(/^[A-Za-z][A-Za-z0-9]{0,59}$/, { message: 'field: ett fältnamn.' })
  field!: string | null;
}

/** `GET /import-templates?kind=` */
export class ListImportTemplatesQueryDto {
  @IsOptional()
  @IsIn(IMPORT_TEMPLATE_KINDS)
  kind?: ImportTemplateKind;
}

/** `POST /import-templates` */
export class CreateImportTemplateDto {
  @IsIn(IMPORT_TEMPLATE_KINDS)
  kind!: ImportTemplateKind;

  /** Trimmed and held to 1..80 characters by the service (the bound is the database's CHECK too). */
  @IsString()
  @MaxLength(200)
  name!: string;

  /** The file row the headers stand on when a title lies above them; absent or null is the first row with content. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  headerRow?: number | null;

  @IsArray()
  @ArrayMaxSize(IMPORT_TEMPLATE_MAX_PLACEMENTS)
  @ValidateNested({ each: true })
  @Type(() => ImportTemplatePlacementDto)
  placements!: ImportTemplatePlacementDto[];
}

/**
 * `PATCH /import-templates/:id`. The kind is the template's own and never changes: a mapping made for one kind's
 * fields is not another's. Absent is "keep what it is"; `headerRow: null` takes the row back to "the first".
 */
export class UpdateImportTemplateDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  headerRow?: number | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(IMPORT_TEMPLATE_MAX_PLACEMENTS)
  @ValidateNested({ each: true })
  @Type(() => ImportTemplatePlacementDto)
  placements?: ImportTemplatePlacementDto[];
}
