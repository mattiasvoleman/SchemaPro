import { Module } from '@nestjs/common';
import { OpenApiController } from './openapi.controller';
import { OpenApiService } from './openapi.service';

/** The OpenAPI document of `/api/v1`, served to the school's administrators. */
@Module({
  controllers: [OpenApiController],
  providers: [OpenApiService],
})
export class OpenApiModule {}
