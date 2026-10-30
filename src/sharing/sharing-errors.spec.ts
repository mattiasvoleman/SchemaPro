import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ROOM_LOAN_OVERLAP, roomLoanRefusal } from './sharing-errors';

/**
 * The room-loan functions' refusals (SQLSTATE class RL, 20261217090000) and
 * the one constraint the API names, as @prisma/adapter-pg hands them over:
 * P2039 with the driver's fields under meta.driverAdapterError.cause, or only
 * the rendered message (scripts/test/probe-delade.ts asserts which the real
 * adapter gives).
 */

const refusal = (state: string, message: string) =>
  new Prisma.PrismaClientKnownRequestError(`Database error. Code: \`${state}\`. Message: \`${message}\``, {
    code: 'P2039',
    clientVersion: 'test',
    meta: { driverAdapterError: { cause: { originalCode: state, originalMessage: message } } },
  });

describe('roomLoanRefusal', () => {
  it.each([
    ['RL400', 'ROOM_LOAN_DECISION_MISSING', BadRequestException, 'Säg om lånet godkänns eller avböjs.'],
    ['RL403', 'ROOM_LOAN_NOT_YOURS', ForbiddenException, 'Lån av salar mellan skolor begärs och beslutas av den som skriver planering.'],
    ['RL404', 'ROOM_LOAN_NOT_FOUND', NotFoundException, 'Lånet finns inte.'],
    ['RL404', 'ROOM_LOAN_ROOM_NOT_FOUND', NotFoundException, 'Salen finns inte bland huvudmannens andra skolors salar.'],
    ['RL404', 'ROOM_LOAN_LOCAL_ROOM_NOT_FOUND', NotFoundException, 'Skolans egen sal för lånet finns inte.'],
    ['RL409', 'ROOM_LOAN_ALREADY_DECIDED', ConflictException, 'Lånet är redan besvarat.'],
    ['RL409', 'ROOM_LOAN_ALREADY_ENDED', ConflictException, 'Lånet är redan avslutat eller avböjt.'],
    ['RL409', 'ROOM_LOAN_NOT_APPROVED', ConflictException, 'Bara ett godkänt lån kan avslutas av ägarskolan.'],
    ['RL409', 'ROOM_LOAN_LOCAL_ROOM_IS_LENT', ConflictException, 'Den salen lånar skolan ut, så den kan inte stå för en lånad sal.'],
    ['RL409', 'ROOM_LOAN_LOCAL_ROOM_IS_ANOTHER', ConflictException, expect.stringContaining('egen sal för den lånade salen')],
    ['RL404', 'ROOM_LOAN_LOCAL_ROOM_TYPE_NOT_FOUND', NotFoundException, 'Salstypen finns inte bland skolans egna salstyper.'],
    ['RL409', 'ROOM_LOAN_LOCAL_ROOM_NAME_TAKEN', ConflictException, expect.stringContaining('ett annat namn på sin sal')],
  ])('answers %s %s with its status, code and sentence', (state, code, type, message) => {
    const answer = roomLoanRefusal(refusal(state, code));

    expect(answer).toBeInstanceOf(type);
    expect((answer as ConflictException).getResponse()).toEqual({ code, message });
  });

  it('reads the state and code from the rendered message when the driver\'s fields are missing', () => {
    const rendered = new Prisma.PrismaClientKnownRequestError(
      'Database error. Code: `RL404`. Message: `ROOM_LOAN_NOT_FOUND`',
      { code: 'P2039', clientVersion: 'test' },
    );

    const answer = roomLoanRefusal(rendered);

    expect(answer).toBeInstanceOf(NotFoundException);
    expect((answer as NotFoundException).getResponse()).toMatchObject({ code: 'ROOM_LOAN_NOT_FOUND' });
  });

  it('answers an RL refusal it does not know by its state, with a sentence of its own', () => {
    const answer = roomLoanRefusal(refusal('RL409', 'something new'));

    expect(answer).toBeInstanceOf(ConflictException);
    expect((answer as ConflictException).getResponse()).toEqual({ code: 'ROOM_LOAN_REFUSED', message: 'Lånet går inte att ändra så.' });
  });

  it('answers an approval over another approved loan (23P01) as the 409 ROOM_LOAN_OVERLAP', () => {
    const answer = roomLoanRefusal(
      new Prisma.PrismaClientKnownRequestError('Raw query failed.', {
        code: 'P2010',
        clientVersion: 'test',
        meta: { driverAdapterError: { cause: { originalCode: '23P01', originalMessage: 'conflicting key value' } } },
      }),
    );

    expect(answer).toBeInstanceOf(ConflictException);
    expect((answer as ConflictException).getResponse()).toMatchObject({ code: ROOM_LOAN_OVERLAP });
  });

  it.each(['RoomLoans_one_local_room_per_room', 'RoomLoans_a_local_room_stands_for_one_room'])(
    'answers a race past the local room\'s check (%s) as the local room\'s refusal, not the overlap',
    (constraint) => {
      const answer = roomLoanRefusal(
        new Prisma.PrismaClientKnownRequestError('Raw query failed.', {
          code: 'P2010',
          clientVersion: 'test',
          meta: {
            driverAdapterError: {
              cause: { originalCode: '23P01', originalMessage: `conflicting key value violates exclusion constraint "${constraint}"` },
            },
          },
        }),
      );

      expect(answer).toBeInstanceOf(ConflictException);
      expect((answer as ConflictException).getResponse()).toMatchObject({ code: 'ROOM_LOAN_LOCAL_ROOM_IS_ANOTHER' });
    },
  );

  it('knows the overlap by the constraint\'s name alone', () => {
    const answer = roomLoanRefusal(
      new Prisma.PrismaClientKnownRequestError(
        'conflicting key value violates exclusion constraint "RoomLoans_a_room_is_lent_once"',
        { code: 'P2010', clientVersion: 'test' },
      ),
    );

    expect((answer as ConflictException).getResponse()).toMatchObject({ code: ROOM_LOAN_OVERLAP });
  });

  it('is nothing for any other error', () => {
    expect(roomLoanRefusal(new Error('boom'))).toBeNull();
    expect(roomLoanRefusal(refusal('HM403', 'HUVUDMAN_NOT_YOURS'))).toBeNull();
    expect(
      roomLoanRefusal(new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' })),
    ).toBeNull();
  });
});
