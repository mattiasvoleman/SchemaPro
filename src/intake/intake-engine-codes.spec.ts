import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The engine refusals Vad kom in says stop Generera are refusals the engine raises.
 *
 * A gap is HARD "only where the code stops the run", and the proof the page, the code and DEPLOYMENT §36 cite is the engine's own refusal by
 * name. messages.py also holds the labels of an infeasibility CORE (ROOM_NO_ROOM_OF_TYPE_FOR_REQUIREMENT is one): a sentence the engine says
 * about a week it has searched, never a refusal before the search. Citing one of those names a stop that is not there, and a reader who
 * looks it up finds the real cause (ROOM_NONE_ELIGIBLE_FOR_REQUIREMENT) under another name. This holds every engine code (INPUT_*, ROOM_*) the
 * gateway's files and §36 name to a code `scheduler_solver.py` raises as an InvalidScheduleInputError.
 */
const ROOT = join(__dirname, '..', '..');
const read = (...path: string[]): string => readFileSync(join(ROOT, ...path), 'utf8');

const solver = read('optimization-engine', 'app', 'solver', 'scheduler_solver.py');
const raised = new Set([...solver.matchAll(/InvalidScheduleInputError\.of\(\s*"([A-Z_]+)"/g)].map((match) => match[1]!));
// The engine's own names (INPUT_*, ROOM_NONE_*, ROOM_NO_*, ROOM_LOCK_*); not the gateway's gap codes, such as ROOM_TYPE_WITHOUT_ROOM.
const codesIn = (text: string): string[] => [...new Set([...text.matchAll(/\b(?:INPUT_[A-Z_]{4,}|ROOM_(?:NONE|NO|LOCK)_[A-Z_]+)\b/g)].map((match) => match[0]))];

const deployment = read('docs', 'DEPLOYMENT.md');
const start = deployment.indexOf('## 36. What the school');
const end = deployment.indexOf('\n## ', start + 10);
const section36 = deployment.slice(start, end === -1 ? undefined : end);

describe('the engine codes Vad kom in names', () => {
  it('reads the refusals the engine raises (a parse that finds none would pass everything below)', () => {
    expect(raised.size).toBeGreaterThan(30);
    expect(raised.has('INPUT_NO_REQUIREMENTS')).toBe(true);
    expect(raised.has('INPUT_NO_ROOMS')).toBe(true);
  });

  it.each([
    ['src/intake/intake.ts', read('src', 'intake', 'intake.ts')],
    ['src/intake/intake.service.ts', read('src', 'intake', 'intake.service.ts')],
    ['docs/DEPLOYMENT.md §36', section36],
  ])('are, in %s, each one the engine raises as a refusal before the search', (_file, text) => {
    expect(codesIn(text).filter((code) => !raised.has(code))).toEqual([]);
  });

  it('are named: the header of intake.ts and §36 each say which refusals make a gap hard', () => {
    expect(codesIn(read('src', 'intake', 'intake.ts'))).toEqual(expect.arrayContaining(['INPUT_NO_REQUIREMENTS', 'INPUT_NO_ROOMS', 'ROOM_NONE_ELIGIBLE_FOR_REQUIREMENT']));
    expect(codesIn(section36)).toEqual(expect.arrayContaining(['INPUT_NO_REQUIREMENTS', 'INPUT_NO_ROOMS', 'ROOM_NONE_ELIGIBLE_FOR_REQUIREMENT']));
  });
});
