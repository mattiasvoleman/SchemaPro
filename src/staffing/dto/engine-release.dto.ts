import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsBoolean, IsUUID } from 'class-validator';

/**
 * Body for `PUT /api/v1/staffing/engine-release`: the posts of one läsår whose "släppt för motorn" is set or taken back.
 *
 * The shortcut "the whole subject in a year" is the page's: it lists the posts of the subject and the årskurs and sends their ids
 * here, so there is one write path and one truth, the post's own row. A subject released this way is the posts it had when the
 * button was pressed; a post made afterwards is not released.
 */
export class SetEngineReleaseDto {
  @IsUUID('4', { message: 'academicYearId must be a valid UUIDv4.' })
  academicYearId!: string;

  /** At most the engine's own requirement cap, as the proposal's pinned list is. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  @ArrayUnique()
  @IsUUID('4', { each: true })
  requirementIds!: string[];

  /** True releases the posts for the engine, false takes the release back. Setting a state a post is already in changes nothing. */
  @IsBoolean()
  released!: boolean;
}
