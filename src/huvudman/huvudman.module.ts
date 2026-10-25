import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { HuvudmanController, HuvudmanOwnershipController } from './huvudman.controller';
import { HuvudmanOwnershipService } from './huvudman-ownership.service';
import { HuvudmanService } from './huvudman.service';

/**
 * Huvudman (Kommun, 20261212090000): a huvudman owns schools, its
 * kommunadministratör keeps its members, schools and SS12000 keys, and its
 * members read the schools it owns as their läsare (the resolver, in the
 * database). The SS12000 key's reads are the provider's (src/integration/
 * ss12000-v2).
 */
@Module({
  imports: [UsersModule],
  controllers: [HuvudmanController, HuvudmanOwnershipController],
  providers: [HuvudmanService, HuvudmanOwnershipService],
})
export class HuvudmanModule {}
