import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Decides } from '../auth/decorators/area.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { SubjectAccessDto } from './dto/subject-access.dto';
import { SchoolExportService, type SchoolExportView } from './school-export.service';
import { SubjectAccessService, type SubjectAccessAnswer } from './subject-access.service';

/** Resolves when the response has taken what was written, or the client is gone. */
function drained(response: Response): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      response.off('drain', done);
      response.off('close', done);
      resolve();
    };
    response.once('drain', done);
    response.once('close', done);
  });
}

/**
 * Hela skolans data (K5): `/api/v1/school-exports`. Rektor and a full
 * administrator order a zip of the school's data, see its progress and fetch it
 * for three days; nobody else does any of it (SchoolExportService, and the
 * rows' own arms). The writes ask for the decisions (@Decides); the reads are
 * held by the service, since RolesGuard holds a requirement only on a write.
 */
@Controller('api/v1/school-exports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class SchoolExportController {
  constructor(
    private readonly exports: SchoolExportService,
    private readonly subjectAccess: SubjectAccessService,
  ) {}

  /** `GET /school-exports` - the school's recent orders, newest first. */
  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<SchoolExportView[]> {
    return this.exports.list(user);
  }

  /** `POST /school-exports` - orders the school's data. The job builds it within minutes. */
  @Post()
  @Decides()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  order(@CurrentUser() user: AuthenticatedUser): Promise<SchoolExportView> {
    return this.exports.order(user);
  }

  /**
   * `POST /school-exports/subject-access` - a registerutdrag (GDPR art. 15) about
   * one person, as a zip in base64 (the web's client carries JSON only). It is
   * built in the request: one person's rows. Recorded in the läslogg.
   */
  @Post('subject-access')
  @Decides()
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  subjectAccessExtract(@Body() dto: SubjectAccessDto, @CurrentUser() user: AuthenticatedUser): Promise<SubjectAccessAnswer> {
    return this.subjectAccess.extract(user, dto.personId, dto.withRelated === true);
  }

  /** `DELETE /school-exports/:id` - ends an order or withdraws a file before its time. */
  @Delete(':id')
  @Decides()
  @HttpCode(204)
  async withdraw(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthenticatedUser): Promise<void> {
    await this.exports.withdraw(id, user);
  }

  /**
   * `GET /school-exports/:id/file` - the zip, a few pieces at a time. The
   * fetch is recorded before the first byte; the length and the SHA-256 are
   * said in the headers, so a client sees a file cut short.
   */
  @Get(':id/file')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async file(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res() response: Response,
  ): Promise<void> {
    const file = await this.exports.openFile(id, user);
    // Set by hand: with @Res() Nest's @Header decorators are not applied.
    response.setHeader('Content-Type', 'application/zip');
    response.setHeader('Content-Length', String(file.byteSize));
    response.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-SHA256', file.sha256);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.status(200);
    try {
      for await (const piece of file.pieces()) {
        if (response.destroyed) return;
        if (!response.write(piece)) await drained(response);
        if (response.destroyed) return;
      }
      response.end();
    } catch {
      // The headers are out: all that can be said is a cut-off body, which the length gives away.
      response.destroy();
    }
  }
}
