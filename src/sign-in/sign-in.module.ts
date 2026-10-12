import { Module } from '@nestjs/common';
import { PublicSignInMethodController, SignInMethodController } from './sign-in-methods.controller';
import { SignInMethodsService } from './sign-in-methods.service';

/** "Logga in med skolkonto": the admin's row and /login's lookup (20261020090000). */
@Module({
  controllers: [SignInMethodController, PublicSignInMethodController],
  providers: [SignInMethodsService],
})
export class SignInModule {}
