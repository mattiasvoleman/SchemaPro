import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ROLLOVER_GROUP_IS_LINKED,
  ROLLOVER_LINK_IS_FIXED,
  ROLLOVER_LINK_MISMATCH,
  TEACHER_DUTY_BLOCK_IS_THE_ADMINS,
  TEACHER_DUTY_BLOCK_MISMATCH,
  TIMPLAN_IN_USE,
  TIMPLAN_IS_DECIDED,
  WRITE_CONFLICT,
  decidedTimplanConflict,
  decidedTimplanRefusal,
  enrolmentClassKeyRefusal,
  isTimplanInUseRefusal,
  listNames,
  rethrowPrismaError,
  rolloverLinkRefusal,
  teacherDutyBlockRefusal,
  timplanInUseConflict,
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

describe('rethrowPrismaError and a tjänstefördelning CHECK', () => {
  it.each([
    ['TeachingRequirements', 'TeachingRequirements_teacher_load_percent_is_sane', 'teacherLoadPercent'],
    ['TeachingRequirements', 'TeachingRequirements_co_teacher_load_percent_is_sane', 'coTeacherLoadPercent'],
    ['TeacherDuties', 'TeacherDuties_label_is_sane', 'label'],
    ['TeacherDuties', 'TeacherDuties_minutesPerWeek_is_sane', 'minutesPerWeek'],
    ['TeacherDuties', 'TeacherDuties_note_is_sane', 'note'],
    ['TeachingRequirements', 'TeachingRequirements_lesson_lengths_are_canonical', 'lessonLengths'],
  ])('answers %s’s %s with a 400 naming %s', (table, constraint, field) => {
    let thrown: unknown;
    try {
      rethrowPrismaError(
        driverError('23514', `new row for relation "${table}" violates check constraint "${constraint}"`),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).message.startsWith(`${field}: `)).toBe(true);
  });
});

/**
 * The slot-link triggers' refusal as the adapter carries it: P2039, the
 * driver's fields under meta, DETAIL with the two ids. The shape is the one
 * scripts/test/prisma-adapter-probe.ts measures for (o).
 */
const DUTY_ID = '0b4c43a4-6f0e-4b8e-9f63-0d3d2b2a7c11';
const CONSTRAINT_ID = '9d1f3d9e-3c3a-4a55-8c41-7a6b8f0e2d22';
const dutyRefusal = (code: 'TD409' | 'TD403', options: { meta?: boolean } = {}) => {
  const message =
    code === 'TD409'
      ? 'TEACHER_DUTY_BLOCK_MISMATCH: tiden är blockerad av ett uppdrag och förblir en återkommande otillgänglighet för uppdragets lärare'
      : 'TEACHER_DUTY_BLOCK_IS_THE_ADMINS: tiden är blockerad av ett uppdrag och ändras genom uppdraget';
  return new Prisma.PrismaClientKnownRequestError(
    `Database error. Code: \`${code}\`. Message: \`${message}\``,
    {
      code: 'P2039',
      clientVersion: Prisma.prismaVersion.client,
      meta:
        options.meta === false
          ? { modelName: 'AvailabilityConstraint' }
          : {
              modelName: 'AvailabilityConstraint',
              driverAdapterError: {
                name: 'DriverAdapterError',
                cause: {
                  originalCode: code,
                  originalMessage: message,
                  kind: 'postgres',
                  detail: `teacherDutyId=${DUTY_ID} availabilityConstraintId=${CONSTRAINT_ID}`,
                },
              },
            },
    },
  );
};

describe('rethrowPrismaError and a duty’s slot link', () => {
  const answer = (error: unknown) => {
    try {
      rethrowPrismaError(error);
    } catch (thrown) {
      return thrown;
    }
    return undefined;
  };

  it('reads the two ids off the driver cause, and the code alone when the meta is gone', () => {
    expect(teacherDutyBlockRefusal(dutyRefusal('TD409'))).toEqual({
      sqlState: 'TD409',
      teacherDutyId: DUTY_ID,
      availabilityConstraintId: CONSTRAINT_ID,
    });
    expect(teacherDutyBlockRefusal(dutyRefusal('TD403', { meta: false }))).toEqual({
      sqlState: 'TD403',
      teacherDutyId: null,
      availabilityConstraintId: null,
    });
  });

  it('answers TD409 with a 409 TEACHER_DUTY_BLOCK_MISMATCH and TD403 with a 403', () => {
    const conflict = answer(dutyRefusal('TD409'));
    expect(conflict).toBeInstanceOf(ConflictException);
    expect((conflict as ConflictException).getResponse()).toMatchObject({ code: TEACHER_DUTY_BLOCK_MISMATCH });
    const forbidden = answer(dutyRefusal('TD403'));
    expect(forbidden).toBeInstanceOf(ForbiddenException);
    expect((forbidden as ForbiddenException).getResponse()).toMatchObject({
      code: TEACHER_DUTY_BLOCK_IS_THE_ADMINS,
    });
  });

  it('is not fooled by another database error, nor by a lookalike', () => {
    expect(teacherDutyBlockRefusal(knownError('P2039'))).toBeNull();
    expect(teacherDutyBlockRefusal(driverError('TP409', 'TIMPLAN_IS_DECIDED'))).toBeNull();
    expect(teacherDutyBlockRefusal(Object.assign(new Error('Code: `TD409`'), { code: 'P2039' }))).toBeNull();
  });
});

/**
 * The plan key's refusal as @prisma/adapter-pg delivered it against
 * PostgreSQL 16 (migration 20261007130000): P2003, the constraint under
 * cause.constraint.index, and the driver's message telling which side failed.
 */
const yearKeyViolation = (
  side: 'delete' | 'write',
  options: { meta?: boolean; constraint?: string } = {},
): Prisma.PrismaClientKnownRequestError => {
  const constraint = options.constraint ?? 'AcademicYearTimplans_localTimplanId_schoolId_fkey';
  const modelName = side === 'delete' ? 'LocalTimplan' : 'AcademicYearTimplan';
  const originalMessage =
    side === 'delete'
      ? `update or delete on table "LocalTimplans" violates foreign key constraint "${constraint}" on table "AcademicYearTimplans"`
      : `insert or update on table "AcademicYearTimplans" violates foreign key constraint "${constraint}"`;
  return new Prisma.PrismaClientKnownRequestError(
    `Foreign key constraint violated on the constraint: \`${constraint}\``,
    {
      code: 'P2003',
      clientVersion: Prisma.prismaVersion.client,
      meta:
        options.meta === false
          ? { modelName }
          : {
              modelName,
              driverAdapterError: {
                name: 'DriverAdapterError',
                cause: {
                  originalCode: '23503',
                  originalMessage,
                  kind: 'ForeignKeyConstraintViolation',
                  constraint: { index: constraint },
                },
              },
            },
    },
  );
};

describe('rethrowPrismaError and a plan a läsår follows', () => {
  const answer = (error: unknown) => {
    try {
      rethrowPrismaError(error);
    } catch (thrown) {
      return thrown;
    }
    return undefined;
  };

  it('recognises the plan key refusing a delete, from the cause and from the model alone', () => {
    expect(isTimplanInUseRefusal(yearKeyViolation('delete'))).toBe(true);
    expect(isTimplanInUseRefusal(yearKeyViolation('delete', { meta: false }))).toBe(true);
  });

  it('leaves the same key refusing an attachment to a missing plan to the generic 409', () => {
    // The other direction of the one constraint: the plan does not exist, so
    // it is not "in use", and saying so would send the admin looking for years.
    expect(isTimplanInUseRefusal(yearKeyViolation('write'))).toBe(false);
    expect(isTimplanInUseRefusal(yearKeyViolation('write', { meta: false }))).toBe(false);
    const thrown = answer(yearKeyViolation('write'));
    expect(thrown).toBeInstanceOf(ConflictException);
    expect((thrown as ConflictException).message).toBe(
      'The operation references a record that does not exist.',
    );
  });

  it('is not fooled by another key, another code, or a plain error', () => {
    expect(
      isTimplanInUseRefusal(yearKeyViolation('delete', { constraint: 'Rooms_roomTypeId_fkey' })),
    ).toBe(false);
    expect(isTimplanInUseRefusal(knownError('P2003'))).toBe(false);
    expect(isTimplanInUseRefusal(knownError('P2039'))).toBe(false);
    expect(isTimplanInUseRefusal(new Error('AcademicYearTimplans_localTimplanId_schoolId_fkey'))).toBe(false);
  });

  it('answers the refused delete with 409 TIMPLAN_IN_USE, never a 500 or the generic sentence', () => {
    const thrown = answer(yearKeyViolation('delete'));
    expect(thrown).toBeInstanceOf(ConflictException);
    expect((thrown as ConflictException).getResponse()).toMatchObject({ code: TIMPLAN_IN_USE });
    expect((thrown as ConflictException).message).toMatch(/^Den lokala timplanen följs av minst ett läsår/);
  });

  it('names one or several years in Swedish when the caller knows them', () => {
    expect(timplanInUseConflict(['2026/27']).message).toBe(
      'Den lokala timplanen följs av läsåret "2026/27" och kan inte tas bort. ' +
        'Välj en annan timplan för de årskurserna under läsårets "Timplan per årskurs" först.',
    );
    expect(timplanInUseConflict(['2025/26', '2026/27']).message).toMatch(
      /^Den lokala timplanen följs av läsåren "2025\/26" och "2026\/27" och kan inte tas bort\./,
    );
  });

  it('answers the attachment gradeLevel CHECK with a 400 naming the field', () => {
    const thrown = answer(
      driverError(
        '23514',
        'new row for relation "AcademicYearTimplans" violates check constraint "AcademicYearTimplans_gradeLevel_is_sane"',
      ),
    );
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).message).toMatch(/^gradeLevel: /);
  });
});

/**
 * The läsårsrullning link triggers' refusal as @prisma/adapter-pg delivers it:
 * P2039 with the driver's SQLSTATE, message and DETAIL under the cause.
 */
const GROUP_ID = '5a0c1e7e-2b7d-4c3a-9e51-3f2a8d6b1c33';
const linkRefusal = (message: string, options: { meta?: boolean } = {}) =>
  new Prisma.PrismaClientKnownRequestError(
    `Database error. Code: \`LR409\`. Message: \`${message}\``,
    {
      code: 'P2039',
      clientVersion: Prisma.prismaVersion.client,
      meta:
        options.meta === false
          ? { modelName: 'StudentGroup' }
          : {
              modelName: 'StudentGroup',
              driverAdapterError: {
                name: 'DriverAdapterError',
                cause: {
                  originalCode: 'LR409',
                  originalMessage: message,
                  kind: 'postgres',
                  detail: `studentGroupId=${GROUP_ID}`,
                },
              },
            },
    },
  );

describe('rethrowPrismaError and a läsårsrullning link', () => {
  const answer = (error: unknown) => {
    try {
      rethrowPrismaError(error);
    } catch (thrown) {
      return thrown;
    }
    return undefined;
  };

  it.each([
    [ROLLOVER_LINK_IS_FIXED, 'ROLLOVER_LINK_IS_FIXED: en grupps föregångare sätts när läsåret rullas vidare'],
    [ROLLOVER_LINK_MISMATCH, 'ROLLOVER_LINK_MISMATCH: en grupps föregångare ligger i läsåret före gruppens eget läsår'],
    [ROLLOVER_GROUP_IS_LINKED, 'ROLLOVER_GROUP_IS_LINKED: en grupp som är kopplad flyttas inte till ett annat läsår'],
  ])('answers the %s token with a 409 of that code', (code, message) => {
    const conflict = answer(linkRefusal(message));
    expect(conflict).toBeInstanceOf(ConflictException);
    expect((conflict as ConflictException).getResponse()).toMatchObject({ code });
    expect(rolloverLinkRefusal(linkRefusal(message))).toEqual({
      reason: code,
      academicYearId: null,
      studentGroupId: GROUP_ID,
    });
  });

  it('reads the reason off the rendered message when the driver cause is gone', () => {
    expect(
      rolloverLinkRefusal(linkRefusal('ROLLOVER_GROUP_IS_LINKED: flyttas inte', { meta: false })),
    ).toEqual({ reason: ROLLOVER_GROUP_IS_LINKED, academicYearId: null, studentGroupId: null });
  });

  it('is still a 409 when no reason can be read', () => {
    const conflict = answer(linkRefusal('något annat', { meta: false }));
    expect(conflict).toBeInstanceOf(ConflictException);
    expect((conflict as ConflictException).getResponse()).toMatchObject({ code: ROLLOVER_LINK_IS_FIXED });
  });

  it('is not fooled by another trigger, another database error, nor a lookalike', () => {
    expect(rolloverLinkRefusal(knownError('P2039'))).toBeNull();
    expect(rolloverLinkRefusal(driverError('TD409', 'TEACHER_DUTY_BLOCK_MISMATCH'))).toBeNull();
    expect(rolloverLinkRefusal(dutyRefusal('TD409'))).toBeNull();
    expect(rolloverLinkRefusal(Object.assign(new Error('Code: `LR409`'), { code: 'P2039' }))).toBeNull();
    expect(answer(dutyRefusal('TD409'))).toBeInstanceOf(ConflictException);
    expect(((answer(dutyRefusal('TD409')) as ConflictException).getResponse() as { code: string }).code).toBe(
      'TEACHER_DUTY_BLOCK_MISMATCH',
    );
  });
});

describe('rethrowPrismaError and the class history’s keys (timplan P4)', () => {
  const answer = (error: unknown) => {
    try {
      rethrowPrismaError(error);
    } catch (thrown) {
      return thrown;
    }
    return undefined;
  };
  /** A 23503 as @prisma/adapter-pg reports it (measured: the probe's (u5)). */
  const keyRefusal = (constraint: string, message: string, modelName: string, withCause = true) =>
    new Prisma.PrismaClientKnownRequestError(`Foreign key constraint violated on the constraint: \`${constraint}\``, {
      code: 'P2003',
      clientVersion: Prisma.prismaVersion.client,
      meta: withCause
        ? { modelName, driverAdapterError: { cause: { originalCode: '23503', originalMessage: message, constraint: { index: constraint } } } }
        : { modelName },
    });

  it('answers a pupil placed in another school’s class with a 400 naming the field', () => {
    for (const key of ['StudentEnrollments_academicYearId_schoolId_fkey', 'StudentEnrollments_studentGroupId_academicYearId_schoolId_fkey']) {
      const error = keyRefusal(key, `insert or update on table "StudentEnrollments" violates foreign key constraint "${key}"`, 'User');
      expect(enrolmentClassKeyRefusal(error)).toBe('NOT_THE_SCHOOLS');
      const thrown = answer(error);
      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).message).toMatch(/^studentGroupId: /);
    }
  });

  it('answers a class with history moved to another year with 409 STUDENT_GROUP_HAS_ENROLMENT_HISTORY, cause or no cause', () => {
    const key = 'StudentEnrollments_studentGroupId_academicYearId_schoolId_fkey';
    for (const error of [
      keyRefusal(key, `update or delete on table "StudentGroups" violates foreign key constraint "${key}" on table "StudentEnrollments"`, 'StudentGroup'),
      keyRefusal(key, '', 'StudentGroup', false),
    ]) {
      expect(enrolmentClassKeyRefusal(error)).toBe('CLASS_MOVED');
      const thrown = answer(error);
      expect(thrown).toBeInstanceOf(ConflictException);
      expect((thrown as ConflictException).getResponse()).toMatchObject({ code: 'STUDENT_GROUP_HAS_ENROLMENT_HISTORY' });
    }
  });

  it('leaves every other key to the generic answer', () => {
    const other = keyRefusal('TimplanCredits_subjectId_schoolId_fkey', 'insert or update on table "TimplanCredits"', 'TimplanCredit');
    expect(enrolmentClassKeyRefusal(other)).toBeNull();
    expect(enrolmentClassKeyRefusal(knownError('P2025'))).toBeNull();
  });
});
