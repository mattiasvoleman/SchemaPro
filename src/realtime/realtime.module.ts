import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';

/**
 * Live schedule updates over Socket.IO. Global so any feature module can
 * inject `RealtimeService` to broadcast after a lesson mutation.
 */
@Global()
@Module({
  imports: [AuthModule],
  providers: [RealtimeGateway, RealtimeService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
