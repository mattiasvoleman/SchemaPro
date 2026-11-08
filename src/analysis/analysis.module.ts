import { Module } from '@nestjs/common';
import { CoverModule } from '../cover/cover.module';
import { StaffingModule } from '../staffing/staffing.module';
import { AnalysisController } from './analysis.controller';
import { AnalysisService } from './analysis.service';
import { AnalysisThrottlerGuard } from './analysis-throttler.guard';
import { CostRatesService } from './cost-rates.service';
import { SchoolPartsService } from './school-parts.service';

/**
 * Analys och planering (K1): nyckeltal per lärare och skola, kostnadsunderlag
 * per elev och löneunderlag med konton, beside the two things the school
 * states for them, its skoldelar (kostnadsställen with a konto) and the cost of
 * an hour per personalkategori. It reads the belastningsrapport (StaffingModule)
 * and the vikarie export (CoverModule) and keeps nothing of its own but those
 * two tables.
 */
@Module({
  imports: [StaffingModule, CoverModule],
  controllers: [AnalysisController],
  providers: [AnalysisService, SchoolPartsService, CostRatesService, AnalysisThrottlerGuard],
})
export class AnalysisModule {}
