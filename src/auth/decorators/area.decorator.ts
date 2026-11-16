import { SetMetadata } from '@nestjs/common';
import type { AdminArea } from '@prisma/client';

export const AREA_KEY = 'adminArea';

/**
 * What an administrator's write through a route needs (Roller i skolan).
 *
 * - `area`: every one of the areas, because the route writes all of them
 *   (a publication writes the calendar too). The database asks the same of
 *   each table it touches (app.current_user_may); this answers first, with a
 *   403 that names the area, before anything is written.
 * - `decides`: rektor or a full administrator (app.current_user_decides).
 * - `any`: every administrator, and why: the route writes nothing of the
 *   school's (the person's own devices or notices) or only reads.
 *
 * Reading is every administrator's, so RolesGuard holds a requirement only
 * on a request that can write: not on GET, HEAD or OPTIONS. That is what lets
 * a controller carry its area once, on the class, beside its readers.
 * test/route-guards.e2e-spec.ts refuses an administrator's write route that
 * says none of the three.
 */
export type AreaRequirement =
  | { kind: 'area'; areas: readonly AdminArea[] }
  | { kind: 'decides' }
  | { kind: 'any'; reason: string };

/** The route writes these areas; an administrator must write every one. */
export const Area = (...areas: [AdminArea, ...AdminArea[]]): MethodDecorator & ClassDecorator =>
  SetMetadata<string, AreaRequirement>(AREA_KEY, { kind: 'area', areas });

/** The route makes a decision: rektor or a full administrator. */
export const Decides = (): MethodDecorator & ClassDecorator =>
  SetMetadata<string, AreaRequirement>(AREA_KEY, { kind: 'decides' });

/** Every administrator may: the route writes nothing of an area's. Say why. */
export const AnyAdministrator = (reason: string): MethodDecorator & ClassDecorator =>
  SetMetadata<string, AreaRequirement>(AREA_KEY, { kind: 'any', reason });

export const AS_TEACHER_KEY = 'asTeacher';

/**
 * The route is the teacher's own, and an administrator who teaches
 * (AuthenticatedUser.teaches) may use it as one (Administratör som lärare).
 *
 * A door, not a rule. RolesGuard admits a SCHOOL_ADMIN with teaches === true
 * through a route that lists Role.TEACHER and carries this, and only then:
 * every other route behaves as it did, so a route nobody marked stays a no for
 * a teaching administrator (fail closed), and the colleague pages whose rules
 * stay with the teachers (the class teacher, the cover request's colleague
 * side) never carry it. Acting as the teacher is not an area, so the route's
 * @Area is not asked of a person admitted this way; what the person may do
 * on the lesson is the database's (app.lesson_teacher_role and the arms that
 * ask it), which refuses the same request on its own. Say what the route is.
 */
export const AsTeacher = (reason: string): MethodDecorator & ClassDecorator =>
  SetMetadata<string, string>(AS_TEACHER_KEY, reason);
