import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PAYROLL_NUMBER_MAX, UpsertTeacherEmploymentDto } from './dto/teacher-employment.dto';
import { EMPLOYMENT_HR_FIELDS, hideHr } from './hr-visibility';
import { employmentData } from './teacher-employments.service';

/**
 * Löne-id on the post (TeacherEmployments.payrollNumber, 20270206090000): the
 * payroll system's own number for the anställning, which the löneunderlag's
 * Löne-id column carries.
 *
 * What this guards: the DTO says the table's CHECK in Swedish (1..30
 * characters, trimmed, no control character) and makes a blank value null;
 * a PUT that leaves the field out keeps what the post holds, as SCB's three
 * do, so a web from before the field does not clear it; and a reader without
 * HR-läs is handed it as null.
 */

const dto = (payrollNumber: unknown) => plainToInstance(UpsertTeacherEmploymentDto, { employmentPercent: 80, payrollNumber });
const refused = async (payrollNumber: unknown) => (await validate(dto(payrollNumber))).map((error) => error.property);

describe('Löne-id on the post', () => {
  describe('the DTO', () => {
    it('trims, and makes a blank value no value', async () => {
      expect(dto('  4711-01 ').payrollNumber).toBe('4711-01');
      expect(dto('').payrollNumber).toBeNull();
      expect(dto('   ').payrollNumber).toBeNull();
      expect(await refused('   ')).toEqual([]);
      expect(dto(undefined).payrollNumber).toBeUndefined();
    });

    it('holds the table CHECK: 1..30 characters and no control character', async () => {
      expect(await refused('x'.repeat(PAYROLL_NUMBER_MAX))).toEqual([]);
      expect(await refused('x'.repeat(PAYROLL_NUMBER_MAX + 1))).toEqual(['payrollNumber']);
      expect(await refused('47\n11')).toEqual(['payrollNumber']);
      expect(await refused('47\t11')).toEqual(['payrollNumber']);
      expect(await refused(4711)).toEqual(['payrollNumber']);
      expect(await refused(null)).toEqual([]);
      expect(PAYROLL_NUMBER_MAX).toBe(30);
    });

    it('words a refusal in Swedish', async () => {
      const [error] = await validate(dto('x'.repeat(31)));
      expect(Object.values(error!.constraints ?? {})).toEqual(['Löne-id kan vara högst 30 tecken.']);
    });
  });

  describe('the write', () => {
    it('keeps what the post holds when the field is absent, writes it when sent, and clears it on null', () => {
      expect(employmentData({ employmentPercent: 80 })).not.toHaveProperty('payrollNumber');
      expect(employmentData({ employmentPercent: 80, payrollNumber: '4711' })).toMatchObject({ payrollNumber: '4711' });
      expect(employmentData({ employmentPercent: 80, payrollNumber: null })).toMatchObject({ payrollNumber: null });
      // A caller that went around the DTO still writes no blank.
      expect(employmentData({ employmentPercent: 80, payrollNumber: '  ' })).toMatchObject({ payrollNumber: null });
    });
  });

  describe('a reader without HR-läs', () => {
    it('is handed the number as null, beside the hidden percentages', () => {
      expect(EMPLOYMENT_HR_FIELDS).toContain('payrollNumber');
      const hidden = hideHr({ userId: 'u', employmentPercent: 80, reductionPercent: 0, payrollNumber: '4711' }) as Record<string, unknown>;
      expect(hidden).toMatchObject({ payrollNumber: null, hrHidden: true });
    });
  });
});
