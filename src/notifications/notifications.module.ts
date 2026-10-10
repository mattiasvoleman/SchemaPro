import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PushConfig } from '../config/configuration';
import { DevicesController } from './devices.controller';
import { DevicesService } from './devices.service';
import { ExpoPushClient } from './expo-push.client';
import { NotificationDeliveryService } from './notification-delivery.service';
import { PushReceiptsService } from './push-receipts.service';
import { NotificationPreferencesController } from './notification-preferences.controller';
import { NotificationPreferencesService } from './notification-preferences.service';
import { NotificationsService } from './notifications.service';

/** Global so any feature module can inject `NotificationsService` directly. */
@Global()
@Module({
  controllers: [NotificationPreferencesController, DevicesController],
  providers: [
    NotificationsService,
    NotificationDeliveryService,
    NotificationPreferencesService,
    DevicesService,
    PushReceiptsService,
    {
      // One client per process, so its pacing is the process's.
      provide: ExpoPushClient,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const push = config.get<PushConfig>('push');
        return new ExpoPushClient({ apiUrl: push?.apiUrl ?? 'https://exp.host/--/api/v2/push', accessToken: push?.accessToken });
      },
    },
  ],
  exports: [NotificationsService, NotificationDeliveryService],
})
export class NotificationsModule {}
