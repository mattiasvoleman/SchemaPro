import { Module } from '@nestjs/common';
import { YearRolloverController } from './year-rollover.controller';
import { YearRolloverService } from './year-rollover.service';

/**
 * Läsårsrullning: the rollover of a läsår into the next, and the activation
 * that moves the pupils. The registry of what is carried is
 * rollover-registry.ts; its completeness test fails for a per-year table
 * nobody has classified.
 */
@Module({
  controllers: [YearRolloverController],
  providers: [YearRolloverService],
})
export class YearRolloverModule {}
