import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Marked `@Global` so every feature module can inject `PrismaService` without
 * importing `DatabaseModule` explicitly. Only import this module once — in
 * `AppModule`.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class DatabaseModule {}
