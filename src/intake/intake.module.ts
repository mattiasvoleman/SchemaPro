import { Module } from '@nestjs/common';
import { IntakeController } from './intake.controller';
import { IntakeService } from './intake.service';

/**
 * Vad kom in: the read of what the school's base data holds and what is missing from it (P1 Pilotkit). It uses the
 * global PrismaService and nothing else, and it writes nothing.
 */
@Module({
  controllers: [IntakeController],
  providers: [IntakeService],
})
export class IntakeModule {}
