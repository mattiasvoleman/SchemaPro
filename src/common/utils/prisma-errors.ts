import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Maps well-known Prisma errors to HTTP exceptions. Under RLS a write against
 * a row outside the caller's tenant surfaces as P2025 (record not found),
 * which is exactly the semantics we want to expose.
 */
export function rethrowPrismaError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2025') {
      throw new NotFoundException('The requested record does not exist.');
    }
    if (error.code === 'P2002') {
      throw new ConflictException('A record with these values already exists.');
    }
    if (error.code === 'P2003') {
      throw new ConflictException(
        'The operation references a record that does not exist.',
      );
    }
  }
  throw error;
}
