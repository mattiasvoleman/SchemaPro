import { Global, Module } from '@nestjs/common';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationPreferencesController } from './notification-preferences.controller';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationsService } from './notifications.service';

/** Global so any feature module can inject `NotificationsService` directly. */
@Global()
@Module({
  controllers: [NotificationPreferencesController],
  providers: [NotificationsService, NotificationDeliveryService, NotificationPreferencesService],
  exports: [NotificationsService, NotificationDeliveryService],
})
export class NotificationsModule {}
