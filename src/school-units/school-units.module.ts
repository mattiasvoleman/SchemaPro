import { Module } from '@nestjs/common';
import { SchoolUnitsController } from './school-units.controller';
import { SchoolUnitsService } from './school-units.service';

@Module({
  controllers: [SchoolUnitsController],
  providers: [SchoolUnitsService],
  exports: [SchoolUnitsService],
})
export class SchoolUnitsModule {}
