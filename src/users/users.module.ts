import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { SupabaseAdminService } from './supabase-admin.service';

/**
 * Admin-only user management. Combines Supabase identity lifecycle (invite /
 * delete via the service-role key) with the tenant `Users` catalog row that
 * drives RLS role + school resolution. Exports SupabaseAdminService for
 * gallring, which deletes a departed person's login before pseudonymising
 * them.
 */
@Module({
  controllers: [UsersController],
  exports: [UsersService, SupabaseAdminService],
  providers: [UsersService, SupabaseAdminService],
})
export class UsersModule {}
