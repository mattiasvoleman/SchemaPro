import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';

/** Liveness/readiness probes. `PrismaService` comes from the global DatabaseModule. */
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
