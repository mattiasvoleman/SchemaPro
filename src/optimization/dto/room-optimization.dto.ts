import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';
import type { Walkers } from '../interfaces/room-walks.interface';

const WALKERS: readonly Walkers[] = ['TEACHERS', 'GROUPS', 'BOTH'];

/** Body for `POST /api/v1/optimization/rooms/proposal`. Writes nothing. */
export class RoomProposalDto {
  @IsUUID('4', { message: 'academicYearId must be a valid UUIDv4.' })
  academicYearId!: string;

  /** Whose walking the objective pays for; both tallies come back either way. */
  @IsIn(WALKERS)
  walkers!: Walkers;
}

/**
 * One lesson's move, carrying the room it is moving FROM.
 *
 * The from-room is what makes an apply safe to replay and to reverse: a lesson
 * is only moved if it is still where the proposal found it, and undo is the
 * same change with the two rooms swapped. A roomless lesson cannot be named —
 * the room optimisation never gives a room to a lesson without one.
 */
export class RoomChangeDto {
  @IsUUID('4')
  lessonId!: string;

  @IsUUID('4')
  fromRoomId!: string;

  @IsUUID('4')
  toRoomId!: string;
}

/** Body for `POST /api/v1/optimization/rooms/apply`, and for its undo. */
export class ApplyRoomChangesDto {
  @IsUUID('4', { message: 'academicYearId must be a valid UUIDv4.' })
  academicYearId!: string;

  /** The sha256 hex digest the proposal (or the previous apply) returned. */
  @Matches(/^[0-9a-f]{64}$/, { message: 'basis must be a sha256 hex digest.' })
  basis!: string;

  /**
   * Capped at the engine's own lesson cap: a proposal cannot move more lessons
   * than it was allowed to send. 5000 moves is about 750 kB of JSON, inside the
   * 1 MB body limit.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => RoomChangeDto)
  changes!: RoomChangeDto[];
}
