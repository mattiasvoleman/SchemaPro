import { Module } from '@nestjs/common';
import {
  IntegrationKeysController,
  Ss12000Controller,
} from './integration.controller';
import { IntegrationKeyGuard } from './integration-key.guard';
import { Ss12000Service } from './ss12000.service';

@Module({
  controllers: [IntegrationKeysController, Ss12000Controller],
  providers: [Ss12000Service, IntegrationKeyGuard],
})
export class IntegrationModule {}
