import { ForbiddenException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { requireSchoolId } from './request-context';

const principal = (schoolId: string | undefined): AuthenticatedUser =>
  ({
    authId: '11111111-1111-4111-8111-111111111111',
    userId: '22222222-2222-4222-8222-222222222222',
    role: 'SCHOOL_ADMIN',
    schoolId,
  }) as AuthenticatedUser;

describe('requireSchoolId', () => {
  it('returns the tenant id from the verified principal', () => {
    expect(requireSchoolId(principal('school-1'))).toBe('school-1');
  });

  it('rejects a principal with no school association', () => {
    expect(() => requireSchoolId(principal(undefined))).toThrow(
      ForbiddenException,
    );
  });

  it('rejects an empty-string school id rather than returning it', () => {
    // An empty tenant would silently widen every downstream `where` clause.
    expect(() => requireSchoolId(principal(''))).toThrow(ForbiddenException);
  });
});
