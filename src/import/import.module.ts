import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';

@Module({
  imports: [UsersModule],
  controllers: [ImportController],
  providers: [ImportService],
})
export class ImportModule {}
