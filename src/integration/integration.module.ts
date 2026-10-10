import { Module } from '@nestjs/common';
import {
  IntegrationKeysController,
  Ss12000Controller,
} from './integration.controller';
import { IntegrationKeyGuard } from './integration-key.guard';
import { IntegrationScopeGuard } from './integration-scope.guard';
import { Ss12000V2Controller } from './ss12000-v2/ss12000-v2.controller';
import { Ss12000V2Guard } from './ss12000-v2/ss12000-v2.guard';
import { Ss12000V2Service } from './ss12000-v2/ss12000-v2.service';
import { Ss12000SubscriptionsService } from './ss12000-v2/subscriptions.service';
import { Ss12000WebhookDeliveryService } from './ss12000-v2/webhook-delivery.service';
import { Ss12000Service } from './ss12000.service';
import { Ss12000SourceController, Ss12000SyncController } from './ss12000-sync/ss12000-sync.controller';
import { Ss12000SchedulerService } from './ss12000-sync/ss12000-scheduler.service';
import { Ss12000SourceService } from './ss12000-sync/ss12000-source.service';
import { Ss12000SyncService } from './ss12000-sync/ss12000-sync.service';
import { Ss12000Outbound, Ss12000Secrets } from './ss12000-sync/ss12000-sync.providers';

@Module({
  controllers: [IntegrationKeysController, Ss12000Controller, Ss12000SourceController, Ss12000SyncController, Ss12000V2Controller],
  providers: [
    Ss12000Service,
    IntegrationKeyGuard,
    IntegrationScopeGuard,
    // The provider: /ss12000/v2.0, its subscriptions and their delivery.
    Ss12000V2Guard,
    Ss12000V2Service,
    Ss12000SubscriptionsService,
    Ss12000WebhookDeliveryService,
    // The consumer: the school's SS12000 source, its runs and the nightly tick.
    Ss12000Outbound,
    Ss12000Secrets,
    Ss12000SourceService,
    Ss12000SyncService,
    Ss12000SchedulerService,
  ],
})
export class IntegrationModule {}
