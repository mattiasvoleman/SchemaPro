import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  TIMPLAN_IS_DECIDED,
  WRITE_CONFLICT,
  decidedTimplanConflict,
  decidedTimplanRefusal,
  listNames,
  rethrowPrismaError,
} from './prisma-errors';

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

/**
 * The decided-plan triggers' refusal exactly as @prisma/adapter-pg 7.10 hands
 * it over — copied from a subject delete measured against PostgreSQL 16 on the
 * throwaway compose database, meta and rendered message both.
 */
const PLAN_ID = '83156d11-df1b-4265-b05c-ac94bafe6428';
const triggerRefusal = (
  planName = 'RLS Fixture Beslutad',
  options: { meta?: boolean } = {},
): Prisma.PrismaClientKnownRequestError => {
  const message = `TIMPLAN_IS_DECIDED: lokal timplan "${planName}" är beslutad och dess poster kan inte ändras`;
  return new Prisma.PrismaClientKnownRequestError(
    `\nInvalid \`tx.subject.delete()\` invocation:\n\nDatabase error. Code: \`TP409\`. Message: \`${message}\``,
    {
      code: 'P2039',
      clientVersion: Prisma.prismaVersion.client,
      meta:
        options.meta === false
          ? { modelName: 'Subject' }
          : {
              modelName: 'Subject',
              driverAdapterError: {
                name: 'DriverAdapterError',
                cause: {
                  originalCode: 'TP409',
                  originalMessage: message,
                  kind: 'postgres',
                  code: 'TP409',
                  severity: 'ERROR',
                  message,
                  detail: `localTimplanId=${PLAN_ID}`,
                },
              },
            },
    },
  );
};

describe('decidedTimplanRefusal', () => {
  it('reads the plan’s name and id off the driver cause the adapter carries', () => {
    expect(decidedTimplanRefusal(triggerRefusal())).toEqual({
      planName: 'RLS Fixture Beslutad',
      planId: PLAN_ID,
    });
  });

  it('keeps a quote inside the plan’s name', () => {
    expect(decidedTimplanRefusal(triggerRefusal('Timplan "F–9" 2024'))?.planName).toBe(
      'Timplan "F–9" 2024',
    );
  });

  it('still recognises the refusal from the rendered message when the meta is gone', () => {
    expect(decidedTimplanRefusal(triggerRefusal('Grundskolan', { meta: false }))).toEqual({
      planName: 'Grundskolan',
      planId: null,
    });
  });

  it('is not fooled by another database error, nor by a lookalike', () => {
    expect(decidedTimplanRefusal(knownError('P2039'))).toBeNull();
    expect(decidedTimplanRefusal(knownError('P2003'))).toBeNull();
    expect(
      decidedTimplanRefusal(Object.assign(new Error('Code: `TP409`'), { code: 'P2039' })),
    ).toBeNull();
    expect(decidedTimplanRefusal(undefined)).toBeNull();
  });
});

describe('rethrowPrismaError and a decided timplan', () => {
  it('turns the trigger’s refusal into the 409 the services answer, never a 500', () => {
    let thrown: unknown;
    try {
      rethrowPrismaError(triggerRefusal('Grundskolan 2024'));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConflictException);
    expect((thrown as ConflictException).getResponse()).toEqual({
      code: TIMPLAN_IS_DECIDED,
      message:
        'Den lokala timplanen "Grundskolan 2024" är beslutad och kan inte ändras. Öppna den igen som ett nytt utkast för att göra ändringar.',
    });
  });

  it('names one, several or no plans in Swedish', () => {
    expect(listNames(['A', 'B', 'C'])).toBe('"A", "B" och "C"');
    expect((decidedTimplanConflict(['A', 'B']).getResponse() as { message: string }).message).toBe(
      'De lokala timplanerna "A" och "B" är beslutade och kan inte ändras. Öppna dem igen som nya utkast för att göra ändringar.',
    );
    expect((decidedTimplanConflict([]).getResponse() as { message: string }).message).toMatch(
      /^Den lokala timplanen är beslutad/,
    );
  });
});

/** A driver error under P2039, as the adapter carries one it has no code for. */
const driverError = (originalCode: string, originalMessage: string) =>
  new Prisma.PrismaClientKnownRequestError(
    `Database error. Code: \`${originalCode}\`. Message: \`${originalMessage}\``,
    {
      code: 'P2039',
      clientVersion: Prisma.prismaVersion.client,
      meta: { driverAdapterError: { cause: { originalCode, originalMessage, kind: 'postgres' } } },
    },
  );

describe('rethrowPrismaError and a concurrent write', () => {
  const answer = (error: unknown) => {
    try {
      rethrowPrismaError(error);
    } catch (thrown) {
      return thrown;
    }
    return undefined;
  };

  it('answers a deadlock (P2034) with a 409 that says to try again, not a 500', () => {
    // A timplan save and a subject delete in one draft deadlocked before the
    // subjects service locked the plan first; whatever still deadlocks is a retry.
    const thrown = answer(knownError('P2034'));
    expect(thrown).toBeInstanceOf(ConflictException);
    expect((thrown as ConflictException).getResponse()).toMatchObject({
      code: WRITE_CONFLICT,
      message: expect.stringContaining('Försök igen.'),
    });
  });

  it('reads 40P01 and 40001 under a P2039 the same way', () => {
    for (const code of ['40P01', '40001']) {
      expect(answer(driverError(code, 'deadlock detected'))).toBeInstanceOf(ConflictException);
    }
  });
});

describe('rethrowPrismaError and a lokal timplan CHECK', () => {
  it('answers a timplan CHECK the DTO let through with a 400 naming the field', () => {
    let thrown: unknown;
    try {
      rethrowPrismaError(
        driverError(
          '23514',
          'new row for relation "LocalTimplans" violates check constraint "LocalTimplans_name_is_sane"',
        ),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).message).toMatch(/^name: /);
  });

  it('leaves another table’s CHECK as it was', () => {
    const other = driverError(
      '23514',
      'new row for relation "Lessons" violates check constraint "Lessons_time_is_sane"',
    );
    expect(() => rethrowPrismaError(other)).toThrow(other);
  });
});
