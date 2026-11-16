import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsUUID, Matches, Max, Min, ValidateNested } from 'class-validator';

/** The most förläggningar one block can hold: its lessons a week, with room to spare. */
export const MAX_PLACEMENTS_PER_BLOCK = 40;

/** The most rooms one lesson names: one per member, which a block has few of. */
export const MAX_ROOMS_PER_BLOCK_LESSON = 40;

/** A member's own room for one lesson of the block. */
export class BlockRoomInputDto {
  @IsUUID('4', { message: 'rooms: posten anges med sitt id.' })
  requirementId!: string;

  @IsUUID('4', { message: 'rooms: salen anges med sitt id.' })
  roomId!: string;
}

/**
 * One lesson of a block: where it stands, and the rooms the members chose for it. A member that is not named has its room
 * chosen by the engine at every Generera. The length, the weeks and the members are the block's to say (block-placement-fit.ts),
 * and the weeks are the block's: they are not stated here.
 */
export class BlockPlacementInputDto {
  @IsInt({ message: 'placements: veckodagen anges som ett heltal, 1 för måndag till 5 för fredag.' })
  @Min(1, { message: 'placements: veckodagen är 1 (måndag) till 5 (fredag).' })
  @Max(5, { message: 'placements: veckodagen är 1 (måndag) till 5 (fredag).' })
  dayOfWeek!: number;

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, { message: 'placements: starttiden anges som HH:MM.' })
  startTime!: string;

  @IsInt({ message: 'placements: lektionslängden anges i hela minuter.' })
  @Min(15, { message: 'placements: minst 15 minuter per lektion.' })
  @Max(240, { message: 'placements: högst 240 minuter per lektion.' })
  minutes!: number;

  @IsOptional()
  @IsArray({ message: 'placements: salarna anges som en lista.' })
  @ArrayMaxSize(MAX_ROOMS_PER_BLOCK_LESSON, { message: `placements: högst ${MAX_ROOMS_PER_BLOCK_LESSON} salar per lektion.` })
  @ValidateNested({ each: true })
  @Type(() => BlockRoomInputDto)
  rooms?: BlockRoomInputDto[];
}

/** The whole list of a block's förläggningar, which replaces the stored one; empty removes them all. */
export class ReplaceBlockPlacementsDto {
  @IsArray({ message: 'placements: anges som en lista.' })
  @ArrayMaxSize(MAX_PLACEMENTS_PER_BLOCK, { message: `placements: högst ${MAX_PLACEMENTS_PER_BLOCK} förläggningar per block.` })
  @ValidateNested({ each: true })
  @Type(() => BlockPlacementInputDto)
  placements!: BlockPlacementInputDto[];

  /**
   * The key of the block's lessons as the client read them (`rowsKey` of the read). When it differs from the stored lessons the
   * server answers 409 BLOCK_PLACEMENTS_STALE and writes nothing; left out, the save replaces whatever is stored.
   */
  @IsOptional()
  @Matches(/^[0-9a-f]{32}$/, { message: 'baseKey: nyckeln anges som den lästes.' })
  baseKey?: string;
}
