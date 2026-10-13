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
