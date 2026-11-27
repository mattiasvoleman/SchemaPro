import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, Min } from 'class-validator';
import { EXEMPTABLE_RULES, type ExemptableRule } from '../../calendar/lesson-exemption';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Att lägga: lay one brick of a post's part (its lessons of this teacher and length) where the reader put it. The brick is named by
 * its part and the picture the reader read it in (`partKey`, the tray's): a brick is any one of the part's, so which one needs no name.
 */
export class LayBrickDto {
  @IsUUID('4')
  academicYearId!: string;

  @IsUUID('4')
  postId!: string;

  /** The part's teacher, null for the lessons nobody teaches (which cannot be laid). */
  @IsOptional()
  @IsUUID('4')
  teacherId?: string | null;

  /** The part's length: the post has several parts when it has several lengths. */
  @IsInt()
  @Min(5)
  @Max(600)
  minutes!: number;

  /** The tray's key of the part, as the brick was read: the write is refused when it is not the part's now. */
  @IsString()
  @Matches(/^[0-9a-f]{16}$/)
  partKey!: string;

  /** The lesson on the tray the brick is, when it is one (`lessonId` of the brick): it is moved back, and no new lesson is made. */
  @IsOptional()
  @IsUUID('4')
  lessonId?: string;

  @IsInt()
  @Min(1)
  @Max(7)
  dayOfWeek!: number;

  @Matches(TIME, { message: 'startTime must be HH:MM, 00:00–23:59.' })
  startTime!: string;

  /** The room, or null for none ("Utan sal"): the lesson is laid all the same. Left out is none. */
  @IsOptional()
  @IsUUID('4')
  roomId?: string | null;

  /**
   * UNDANTAG MED FLIT, as on a hand edit (CreateMasterLessonDto.exempt): the rules of the board the administrator answers yes to ("Lägg ändå") for THIS
   * time, by name: `FRAME` (the stage's ramtid) and `LUNCH` (the class's meal), and no other. The judge asks it of the lay as of every hand edit; a rule
   * named that the time does not break is saved on nothing, and a saved exemption locks the lesson (it is locked by the lay already).
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(EXEMPTABLE_RULES.length)
  @IsIn(EXEMPTABLE_RULES, { each: true })
  exempt?: ExemptableRule[];
}
