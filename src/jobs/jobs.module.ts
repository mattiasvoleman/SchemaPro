import { Global, Module } from '@nestjs/common';
import { JobRunner } from './job-runner';

/**
 * The job runner, `@Global` like DatabaseModule so a job registers with it
 * from whichever module it lives in (integration, notifications, gallring)
 * without that module importing this one. Imported once, in AppModule.
 */
@Global()
@Module({
  providers: [JobRunner],
  exports: [JobRunner],
})
export class JobsModule {}
