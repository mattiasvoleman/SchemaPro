import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, Matches, MaxLength, ValidateIf } from 'class-validator';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * An instant as the gateway answers `updatedAt` (toISOString), or with an
 * offset: date, time and zone, nothing ISO 8601 also allows that Date cannot
 * read (2026-W43, 20261020, a decimal comma).
 */
export const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase() : value);

/** The longest topic, homework and note the database takes (the CHECKs of 20261203090000), in characters. */
export const TOPIC_MAX = 200;
export const HOMEWORK_MAX = 1000;
export const NOTE_MAX = 2000;

/**
 * PUT /api/v1/lesson-logs/lessons/:id: the whole log, as the teacher's form
 * saves it. A field left empty, null or absent is no topic or no homework;
 * both empty removes the log. The service trims, and refuses a topic over
 * more than one line.
 *
 * `basis` is the log the form was looking at: its `updatedAt`, or null when
 * there was none. A log another writer has changed since is refused (409
 * LESSON_LOG_STALE) instead of being overwritten; absent, nothing is checked.
 */
export class PutLessonLogDto {
  @IsOptional()
  @IsString({ message: 'topic: text.' })
  @MaxLength(TOPIC_MAX, { message: `topic: högst ${TOPIC_MAX} tecken.` })
  topic?: string | null;

  @IsOptional()
  @IsString({ message: 'homework: text.' })
  @MaxLength(HOMEWORK_MAX, { message: `homework: högst ${HOMEWORK_MAX} tecken.` })
  homework?: string | null;

  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString({ message: 'basis: när loggen ändrades senast, eller null.' })
  @Matches(INSTANT, { message: 'basis: när loggen ändrades senast, eller null.' })
  basis?: string | null;
}

/**
 * PUT /api/v1/lesson-logs/lessons/:id/substitute-note: the note as the form
 * saves it; empty, null or absent removes it. `basis` as for the log.
 */
export class PutSubstituteNoteDto {
  @IsOptional()
  @IsString({ message: 'body: text.' })
  @MaxLength(NOTE_MAX, { message: `body: högst ${NOTE_MAX} tecken.` })
  body?: string | null;

  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString({ message: 'basis: när notisen ändrades senast, eller null.' })
  @Matches(INSTANT, { message: 'basis: när notisen ändrades senast, eller null.' })
  basis?: string | null;
}

/** GET /api/v1/lesson-logs: the caller's own lessons from `from` to `to`, both included. */
export class LessonLogRangeQueryDto {
  @Matches(ISO_DATE, { message: 'from: ett datum ÅÅÅÅ-MM-DD.' })
  from!: string;

  @Matches(ISO_DATE, { message: 'to: ett datum ÅÅÅÅ-MM-DD.' })
  to!: string;
}

/** GET /api/v1/lesson-logs/class-book: one group's lessons from `from` to `to`, both included. */
export class ClassBookQueryDto {
  @Transform(lower)
  @IsUUID('4', { message: 'groupId: ange vilken klass eller grupp.' })
  groupId!: string;

  @Matches(ISO_DATE, { message: 'from: ett datum ÅÅÅÅ-MM-DD.' })
  from!: string;

  @Matches(ISO_DATE, { message: 'to: ett datum ÅÅÅÅ-MM-DD.' })
  to!: string;
}
