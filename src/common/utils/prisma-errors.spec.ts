import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { rethrowPrismaError } from './prisma-errors';

const knownError = (code: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError(`Simulated ${code}`, {
    code,
    clientVersion: Prisma.prismaVersion.client,
  });

describe('rethrowPrismaError', () => {
  it('maps P2025 (record not found) to 404', () => {
    // Under RLS a write against another tenant's row also surfaces as P2025,
    // so 404 is the intended answer for both cases.
    expect(() => rethrowPrismaError(knownError('P2025'))).toThrow(
      NotFoundException,
    );
    // The sentence is what the caller reads as the problem's detail.
    expect(() => rethrowPrismaError(knownError('P2025'))).toThrow(
      'The requested record does not exist.',
    );
  });

  it('maps P2002 (unique constraint) to 409', () => {
    expect(() => rethrowPrismaError(knownError('P2002'))).toThrow(
      ConflictException,
    );
  });

  it('maps P2003 (foreign key constraint) to 409', () => {
    expect(() => rethrowPrismaError(knownError('P2003'))).toThrow(
      ConflictException,
    );
  });

  it('distinguishes the two conflict messages', () => {
    expect(() => rethrowPrismaError(knownError('P2002'))).toThrow(
      'A record with these values already exists.',
    );
    expect(() => rethrowPrismaError(knownError('P2003'))).toThrow(
      'The operation references a record that does not exist.',
    );
  });

  it('rethrows an unmapped Prisma error code unchanged', () => {
    const error = knownError('P2010');
    expect(() => rethrowPrismaError(error)).toThrow(error);
  });

  it('maps only Prisma’s own errors, not another error carrying the same code', () => {
    // Anything can have a `code`. Only a PrismaClientKnownRequestError is
    // Prisma saying that a record is missing.
    const lookalike = Object.assign(new Error('from somewhere else'), {
      code: 'P2025',
    });
    expect(() => rethrowPrismaError(lookalike)).toThrow(lookalike);
  });

  it('rethrows a non-Prisma error unchanged', () => {
    const error = new TypeError('boom');
    expect(() => rethrowPrismaError(error)).toThrow(error);
  });

  it('rethrows non-Error values unchanged', () => {
    expect(() => rethrowPrismaError('plain string')).toThrow('plain string');
  });
});
