import type { ScopeVersion } from '../staffing/assignment-scope';
import type { LoadRead } from '../staffing/load-input';
import { DEFAULT_CHECK_POLICY } from '../staffing/staffing-checks';
import type { EnforcedPolicy } from '../staffing/staffing-enforcement';
import type { LoadInput, LoadScopeAssessment } from '../staffing/teacher-load';
import { basisOf, type StaffingState } from './staffing-proposal.service';

/** What sha256 was handed, by the digest the service makes: the real hash is still computed, the text is kept on the side. */
const seenBySha256 = (): string[] => ((globalThis as { __basisSeen?: string[] }).__basisSeen ??= []);
jest.mock('node:crypto', () => {
  const actual = jest.requireActual<typeof import('node:crypto')>('node:crypto');
  return {
    ...actual,
    createHash: (algorithm: string) => {
      const hash = actual.createHash(algorithm);
      const update = hash.update.bind(hash);
      hash.update = ((data: string) => {
        ((globalThis as { __basisSeen?: string[] }).__basisSeen ??= []).push(String(data));
        return update(data);
      }) as typeof hash.update;
      return hash;
    },
  };
});

/*
 * What the proposal's basis is made of when the rektor has registered exceptions under 11 § (R1, del G2). The basis is a digest, so the
 * claim "a school that registers none has the digest it would have had" cannot be read off two digests computed by the same code: both
 * would carry a new empty member and be equal to each other. It is read here off what the digest is made of, which is the canonical
 * JSON handed to sha256: no `excepted` member at all unless somebody holds an exception, and then who, sorted.
 */
const ANNA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BO = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const VERSION: ScopeVersion = {
  code: 'SFS2026:1487', sfs: 'SFS 2026:1487', title: 'Förordning', validFrom: '2020-01-01', validTo: null, source: 'https://example.invalid/sfs',
  bands: [{ schoolForm: 'GRUNDSKOLA', gradeNumbering: 'NIOARIG', gradeFrom: 7, gradeTo: 9, teachingHoursLow: 500, teachingHoursHigh: 600, planningFloorPercent: 110, teachingSection: '3 § p. 2', planningSection: '4 §', note: null }],
};

const assessment = (exceptionKind: LoadScopeAssessment['exceptionKind'], levelHours: number | null = null): LoadScopeAssessment => ({
  levelHours, exceptionKind, ownInitiativeOn: exceptionKind === 'OWN_INITIATIVE' ? '2026-05-02' : null, note: null, decidedAt: '2026-03-05T08:00:00.000Z',
});

const state = (mode: 'WARN' | 'REFUSE', assessments?: [string, LoadScopeAssessment][]): StaffingState => {
  const input = {
    year: { startDate: '2026-08-17', endDate: '2027-06-11' },
    policy: { fullTimeTeachingMinutesPerWeek: 1000, overAllocationTolerancePercent: 10, fullTimeRegulatedHoursPerYear: 1360, workDaysPerYear: 194, qualificationMode: 'OFF' },
    employments: [], requirements: [], qualifications: [], closures: [], duties: [],
    ...(assessments ? { scopeAssessments: new Map(assessments) } : {}),
  } as unknown as LoadInput;
  return {
    schoolId: 'school',
    read: { input } as unknown as LoadRead,
    policy: { ...DEFAULT_CHECK_POLICY, qualificationMode: 'OFF', overAllocationMode: 'WARN', assignmentScopeMode: mode, overAllocationTolerancePercent: 10, fullTimeTeachingMinutesPerWeek: 1000, unstaffedGeneration: 'ALLOW', showsPeriods: true } as EnforcedPolicy,
    staffIds: [ANNA, BO], candidateIds: [ANNA, BO], lastYear: new Map(), released: new Set(), scopeVersions: [VERSION],
  };
};

describe('basisOf and the exceptions of 11 §', () => {
  /** The canonical JSON the digest was made of: what the state handed to sha256. */
  const canonicalOf = (s: StaffingState): Record<string, unknown> => {
    seenBySha256().length = 0;
    basisOf(s);
    return JSON.parse(seenBySha256()[0]!) as Record<string, unknown>;
  };

  it('has no `excepted` member where nobody holds an exception: not for a school that registers none, not for a level alone', () => {
    expect(canonicalOf(state('REFUSE'))).not.toHaveProperty('excepted');
    expect(canonicalOf(state('REFUSE', []))).not.toHaveProperty('excepted');
    expect(canonicalOf(state('REFUSE', [[ANNA, assessment(null, 500)]]))).not.toHaveProperty('excepted');
    // ... and its lydelse member is the one it was, so the digest is the one the school had before the exceptions existed.
    expect(canonicalOf(state('REFUSE', []))).toHaveProperty('scope');
  });

  it('names who holds one, sorted, under REFUSE, and is silent under WARN', () => {
    const held: [string, LoadScopeAssessment][] = [[BO, assessment('SMALL_GROUP')], [ANNA, assessment('OWN_INITIATIVE')]];
    expect(canonicalOf(state('REFUSE', held))).toHaveProperty('excepted', [ANNA, BO]);
    expect(canonicalOf(state('WARN', held))).not.toHaveProperty('excepted');
  });
});
