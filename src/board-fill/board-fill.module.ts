import { Module } from '@nestjs/common';
import { BoardTrayModule } from '../board-tray/board-tray.module';
import { CalendarModule } from '../calendar/calendar.module';
import { BoardFillController } from './board-fill.controller';
import { BoardFillService } from './board-fill.service';

/** Lägg det som går (E7a): a proposal for the tray, and the write that takes it in. */
@Module({
  imports: [CalendarModule, BoardTrayModule],
  controllers: [BoardFillController],
  providers: [BoardFillService],
  exports: [BoardFillService],
})
export class BoardFillModule {}
