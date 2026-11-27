import { Module } from '@nestjs/common';
import { CalendarModule } from '../calendar/calendar.module';
import { BoardTrayController } from './board-tray.controller';
import { BoardTrayService } from './board-tray.service';

/** Att lägga (E4): the grundschema's tray, and the writes of the board that lay a brick and lock many lessons at once. */
@Module({
  imports: [CalendarModule],
  controllers: [BoardTrayController],
  providers: [BoardTrayService],
  exports: [BoardTrayService],
})
export class BoardTrayModule {}
