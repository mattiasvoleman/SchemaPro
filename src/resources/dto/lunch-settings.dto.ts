import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';
import type { PlacementRuleMode } from '@prisma/client';
import {
  PLACE_LIMIT_MAX,
  PLACE_LIMIT_MIN,
  PLACEMENT_RULE_MODES,
  PLACEMENT_WEIGHT_MAX,
  PLACEMENT_WEIGHT_MIN,
} from '../placement-rules';

const TIME = /^\d{2}:\d{2}(:\d{2})?$/;

/**
 * Placeringsregler (20270126090000): the messages name the field, as the
 * other bounds of the Skolregler do, and the bounds are the database's own
 * (LunchSettings_placement…Weight_check and …PerDay_check).
 */
export const PLACEMENT_MODE_MESSAGE = 'Läget anges som OFF (av), SOFT (mjuk) eller HARD (hård).';
export const PLACEMENT_WEIGHT_MESSAGE = `Vikten är ett heltal ${PLACEMENT_WEIGHT_MIN}–${PLACEMENT_WEIGHT_MAX}.`;
export const PLACE_LIMIT_MESSAGE = `Gränsen är ett heltal ${PLACE_LIMIT_MIN}–${PLACE_LIMIT_MAX} (1 är en enda sal eller byggnad per dag, aldrig byte), eller null för ingen gräns.`;

/**
 * The school's lunch rules and the size of its dining hall.
 *
 * One payload, no separate create: a school has exactly one dining hall, so the
 * endpoint upserts the single row rather than pretending there is a collection
 * to page through.
 *
 * The bounds here mirror the solver's own limits deliberately. Its time grid
 * runs 08:00-18:00 in 15-minute slots and rejects anything that does not land
 * on one, and the gateway throws away the engine's error body before it reaches
 * an admin — so a window the solver cannot parse would be saved silently and
 * fail, unexplained, on every generation from then on.
 */
export class UpsertLunchSettingsDto {
  @IsBoolean()
  lunchEnabled!: boolean;

  @Matches(TIME, { message: 'lunchStartTime must be HH:MM.' })
  lunchStartTime!: string;

  @Matches(TIME, { message: 'lunchEndTime must be HH:MM.' })
  lunchEndTime!: string;

  /** A break shorter than a slot cannot be placed; 120 minutes is the engine's cap. */
  @IsInt()
  @Min(15)
  @Max(120)
  lunchMinutes!: number;

  /**
   * Seats in the dining hall. Null means the school has no limit worth
   * modelling, and the solver then places lunch exactly as it did before.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5000)
  diningSeats?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  maxLessonsPerDayPerGroup?: number | null;

  /**
   * Restid i generatorn: the generator keeps the walk between the school's
   * skolområden. OPTIONAL, and absent leaves the stored value as it is: a
   * Skolregler tab loaded before the switch existed PUTs the row without it,
   * and must not turn the rule off that a colleague turned on. A school's
   * first row starts with it off, the column's default. Absent, and not
   * null: `@IsOptional` would let a null through to a NOT NULL column, a 500
   * where the caller deserves the 400 that names the field.
   */
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  generatorKeepsTravelTime?: boolean;

  /**
   * Elevernas håltimmar: the generator keeps the pupils' idle time between
   * their lessons down. Optional on exactly the travel switch's terms above:
   * absent leaves the stored value as it is, null is refused with the 400
   * that names the field.
   */
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  generatorKeepsPupilGapsDown?: boolean;

  /**
   * Sammanhängande undervisning (20261218090000): the generator tries to keep
   * each teacher's stretches of teaching within the limit their work rule
   * states. A wish and not a guarantee, off until the school turns it on.
   * Optional on exactly the travel switch's terms above: absent leaves the
   * stored value as it is, null is refused with the 400 that names the field.
   */
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  generatorKeepsConsecutiveTeaching?: boolean;

  /**
   * Bästa möjliga schema (20270125090000): the school lets an administrator
   * who plans ask for a timetable in which five of its own shaping rules may
   * give way, listed for the school to accept before it is applied. Off until
   * the school turns it on. Optional on exactly the travel switch's terms
   * above: absent leaves the stored value as it is, null is refused with the
   * 400 that names the field.
   */
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  generatorBestEffort?: boolean;

  /**
   * Placeringsregler (20270126090000), regel 1: a subject marked not first /
   * not last in a class's day (Subject.notFirstInDay, notLastInDay) is kept
   * off the first / the last lesson of the day. OFF until the school turns it
   * on; SOFT pays `placementEdgeWeight` per lesson at an end it should not be
   * at. HARD (forbids it) is refused with PLACEMENT_EDGE_HARD_NOT_OFFERED
   * until a hard rule 1 has been measured on a large school (it cost 4.5 times
   * the first timetable): the engine and the database know it, the API does
   * not take it. Every field of the three rules is optional on
   * exactly the switches' terms above: absent leaves the stored value as it
   * is, and null is refused with the 400 that names the field (the columns are
   * NOT NULL), except a limit, where null clears it.
   */
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(PLACEMENT_RULE_MODES, { message: PLACEMENT_MODE_MESSAGE })
  placementEdgeMode?: PlacementRuleMode;

  /** SOFT only. Kept while the mode is OFF (or, for rule 3, HARD), so a switch back does not lose the figure. */
  @ValidateIf((_, value) => value !== undefined)
  @IsInt({ message: PLACEMENT_WEIGHT_MESSAGE })
  @Min(PLACEMENT_WEIGHT_MIN, { message: PLACEMENT_WEIGHT_MESSAGE })
  @Max(PLACEMENT_WEIGHT_MAX, { message: PLACEMENT_WEIGHT_MESSAGE })
  placementEdgeWeight?: number;

  /**
   * Regel 2: at most this many different room groups and buildings in a day,
   * for a class and for a teacher apart. SOFT needs at least one of the four
   * limits (the service judges the row as it would be, and answers
   * PLACEMENT_PLACES_NEEDS_A_LIMIT). HARD is refused with
   * PLACEMENT_PLACES_HARD_NOT_OFFERED, on rule 1's terms above: it cost 2.8 to
   * 3.6 times the first timetable (9 with one worker) and the objective phase
   * with it is not measured.
   */
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(PLACEMENT_RULE_MODES, { message: PLACEMENT_MODE_MESSAGE })
  placementPlacesMode?: PlacementRuleMode;

  @ValidateIf((_, value) => value !== undefined)
  @IsInt({ message: PLACEMENT_WEIGHT_MESSAGE })
  @Min(PLACEMENT_WEIGHT_MIN, { message: PLACEMENT_WEIGHT_MESSAGE })
  @Max(PLACEMENT_WEIGHT_MAX, { message: PLACEMENT_WEIGHT_MESSAGE })
  placementPlacesWeight?: number;

  /** Most different room groups a class is in during a day (1 is a single one). Null: no limit; absent: as stored. */
  @IsOptional()
  @IsInt({ message: PLACE_LIMIT_MESSAGE })
  @Min(PLACE_LIMIT_MIN, { message: PLACE_LIMIT_MESSAGE })
  @Max(PLACE_LIMIT_MAX, { message: PLACE_LIMIT_MESSAGE })
  maxClassRoomsPerDay?: number | null;

  @IsOptional()
  @IsInt({ message: PLACE_LIMIT_MESSAGE })
  @Min(PLACE_LIMIT_MIN, { message: PLACE_LIMIT_MESSAGE })
  @Max(PLACE_LIMIT_MAX, { message: PLACE_LIMIT_MESSAGE })
  maxTeacherRoomsPerDay?: number | null;

  @IsOptional()
  @IsInt({ message: PLACE_LIMIT_MESSAGE })
  @Min(PLACE_LIMIT_MIN, { message: PLACE_LIMIT_MESSAGE })
  @Max(PLACE_LIMIT_MAX, { message: PLACE_LIMIT_MESSAGE })
  maxClassBuildingsPerDay?: number | null;

  @IsOptional()
  @IsInt({ message: PLACE_LIMIT_MESSAGE })
  @Min(PLACE_LIMIT_MIN, { message: PLACE_LIMIT_MESSAGE })
  @Max(PLACE_LIMIT_MAX, { message: PLACE_LIMIT_MESSAGE })
  maxTeacherBuildingsPerDay?: number | null;

  /**
   * Regel 3: the pupils of the lessons in a room marked canBeShared, at one
   * time, fit its capacity together. SOFT pays `placementSharedWeight` per
   * pupil over it at the room's worst moment, HARD forbids it.
   */
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(PLACEMENT_RULE_MODES, { message: PLACEMENT_MODE_MESSAGE })
  placementSharedMode?: PlacementRuleMode;

  @ValidateIf((_, value) => value !== undefined)
  @IsInt({ message: PLACEMENT_WEIGHT_MESSAGE })
  @Min(PLACEMENT_WEIGHT_MIN, { message: PLACEMENT_WEIGHT_MESSAGE })
  @Max(PLACEMENT_WEIGHT_MAX, { message: PLACEMENT_WEIGHT_MESSAGE })
  placementSharedWeight?: number;
}
