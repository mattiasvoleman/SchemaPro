import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/*
 * Vikariefrågan's DTOs. NO FREE TEXT: a request names lessons and colleagues,
 * never a reason or a message (a message would be read by every colleague
 * asked, and by whoever reads their lock screen). forbidNonWhitelisted
 * refuses a `note` or a `message` sent anyway.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.toLowerCase() : value);
const lowerAll = ({ value }: { value: unknown }) => (Array.isArray(value) ? value.map((v) => lower({ value: v })) : value);

/** A request asks for at most this many lessons and this many colleagues. */
export const MAX_REQUEST_LESSONS = 12;
export const MAX_REQUEST_RECIPIENTS = 25;
/** The time a request can be answered in, in minutes: five minutes to half a day. */
export const MIN_EXPIRY_MINUTES = 5;
export const MAX_EXPIRY_MINUTES = 720;
export const DEFAULT_EXPIRY_MINUTES = 60;

export class RequestLessonDto {
  @Transform(lower)
  @IsUUID('4', { message: 'lessonId: lektionen anges med sitt id.' })
  lessonId!: string;

  @Transform(lower)
  @IsUUID('4', { message: 'absenceId: frånvaron anges med sitt id.' })
  absenceId!: string;
}

export class CreateCoverRequestDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'lessons: minst en lektion.' })
  @ArrayMaxSize(MAX_REQUEST_LESSONS, { message: `lessons: högst ${MAX_REQUEST_LESSONS} lektioner i en förfrågan.` })
  @ValidateNested({ each: true })
  @Type(() => RequestLessonDto)
  lessons!: RequestLessonDto[];

  @Transform(lowerAll)
  @IsArray()
  @ArrayMinSize(1, { message: 'recipientIds: minst en kollega.' })
  @ArrayMaxSize(MAX_REQUEST_RECIPIENTS, { message: `recipientIds: högst ${MAX_REQUEST_RECIPIENTS} kollegor i en förfrågan.` })
  @ArrayUnique({ message: 'recipientIds: en kollega bara en gång.' })
  @IsUUID('4', { each: true, message: 'recipientIds: kollegorna anges med sina id.' })
  recipientIds!: string[];

  /** Until when it can be answered, from now; never later than the first lesson starts. */
  @IsOptional()
  @IsInt({ message: 'expiresInMinutes: ett helt antal minuter.' })
  @Min(MIN_EXPIRY_MINUTES, { message: `expiresInMinutes: minst ${MIN_EXPIRY_MINUTES} minuter.` })
  @Max(MAX_EXPIRY_MINUTES, { message: `expiresInMinutes: högst ${MAX_EXPIRY_MINUTES} minuter.` })
  expiresInMinutes?: number;
}

export class FairnessQueryDto {
  @Matches(ISO_DATE, { message: 'from: YYYY-MM-DD.' })
  from!: string;

  @Matches(ISO_DATE, { message: 'to: YYYY-MM-DD.' })
  to!: string;
}
