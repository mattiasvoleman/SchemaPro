import {
  ASSIGNMENT_ROLE_PROPERTIES,
  ASSIGNMENT_ROLE_TYPES,
  DUTY_PROPERTIES,
  DUTY_ROLES,
  META_PROPERTIES,
  REFERENCE_PROPERTIES,
  toSs12000Duty,
} from './ss12000-duties';

/**
 * The /duties feed emits SS12000 2.1.0 Duty objects and NOTHING the standard
 * does not define. The allowlists in ss12000-duties.ts are the property names
 * of components.schemas.Duty, Meta, the ObjectReference family and
 * Duty_assignmentRole_inner as the 2.1.0 YAML states them (SIS TK450,
 * openapi_ss12000_version2_1_0.yaml, info.version 2.1.0, retrieved
 * 2026-10-09); the enums are Code_DutyRole and Code_AssignmentRole. This spec
 * walks every object the mapper can produce — switch on and off, ferie and
 * semester, with and without a signature and mentorships — and fails on any
 * key outside them, at any depth.
 */

const ALLOWED: Record<string, readonly string[]> = {
  duty: DUTY_PROPERTIES,
  meta: META_PROPERTIES,
  person: REFERENCE_PROPERTIES,
  dutyAt: REFERENCE_PROPERTIES,
  assignmentRole: ASSIGNMENT_ROLE_PROPERTIES,
  group: REFERENCE_PROPERTIES,
};

function walk(value: unknown, kind: string, path: string, out: string[]): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, kind, `${path}[${index}]`, out));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (!ALLOWED[kind]!.includes(key)) out.push(`${path}.${key}`);
    if (key in ALLOWED) walk(child, key, `${path}.${key}`, out);
  }
}

const variants = [false, true].flatMap((share) =>
  (['FERIE', 'SEMESTER'] as const).flatMap((contractKind) =>
    [null, 'ANN'].flatMap((signature) =>
      [[], [{ studentGroupId: 'g-7b', updatedAt: new Date('2026-09-15T00:00:00Z') }]].map((mentorships) =>
        toSs12000Duty({
          schoolId: 'school',
          year: { startDate: '2026-08-17', endDate: '2027-06-11' },
          share,
          fullTimeAnnualHours: 1767,
          employment: {
            id: 'emp',
            userId: 'user',
            employmentPercent: 80,
            signature,
            createdAt: new Date('2026-08-01T00:00:00Z'),
            updatedAt: new Date('2026-09-01T00:00:00Z'),
            ...(share ? { contractKind } : {}),
          },
          mentorships,
        }),
      ),
    ),
  ),
);

describe('the /duties feed emits only what SS12000 2.1.0 defines', () => {
  it('has variants covering every optional field, present and absent', () => {
    expect(variants).toHaveLength(16);
    for (const field of ['assignmentRole', 'signature', 'dutyPercent', 'hoursPerYear']) {
      expect(variants.some((duty) => field in duty)).toBe(true);
      expect(variants.some((duty) => !(field in duty))).toBe(true);
    }
  });

  it.each(variants.map((duty, index) => [index, duty] as const))('variant %i: every key, at every depth, is a 2.1.0 property', (_index, duty) => {
    const extra: string[] = [];
    walk(duty, 'duty', 'Duty', extra);
    expect(extra).toEqual([]);
  });

  it.each(variants.map((duty, index) => [index, duty] as const))('variant %i: the required fields are there, the codes are enum members', (_index, duty) => {
    for (const field of ['dutyAt', 'dutyRole', 'id', 'meta', 'startDate']) expect(duty).toHaveProperty(field);
    expect(Object.keys(duty.meta).sort()).toEqual(['created', 'modified']);
    expect(DUTY_ROLES).toContain(duty.dutyRole);
    for (const role of duty.assignmentRole ?? []) {
      expect(ASSIGNMENT_ROLE_TYPES).toContain(role.assignmentRoleType);
      expect(role).toHaveProperty('group.id');
    }
    if ('dutyPercent' in duty) expect(Number.isInteger(duty.dutyPercent)).toBe(true);
    if ('hoursPerYear' in duty) expect(Number.isInteger(duty.hoursPerYear)).toBe(true);
  });

  it('names exactly the 2.1.0 Duty properties, the required five among them', () => {
    expect([...DUTY_PROPERTIES].sort()).toEqual(
      ['assignmentRole', 'description', 'dutyAt', 'dutyPercent', 'dutyRole', 'endDate', 'hoursPerYear', 'id', 'meta', 'person', 'signature', 'startDate'],
    );
  });
});
