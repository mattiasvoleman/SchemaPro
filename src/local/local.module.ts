import { Module } from '@nestjs/common';
import {
  ExternalBookingsController,
  ResourceBookingsController,
  ResourceTypesController,
  ResourcesController,
  UtilisationController,
} from './local.controllers';
import { ExternalBookingsService } from './external-bookings.service';
import { ResourceBookingsService } from './resource-bookings.service';
import { ResourceTypesService } from './resource-types.service';
import { ResourcesService } from './resources.service';
import { UtilisationService } from './utilisation.service';

/**
 * Lokal (K3): bookable resources that are not rooms, the associations that hire a
 * room or a resource after school, and the utilisation report. NotificationsModule is
 * @Global, so the decision notice needs no explicit import here.
 */
@Module({
  controllers: [ResourceTypesController, ResourcesController, ResourceBookingsController, ExternalBookingsController, UtilisationController],
  providers: [ResourceTypesService, ResourcesService, ResourceBookingsService, ExternalBookingsService, UtilisationService],
})
export class LocalModule {}
