import { Module } from '@nestjs/common';
import { AckController } from './ack.controller';
import { AckJob } from './ack.job';
import { AckService } from './ack.service';

/**
 * Kvittens: a request for a guardian's confirmation, who confirmed and when,
 * and the one reminder. The job registers with the global JobRunner and hands
 * its notices to the global NotificationsService.
 */
@Module({
  controllers: [AckController],
  providers: [AckService, AckJob],
  // Checklistor asks the guardians for a consent through the same service (the rule ALL), and links the request to its list.
  exports: [AckService],
})
export class AckModule {}
