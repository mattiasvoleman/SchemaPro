import {
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/** Cancels a scheduled lesson, optionally recording a reason. */
export class CancelLessonDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** Assigns a substitute teacher to a single calendar lesson. */
export class AssignSubstituteDto {
  @IsUUID('4')
  teacherId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/**
 * Moves a single calendar lesson to a different room (or clears the room when
 * `roomId` is null). Used by the day planner and the teacher-absence workflow.
 */
export class ChangeRoomDto {
  /**
   * `null` clears the room; a uuid moves the lesson to that room.
   *
   * The one ValidateIf left that carries its own weight, and it is not the
   * pair-with-IsOptional shape: `roomId` is required. IsOptional would wave
   * through an omitted field too, collapsing "leave the room alone" and "take
   * the room away" into one request. ValidateIf alone lets null past and still
   * demands the caller say something.
   */
  @ValidateIf((dto: ChangeRoomDto) => dto.roomId !== null)
  @IsUUID('4')
  roomId!: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
