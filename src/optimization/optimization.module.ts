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
import { ScheduleCandidatesService } from './schedule-candidates.service';
import { EngineTimingService } from './engine-timing.service';
import { FALLBACK_WAIT_MS } from './engine-timing';

@Module({
  imports: [
    // For ScheduleVersionsService: a room apply and a schemaförslag apply
    // snapshot the year first.
    CalendarModule,
    HttpModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const ai = configService.getOrThrow<AiEngineConfig>('aiEngine');
        return {
          baseURL: ai.baseUrl,
          // The default of the module's own client; every call to the engine states its own wait
          // (OptimizationProxyService.callAiEngine), so this is only what a call that did not would get.
          timeout: ai.timeoutMs ?? FALLBACK_WAIT_MS,
          headers: {
            'Accept': 'application/json',
          },
        };
      },
    }),
  ],
  controllers: [OptimizationController],
  providers: [
    // The engine's times, read from the engine (M1): the proxy waits by them.
    EngineTimingService,
    OptimizationProxyService,
    OptimizationJobsService,
    RoomOptimizationService,
    StaffingProposalService,
    // Schemaförslag. Its sweep registers with the global JobRunner when
    // CANDIDATES_BACKGROUND is on; the runner is @Optional, as GallringJob's.
    ScheduleCandidatesService,
  ],
  // Provplanering (src/exams) asks the engine through the same call.
  exports: [OptimizationProxyService],
})
export class OptimizationModule {}
