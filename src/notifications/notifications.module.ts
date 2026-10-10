import { Global, Module } from '@nestjs/common';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationsService } from './notifications.service';

/** Global so any feature module can inject `NotificationsService` directly. */
@Global()
@Module({
  providers: [NotificationsService, NotificationDeliveryService],
  exports: [NotificationsService, NotificationDeliveryService],
})
export class NotificationsModule {}
