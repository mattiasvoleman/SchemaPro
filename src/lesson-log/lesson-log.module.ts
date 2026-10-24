import { Module } from '@nestjs/common';
import { ClassBookService } from './class-book.service';
import { LessonLogController } from './lesson-log.controller';
import { LessonLogService } from './lesson-log.service';

@Module({
  controllers: [LessonLogController],
  providers: [LessonLogService, ClassBookService],
  exports: [LessonLogService],
})
export class LessonLogModule {}
