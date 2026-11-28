import { IsUUID } from 'class-validator';

/** Skriv in förläggningarna (E4b): the year whose förläggningar are written to the grundschema. */
export class WriteInPlacementsDto {
  @IsUUID('4', { message: 'academicYearId: ett läsårs id.' })
  academicYearId!: string;
}
