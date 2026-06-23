import { SetMetadata } from '@nestjs/common';
import type { Role } from '../enums/role.enum';

export const ROLES_KEY = 'roles';

/**
 * Restricts a route (or controller) to the given roles. Enforced by `RolesGuard`.
 *
 * @example
 *   @Roles(Role.SCHOOL_ADMIN, Role.SYSTEM_ADMIN)
 *   @Post('trigger')
 *   trigger() { ... }
 */
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
