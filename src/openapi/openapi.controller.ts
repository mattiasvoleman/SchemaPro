import { Controller, Get, Header, UseGuards } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '../auth/enums/role.enum';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { OpenApiService } from './openapi.service';

/**
 * The OpenAPI document of `/api/v1`, for the school's administrators: every
 * profile, the läsare too, since reading is every administrator's. A teacher,
 * a pupil or a guardian, the huvudman's member with no school named, an
 * integration key and a caller with no login are all refused before the
 * handler runs (JwtAuthGuard, HuvudmanGuard, RolesGuard).
 *
 * The same document is committed as docs/api/openapi.json.
 */
@Controller('api/v1/openapi.json')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SCHOOL_ADMIN)
export class OpenApiController {
  constructor(private readonly openApi: OpenApiService) {}

  /** The document, as the text it was built to: the same bytes on every call. */
  @Get()
  @Header('Content-Type', 'application/json; charset=utf-8')
  document(): string {
    return this.openApi.text();
  }
}
