import { Module } from '@nestjs/common';
import { FamilyModule } from '../family/family.module';
import { ScheduleExchangeModule } from '../schedule-exchange/exchange.module';
import { SchoolExportController } from './school-export.controller';
import { SchoolExportJob } from './school-export.job';
import { SchoolExportService } from './school-export.service';
import { SubjectAccessService } from './subject-access.service';

/**
 * Hela skolans data (K5): the order and the fetch (controller, service) and
 * the job that builds the file. The job reuses the gateway's own reads: the
 * guardian links of FamilyReadsService and Schema som fil's export, so the
 * file holds what those pages hold.
 */
@Module({
  imports: [FamilyModule, ScheduleExchangeModule],
  controllers: [SchoolExportController],
  providers: [SchoolExportService, SchoolExportJob, SubjectAccessService],
})
export class SchoolExportModule {}
