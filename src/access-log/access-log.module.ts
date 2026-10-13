import { Module } from '@nestjs/common';
import { AccessLogController } from './access-log.controller';
import { AccessLogService } from './access-log.service';

/**
 * Läsloggen's reader for the administrator. The writer is not a provider:
 * every service records its own reads with recordRead (./access-log.ts), in
 * the transaction it read in.
 */
@Module({
  controllers: [AccessLogController],
  providers: [AccessLogService],
})
export class AccessLogModule {}
