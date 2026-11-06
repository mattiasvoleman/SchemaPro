import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

/** POST /api/v1/school-exports/subject-access: whose data, and whether their guardians' or children's come with it. */
export class SubjectAccessDto {
  @IsUUID('4')
  personId!: string;

  /** A pupil's guardians, or a guardian's children, each with the data of their own. A protected person's come with no one. */
  @IsOptional()
  @IsBoolean()
  withRelated?: boolean;
}
