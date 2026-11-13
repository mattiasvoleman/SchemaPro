import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { appointerGone, frameRefusal, rethrowClassTeacherError, staleDraft, staleLesson } from './class-teacher-errors';
import { CODES, FRAME_MESSAGES, FRAME_REASONS, LESSON_IS_PLACED_MESSAGE } from './class-teacher.types';

const sqlError = (state: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError('refused', { code: 'P2010', clientVersion: 'test', meta: { driverAdapterError: { cause: { originalCode: state } } } });

describe('frame refusals', () => {
  it('says every reason in words, and codes the three kinds of answer', () => {
    for (const reason of FRAME_REASONS) expect(FRAME_MESSAGES[reason]).toMatch(/\S/);
    expect(frameRefusal('NOT_APPOINTED')).toBeInstanceOf(ForbiddenException);
    expect((frameRefusal('NOT_APPOINTED').getResponse() as { code: string }).code).toBe(CODES.NOT_APPOINTED);
    expect(frameRefusal('LESSON_GONE')).toBeInstanceOf(NotFoundException);
    const outside = frameRefusal('SHARED_ROOM');
    expect(outside).toBeInstanceOf(ForbiddenException);
    expect(outside.getResponse()).toEqual({ message: FRAME_MESSAGES.SHARED_ROOM, code: CODES.OUTSIDE_FRAME, params: { reason: 'SHARED_ROOM' } });
  });

  it('says a lesson written from a förläggning as the gateway’s own reason, outside the frame, which is not one of the frame’s (the web mirrors those)', () => {
    const placed = frameRefusal('LESSON_IS_PLACED');
    expect(placed).toBeInstanceOf(ForbiddenException);
    expect(placed.getResponse()).toEqual({ message: LESSON_IS_PLACED_MESSAGE, code: CODES.OUTSIDE_FRAME, params: { reason: 'LESSON_IS_PLACED' } });
    expect(FRAME_REASONS as readonly string[]).not.toContain('LESSON_IS_PLACED');
  });

  it('keeps the list and the sentences one to one', () => {
    expect(Object.keys(FRAME_MESSAGES).sort()).toEqual([...FRAME_REASONS].sort());
    expect(new Set(FRAME_REASONS).size).toBe(FRAME_REASONS.length);
  });
});

describe('stale and gone', () => {
  it('carries what changed or what is now', () => {
    const stale = staleLesson({ changed: [{ field: 'roomId', was: 'a', now: 'b' }] });
    expect(stale).toBeInstanceOf(ConflictException);
    // Flat, because the global filter forwards a problem's code and flat params and nothing else of its body.
    expect(stale.getResponse()).toMatchObject({ code: CODES.STALE, params: { changed: 'roomId' } });
    const now = staleLesson({ current: { version: 'c'.repeat(32) } });
    expect(now.getResponse()).toMatchObject({ code: CODES.STALE, params: { version: 'c'.repeat(32) } });
    expect(staleLesson({}).getResponse()).toEqual({ message: expect.any(String), code: CODES.STALE });
    expect(staleDraft({ rev: 4 }).getResponse()).toMatchObject({ code: CODES.REV, params: { rev: 4 } });
    expect(appointerGone().getResponse()).toMatchObject({ code: CODES.APPOINTER_GONE });
  });
});

describe('rethrowClassTeacherError', () => {
  it('lets a coded answer through', () => {
    const coded = new ConflictException('x');
    expect(() => rethrowClassTeacherError(coded)).toThrow(coded);
  });

  it('turns the database’s claimed states into coded answers', () => {
    const answer = (state: string): unknown => {
      try {
        rethrowClassTeacherError(sqlError(state));
      } catch (error) {
        return error;
      }
      return undefined;
    };
    expect(answer('CT403')).toBeInstanceOf(ForbiddenException);
    expect(answer('CT404')).toBeInstanceOf(NotFoundException);
    expect(answer('CT409')).toBeInstanceOf(ConflictException);
    expect(answer('CT422')).toBeInstanceOf(ConflictException);
    expect(answer('CT400')).toBeInstanceOf(BadRequestException);
    expect(answer('23514')).toBeInstanceOf(BadRequestException);
    expect((answer('42501') as ForbiddenException).getResponse()).toMatchObject({ code: CODES.OUTSIDE_FRAME });
  });

  it('answers a deadlock or a serialization failure of the draft layer as a write conflict to try again, not as an unknown error', () => {
    // A trigger or a cascade that the database aborted (40P01) or could not serialize (40001): nothing was written.
    for (const state of ['40P01', '40001']) {
      const thrown = (() => {
        try {
          rethrowClassTeacherError(sqlError(state));
        } catch (error) {
          return error as ConflictException;
        }
        return null;
      })();
      expect(thrown).toBeInstanceOf(ConflictException);
      expect((thrown!.getResponse() as { code: string }).code).toBe('WRITE_CONFLICT');
    }
    expect(() => rethrowClassTeacherError(new Prisma.PrismaClientKnownRequestError('conflict', { code: 'P2034', clientVersion: 'test' }))).toThrow(ConflictException);
  });

  it('rethrows what it does not know, and a lock timeout is a busy publication', () => {
    const odd = new Error('boom');
    expect(() => rethrowClassTeacherError(odd)).toThrow(odd);
    expect(() => rethrowClassTeacherError(sqlError('99999'))).toThrow(Prisma.PrismaClientKnownRequestError);
    expect(() => rethrowClassTeacherError(new Error('lock timeout'))).toThrow(ConflictException);
  });
});
