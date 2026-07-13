import { Global, Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

/** Global so any feature module can inject `NotificationsService` directly. */
@Global()
@Module({
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
