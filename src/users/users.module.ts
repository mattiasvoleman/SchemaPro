import { Module } from '@nestjs/common';
import { MeController } from './me.controller';
import { MySchoolsService } from './my-schools.service';
import { PerLoginThrottlerGuard } from './per-login-throttler.guard';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { SupabaseAdminService } from './supabase-admin.service';

/**
 * Admin-only user management. Combines Supabase identity lifecycle (invite /
 * delete via the service-role key) with the tenant `Users` catalog row that
 * drives RLS role + school resolution. Exports SupabaseAdminService for
 * gallring, which deletes a departed person's login before pseudonymising
 * them. And the signed-in person's own schools, for the school switcher
 * (MeController, Flera skolor per inloggning).
 */
@Module({
  controllers: [UsersController, MeController],
  exports: [UsersService, SupabaseAdminService],
  providers: [UsersService, SupabaseAdminService, MySchoolsService, PerLoginThrottlerGuard],
})
export class UsersModule {}
