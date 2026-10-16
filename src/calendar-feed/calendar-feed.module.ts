import { Module } from '@nestjs/common';
import { CalendarFeedThrottlerGuard } from './calendar-feed-throttler.guard';
import { CalendarFeedsController } from './calendar-feeds.controller';
import { CalendarFeedsService } from './calendar-feeds.service';
import { PublicCalendarFeedController } from './public-calendar-feed.controller';

/** Kalenderprenumeration (migration 20261112091000): a person's calendar feed of their published week. */
@Module({
  controllers: [CalendarFeedsController, PublicCalendarFeedController],
  providers: [CalendarFeedsService, CalendarFeedThrottlerGuard],
})
export class CalendarFeedModule {}
