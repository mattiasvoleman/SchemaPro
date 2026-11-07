import { Controller, Get, Header, NotFoundException, Param, Query, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Prisma } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../database/prisma.service';
import { tokenHashOf, viewerTokenOf } from './public-token';
import { isViewerDate, UUID } from './public-timetable.controller';
import { StaffViewerThrottlerGuard } from './staff-viewer-throttler.guard';
import { ViewerMissLimiter } from './viewer-miss-limiter';

/**
 * Schemavisaren for a school whose viewer is for staff (20270118090000,
 * viewerAudience STAFF): the same link or code as the public viewer takes,
 * asked by a signed-in teacher or administrator of the link's school.
 *
 * The public route cannot answer a viewer for staff, and cannot tell who is
 * asking. This one is the other door: JwtAuthGuard and RolesGuard, and the
 * database's app.public_timetable_staff() reads the caller's role and school
 * from their claims. A link that is not the caller's school's, a kind that is
 * off, a target that is hidden or protected, a pupil in a list: the same
 * not-found as the public route's, and an address that tries too many links
 * that do not exist is refused for a while, as there (ViewerMissLimiter, keyed
 * here by the person).
 *
 * The answer names a person's week, so nothing between may keep it: private,
 * no-store. The token is in the path, and the log's redaction hides it there
 * as it does for the public route (redactShareToken).
 */
@Controller('api/v1/schemavisaren')
@UseGuards(JwtAuthGuard, RolesGuard, StaffViewerThrottlerGuard)
@Roles(Role.TEACHER, Role.SCHOOL_ADMIN)
// The global limit keys on the caller's address, and these asks come from the web server: every teacher
// reading the viewer would share one bucket. StaffViewerThrottlerGuard limits per person and per link
// instead, and a person who asks for what does not exist is refused for a while (ViewerMissLimiter).
@SkipThrottle()
export class SchemavisarenStaffController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly limiter: ViewerMissLimiter,
  ) {}

  @Get(':token')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Robots-Tag', 'noindex, nofollow')
  @Header('Referrer-Policy', 'no-referrer')
  async show(
    @Param('token') raw: string,
    @Query('target') target: string | undefined,
    @Query('date') date: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<unknown> {
    const document = await this.read(raw, target, date, user);
    if (document === null) {
      await this.limiter.miss(`user:${user.userId ?? user.authId}`);
      throw new NotFoundException('Schemat finns inte.');
    }
    return document;
  }

  private async read(raw: string, target: string | undefined, date: string | undefined, user: AuthenticatedUser): Promise<unknown | null> {
    const token = viewerTokenOf(raw);
    if (token === null) return null;
    if (target !== undefined && !UUID.test(target)) return null;
    if (date !== undefined && (typeof date !== 'string' || !isViewerDate(date))) return null;
    const hash = tokenHashOf(token);
    const rows = await this.prisma.withRls(user, async (tx) => {
      // As the public door: two seconds at most, and a short statement that is not worth compiling
      // (PrismaService.withPublicViewer). A signed-in person is not let hold a connection longer than a visitor.
      await tx.$executeRaw`SET LOCAL statement_timeout = '2s'`;
      await tx.$executeRaw`SET LOCAL jit = off`;
      return tx.$queryRaw<{ doc: unknown }[]>(
        Prisma.sql`SELECT app.public_timetable_staff(${hash}, ${target ?? null}::uuid, ${date ?? null}::date) AS "doc"`,
      );
    });
    return rows?.[0]?.doc ?? null;
  }
}
