import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SuggestionChange as WebChange, Suggestions as WebSuggestions } from '../../web/lib/suggestion-types';
import { SUGGESTION_PROOFS, SUGGESTION_RULES, SUGGEST_VERDICTS, type AiEngineSuggestChangesResponse } from './interfaces/suggest-changes.interface';
import { SUGGESTION_FAILURES, SUGGESTION_STATES, type SuggestionChangeView, type SuggestionsView } from './suggestions';

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

/*
 * THE PAGE'S COPY OF THE VIEW (the review of #388, L-5e). web/lib/suggestion-types.ts says by hand what the gateway sends, because the
 * web package cannot import from the gateway's. Nothing bound the two: a field renamed on one side was a card that read `undefined`.
 * Held here from the gateway's side, in two ways that fail in different places:
 *
 *  - jest (this file at run time) reads both files as text, as year-periods.spec.ts reads the engine's MAX_PERIODS, and compares the
 *    names of the fields of each shape and the members of each closed set. A rename on either side fails it;
 *  - tsc (`npm run typecheck:test`) holds the two types mutually assignable, so a type that changes on one side only does not compile.
 */
type Assignable<From, To> = [From] extends [To] ? true : false;
// Both ways: a field only one side has (or types differently) makes one of the four false, and the tuple below does not compile.
const typesAgree: [
  Assignable<WebChange, SuggestionChangeView>,
  Assignable<SuggestionChangeView, WebChange>,
  Assignable<WebSuggestions, SuggestionsView>,
  Assignable<SuggestionsView, WebSuggestions>,
] = [true, true, true, true];

describe('Åtgärdsförslag vid vägran: the page\'s copy of the view', () => {
  const ROOT = join(__dirname, '..', '..');
  const web = readFileSync(join(ROOT, 'web/lib/suggestion-types.ts'), 'utf8');
  const gateway = readFileSync(join(ROOT, 'src/optimization/suggestions.ts'), 'utf8');

  /** The body of `export interface <name> { … }`, which these files close at a `}` in the first column. */
  const bodyOf = (text: string, name: string): string => {
    const found = new RegExp(`export interface ${name} \\{\\n([\\s\\S]*?)\\n\\}`).exec(text);
    expect(found).not.toBeNull();
    return found![1]!;
  };
  /** The properties of an interface body, in order: a line of two spaces and a name, with or without `?`. */
  const fieldsOf = (body: string): string[] => [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((match) => match[1]!);
  /** The members of `export type <name> = "A" | "B" …;`, in order. */
  const membersOf = (text: string, name: string): string[] => {
    const found = new RegExp(`export type ${name} = ([^;]+);`).exec(text);
    expect(found).not.toBeNull();
    return [...found![1]!.matchAll(/["']([A-Z_]+)["']/g)].map((member) => member[1]!);
  };

  it('compiles with the types mutually assignable (tsc holds it, jest runs it)', () => {
    expect(typesAgree).toEqual([true, true, true, true]);
  });

  it('has the fields of a stored change, but for the Users ids, which arrive as names', () => {
    const stored = fieldsOf(bodyOf(gateway, 'StoredChange'));
    expect(stored.length).toBeGreaterThan(10);
    expect(fieldsOf(bodyOf(web, 'SuggestionChange'))).toEqual(stored.map((field) => (field === 'teacherIds' ? 'teacherNames' : field)));
  });

  it('has the fields of the stored analysis', () => {
    const stored = fieldsOf(bodyOf(gateway, 'SuggestionsStored'));
    expect(stored.length).toBeGreaterThan(8);
    expect(fieldsOf(bodyOf(web, 'Suggestions'))).toEqual(stored);
  });

  it('has the closed sets the gateway has, in the same order', () => {
    expect(membersOf(web, 'SuggestionRule')).toEqual([...SUGGESTION_RULES]);
    expect(membersOf(web, 'SuggestionProof')).toEqual([...SUGGESTION_PROOFS]);
    expect(membersOf(web, 'SuggestionVerdict')).toEqual([...SUGGEST_VERDICTS]);
    expect(membersOf(web, 'SuggestionsFailure')).toEqual([...SUGGESTION_FAILURES]);
    // The state is an inline union on the interface's `state` field.
    const state = /state: ([^;]+);/.exec(bodyOf(web, 'Suggestions'));
    expect([...state![1]!.matchAll(/"([A-Z_]+)"/g)].map((member) => member[1])).toEqual([...SUGGESTION_STATES]);
  });
});
