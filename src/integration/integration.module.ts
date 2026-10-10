import { Module } from '@nestjs/common';
import {
  IntegrationKeysController,
  Ss12000Controller,
} from './integration.controller';
import { IntegrationKeyGuard } from './integration-key.guard';
import { Ss12000Service } from './ss12000.service';
import { Ss12000SourceController, Ss12000SyncController } from './ss12000-sync/ss12000-sync.controller';
import { Ss12000SchedulerService } from './ss12000-sync/ss12000-scheduler.service';
import { Ss12000SourceService } from './ss12000-sync/ss12000-source.service';
import { Ss12000SyncService } from './ss12000-sync/ss12000-sync.service';
import { Ss12000Outbound, Ss12000Secrets } from './ss12000-sync/ss12000-sync.providers';

@Module({
  controllers: [IntegrationKeysController, Ss12000Controller, Ss12000SourceController, Ss12000SyncController],
  providers: [
    Ss12000Service,
    IntegrationKeyGuard,
    // The consumer: the school's SS12000 source, its runs and the nightly tick.
    Ss12000Outbound,
    Ss12000Secrets,
    Ss12000SourceService,
    Ss12000SyncService,
    Ss12000SchedulerService,
  ],
})
export class IntegrationModule {}
