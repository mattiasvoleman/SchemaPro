import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import type { AiEngineConfig } from '../config/configuration';
import { CalendarModule } from '../calendar/calendar.module';
import { OptimizationController } from './optimization.controller';
import { OptimizationProxyService } from './optimization-proxy.service';
import { OptimizationJobsService } from './optimization-jobs.service';
import { RoomOptimizationService } from './room-optimization.service';
import { StaffingProposalService } from './staffing-proposal.service';

@Module({
  imports: [
    // For ScheduleVersionsService: a room apply snapshots the year first.
    CalendarModule,
    HttpModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const ai = configService.getOrThrow<AiEngineConfig>('aiEngine');
        return {
          baseURL: ai.baseUrl,
          timeout: ai.timeoutMs,
          headers: {
            'Accept': 'application/json',
          },
        };
      },
    }),
  ],
  controllers: [OptimizationController],
  providers: [
    OptimizationProxyService,
    OptimizationJobsService,
    RoomOptimizationService,
    StaffingProposalService,
  ],
})
export class OptimizationModule {}
