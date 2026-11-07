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
})
export class AckModule {}
