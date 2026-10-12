import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { GallringController } from './gallring.controller';
import { GallringJob } from './gallring.job';
import { GallringService } from './gallring.service';

/**
 * Gallring: the school's retention decisions (/admin/dataskydd) and the
 * nightly job that applies them. Imports UsersModule for the auth
 * provider's admin API, which deletes a departed person's login before they
 * are pseudonymised. The job registers with the global JobRunner.
 */
@Module({
  imports: [UsersModule],
  controllers: [GallringController],
  providers: [GallringService, GallringJob],
})
export class GallringModule {}
