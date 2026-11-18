import { Module } from '@nestjs/common';
import { ImportTemplatesController } from './import-templates.controller';
import { ImportTemplatesService } from './import-templates.service';

/** A school's saved column mappings for its imports (Kolumnmappning, omgång 12, X2). */
@Module({
  controllers: [ImportTemplatesController],
  providers: [ImportTemplatesService],
})
export class ImportTemplatesModule {}
