import { Module } from '@nestjs/common';
import { AckModule } from '../ack/ack.module';
import { ChecklistsController } from './checklists.controller';
import { ConsentService } from './consent.service';
import { InstructionService } from './instruction.service';

/**
 * Checklistor: instruction proofs and consent lists. A consent is asked of the guardians through Kvittens
 * (AckModule's service), which is the one confirmation there is.
 */
@Module({
  imports: [AckModule],
  controllers: [ChecklistsController],
  providers: [InstructionService, ConsentService],
})
export class ChecklistsModule {}
