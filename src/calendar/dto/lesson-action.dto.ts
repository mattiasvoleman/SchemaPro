import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';

/** What CalendarLessons.cancelCause admits (migration 20261009090000). */
export const LESSON_CANCEL_CAUSES = ['TEACHER_UNAVAILABLE', 'ROOM_UNAVAILABLE', 'MANUAL'] as const;
export type LessonCancelCauseValue = (typeof LESSON_CANCEL_CAUSES)[number];

/** Cancels a scheduled lesson, optionally recording a reason. */
export class CancelLessonDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  /**
   * Why, as a category: the teacher-absence page sends TEACHER_UNAVAILABLE.
   * Optional; absent is MANUAL, "inställd av skolan" — what every cancel
   * meant before the field existed. The free-text reason stays in `reason`.
   */
  @IsOptional()
  @IsIn(LESSON_CANCEL_CAUSES, {
    message: "cause: 'TEACHER_UNAVAILABLE', 'ROOM_UNAVAILABLE' eller 'MANUAL'.",
  })
  cause?: LessonCancelCauseValue;
}

/** Assigns a substitute teacher to a single calendar lesson. */
export class AssignSubstituteDto {
  @IsUUID('4')
  teacherId!: string;

  /**
   * The one teacher the substitute replaces; their row alone leaves the
   * lesson and a co-teacher stays. Absent, every row is replaced, as the
   * endpoint always did.
   */
  @IsOptional()
  @IsUUID('4')
  replacesTeacherId?: string;

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
   * through an omitted field too, and the service reads every roomId that is
   * not null as a room to look up — so a body that forgot the field would
   * reach that lookup with no id instead of being refused here with the field
   * named. ValidateIf alone lets null past and still demands the caller say
   * something.
   */
  @ValidateIf((dto: ChangeRoomDto) => dto.roomId !== null)
  @IsUUID('4')
  roomId!: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
