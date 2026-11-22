import { SUGGESTION_PROOFS, SUGGESTION_RULES, SUGGEST_VERDICTS, type AiEngineSuggestChangesResponse } from './interfaces/suggest-changes.interface';

/**
 * Åtgärdsförslag vid vägran's wire contract, pinned from the gateway's side.
 *
 * The engine's models (optimization-engine/app/schemas/suggestions.py) forbid extra fields, and its request IS Generera's: a name changed on
 * one side only is a missing key here. The mirror of these lists is tests/test_suggest_changes.py (RESPONSE_KEYS, CHANGE_KEYS and the OpenAPI
 * enums); either half failing means the two sides have parted company. Fix the code, not the list, and change both halves in the commit that
 * deploys the engine.
 */
const RESPONSE_FIELDS = ['changes', 'conflicts', 'elapsedMs', 'requestId', 'searchSeconds', 'verdict', 'verified', 'verifySeconds'];
const CHANGE_FIELDS = ['cost', 'current', 'needed', 'proof', 'requirementIds', 'resourceIds', 'roomIds', 'rule', 'weekdays'];

describe('Åtgärdsförslag vid vägran: the wire contract', () => {
  it('names the engine\'s five rules, mildest first, as relaxation.RELAXABLE_RULES does', () => {
    expect(SUGGESTION_RULES).toEqual(['SUBJECT_DAYS_APART', 'SUBJECT_PER_DAY', 'ROOM_LOCK', 'TEACHER_DAILY_CAP', 'TEACHER_WORK_DAYS']);
  });

  it('names the three proofs the engine gives and the four verdicts', () => {
    expect(SUGGESTION_PROOFS).toEqual(['SOLVED', 'SOLVED_TOGETHER', 'MAY_HELP']);
    expect(SUGGEST_VERDICTS).toEqual(['CHANGES', 'SOLVABLE_AS_IS', 'NOT_FOUND', 'HARD_REFUSAL']);
  });

  it('types every field the engine declares: one added to the interface fails to compile here', () => {
    const reply: Required<AiEngineSuggestChangesResponse> = {
      requestId: '55555555-5555-4555-8555-555555555555',
      verdict: 'CHANGES',
      changes: [{
        rule: 'TEACHER_DAILY_CAP', cost: 168, current: 300, needed: 330, weekdays: [3], requirementIds: [], roomIds: [], resourceIds: [], proof: 'SOLVED',
      }],
      verified: true,
      searchSeconds: 60,
      verifySeconds: 2.5,
      elapsedMs: 70_000,
      conflicts: null,
    };
    expect(Object.keys(reply).sort()).toEqual(RESPONSE_FIELDS);
    expect(Object.keys(reply.changes[0]!).sort()).toEqual(CHANGE_FIELDS);
  });
});
