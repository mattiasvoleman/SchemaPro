import { Module } from '@nestjs/common';
import { MealCountsController } from './meal-counts.controller';
import { MealCountsService } from './meal-counts.service';
import { MealLetterJob } from './meal-letter.job';

/**
 * Måltidskollen: the portions of each lunch sitting (/admin/meals), the file of them for Excel, and the daily
 * letter to the kitchen. The job registers with the global JobRunner and sends through the global
 * NotificationDeliveryService.
 */
@Module({
  controllers: [MealCountsController],
  providers: [MealCountsService, MealLetterJob],
})
export class MealCountsModule {}
