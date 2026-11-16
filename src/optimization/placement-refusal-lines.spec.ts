import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigService } from '@nestjs/config';
import type { HttpService } from '@nestjs/axios';
import type { PrismaService } from '../prisma/prisma.service';
import type { AiEngineConflictAnalysis, AiEngineConflictDetail } from './interfaces/ai-engine-payload.interface';
import { OptimizationProxyService, type AnonMaps } from './optimization-proxy.service';
import { placedLessonRowsOf, placementsRefusalOf, type PlacedPost, type PlacementRead } from './placed-lessons';
import { conflictView, storedOf } from './stored-conflicts';

/*
 * THE REFUSAL LINES THE WEB DRAWS A LINK FROM (grafisk förläggning, A3): the contract between the gateway and Generera's page.
 *
 * A line about a förläggning leaves the gateway with the post's own id (`postId`) and, for a block's lesson, the block's
 * (`blockId`) beside the day and the clock it always had, and the page builds /admin/placements?...&post=...&day=...&start=...
 * from them. The lines are here as they are STORED AND SHOWN (storedOf, conflictView), built by the real code from the shapes
 * the two sources produce (the gateway's pre-flight, placementsRefusalOf; the engine's own lines, pins.py Pin.line and
 * scheduler_solver._placed_lesson_line), and compared with the file the web's test reads
 * (__fixtures__/placement-refusal-lines.json). A file that is not what the code makes fails here; PLACEMENT_REFUSAL_WRITE=1
 * writes it again. The web's test (web/lib/placement-link.contract.test.ts) builds a link from every line in it.
 */

const FIXTURE = join(__dirname, '__fixtures__', 'placement-refusal-lines.json');

const POST_ID = '11111111-aaaa-4aaa-8aaa-111111111111';
const BLOCK_POST_ID = '22222222-aaaa-4aaa-8aaa-222222222222';
const BLOCK_ID = '33333333-aaaa-4aaa-8aaa-333333333333';
const ROOM_ID = '44444444-aaaa-4aaa-8aaa-444444444444';

const ANON_POST = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ANON_BLOCK_POST = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa';
const ANON_BLOCK = 'aaaaaaaa-3333-4333-8333-aaaaaaaaaaaa';
const ANON_ROOM = 'aaaaaaaa-4444-4444-8444-aaaaaaaaaaaa';

const at = (clock: string) => new Date(`1970-01-01T${clock}:00.000Z`);
const post = (id: string, blockId: string | null): PlacedPost & { blockId: string | null } => ({
  id,
  subjectId: 'subject',
  studentGroupId: 'group',
  teacherId: 'teacher',
  coTeacherId: null,
  recurrence: 'ALL_WEEKS',
  startDate: null,
  endDate: null,
  blockId,
});
const read = (requirementId: string, over: Partial<PlacementRead> = {}): PlacementRead => ({
  id: `row-${requirementId.slice(0, 2)}`,
  requirementId,
  dayOfWeek: 3,
  startTime: at('10:00'),
  minutes: 60,
  roomId: ROOM_ID,
  recurrence: 'ALL_WEEKS',
  teacherId: null,
  ...over,
});

function service(): OptimizationProxyService {
  const config = { getOrThrow: () => ({ baseUrl: 'http://solver.test', apiKey: 'k'.repeat(32), timeoutMs: 50 }) } as unknown as ConfigService;
  return new OptimizationProxyService({} as PrismaService, {} as HttpService, config);
}

const maps = (): AnonMaps => ({
  requirementAnonMap: new Map([
    [POST_ID, ANON_POST],
    [BLOCK_POST_ID, ANON_BLOCK_POST],
  ]),
  roomAnonMap: new Map([[ROOM_ID, ANON_ROOM]]),
  groupAnonMap: new Map(),
  roomTypeAnonMap: new Map(),
  constraintAnonMap: new Map(),
  workRuleAnonMap: new Map(),
  blockAnonMap: new Map([[BLOCK_ID, ANON_BLOCK]]),
  blockOfPost: new Map([[BLOCK_POST_ID, BLOCK_ID]]),
  nameById: new Map([
    [POST_ID, 'Idrott och hälsa för 7A'],
    [BLOCK_POST_ID, 'Franska för 7B'],
    [ROOM_ID, 'Sporthallen'],
    [BLOCK_ID, 'Språkval'],
  ]),
});

const anonOf = {
  requirement: (id: string) => ({ [POST_ID]: ANON_POST, [BLOCK_POST_ID]: ANON_BLOCK_POST })[id]!,
  room: () => ANON_ROOM,
  block: () => ANON_BLOCK,
};

/** The engine's own line for a pinned or released förläggning, as the engine says it (a JSON body, camelCase). */
const engineLine = (code: string, requirement: string, room: string | null, over: Partial<AiEngineConflictDetail> = {}): AiEngineConflictDetail => ({
  category: 'PLACEMENT',
  code,
  params: { requirement, ...(room === null ? {} : { room }), day: 2, start: '08:30', end: '09:30' },
  message: 'The engine says it in English.',
  requirementIds: [requirement],
  roomIds: room === null || room === '' ? [] : [room],
  constraintIds: [],
  resourceIds: [],
  ...over,
});

function linesOf(): Array<{ name: string; postId: string | null; blockId: string | null; line: ReturnType<typeof conflictView> }> {
  const rows = placedLessonRowsOf([read(POST_ID)], new Map([[POST_ID, post(POST_ID, null)]]));
  const blockRows = placedLessonRowsOf([read(BLOCK_POST_ID, { dayOfWeek: 4, startTime: at('13:15') })], new Map([[BLOCK_POST_ID, post(BLOCK_POST_ID, BLOCK_ID)]])).map(
    (row) => ({ ...row, blockId: BLOCK_ID }),
  );
  const cannotStand = (all: typeof rows, reason: string): AiEngineConflictAnalysis =>
    placementsRefusalOf(all, [{ index: 0, ok: false, reason, params: { className: '8B', subjectName: 'Matematik' } }], anonOf)!;
  const cases: Array<{ name: string; analysis: AiEngineConflictAnalysis; postId: string | null; blockId: string | null }> = [
    { name: 'preflight', analysis: cannotStand(rows, 'TEACHER'), postId: POST_ID, blockId: null },
    { name: 'preflight-block', analysis: cannotStand(blockRows, 'TEACHER'), postId: BLOCK_POST_ID, blockId: BLOCK_ID },
    {
      name: 'preflight-no-room',
      analysis: cannotStand(placedLessonRowsOf([read(POST_ID, { roomId: null })], new Map([[POST_ID, post(POST_ID, null)]])), 'ROOM'),
      postId: POST_ID,
      blockId: null,
    },
    { name: 'engine-room', analysis: wrap([engineLine('PLACED_LESSON_IN_THE_WAY', ANON_POST, ANON_ROOM)]), postId: POST_ID, blockId: null },
    { name: 'engine-any-room', analysis: wrap([engineLine('PLACED_LESSON_IN_THE_WAY_ANY_ROOM', ANON_POST, null)]), postId: POST_ID, blockId: null },
    // The released-week probe's line has the room as "" when the lock had none (scheduler_solver._placed_lesson_line).
    { name: 'probe', analysis: wrap([engineLine('PLACED_LESSON_IN_THE_WAY', ANON_POST, '')]), postId: POST_ID, blockId: null },
    { name: 'engine-block-member', analysis: wrap([engineLine('PLACED_LESSON_IN_THE_WAY_ANY_ROOM', ANON_BLOCK_POST, null)]), postId: BLOCK_POST_ID, blockId: BLOCK_ID },
    // What no link is drawn from: a cause the engine raised for the week (no post), and a line of another category.
    { name: 'cause-without-post', analysis: wrap([engineLine('LUNCH_LOCKED_LESSONS_LEAVE_NO_BREAK', ANON_POST, null, { requirementIds: [], params: { day: 2, start: '12:00', minutes: 30 } })]), postId: null, blockId: null },
    { name: 'other-category', analysis: wrap([engineLine('ROOM_CAPACITY_TOO_SMALL', ANON_POST, null, { category: 'ROOM' })]), postId: null, blockId: null },
  ];
  const sut = service() as unknown as { realiseConflicts: (a: AiEngineConflictAnalysis, m: AnonMaps) => AiEngineConflictAnalysis };
  return cases.map(({ name, analysis, postId, blockId }) => {
    const realised = sut.realiseConflicts(analysis, maps())!;
    return { name, postId, blockId, line: conflictView(storedOf(realised.conflicts[0]!)) };
  });
}

function wrap(conflicts: AiEngineConflictDetail[]): AiEngineConflictAnalysis {
  return { summary: 's', summaryCode: 'PLACEMENTS_PROBE_SUMMARY', summaryParams: {}, conflicts };
}

describe('the refusal lines a link back to the week is built from', () => {
  const made = linesOf();

  if (process.env['PLACEMENT_REFUSAL_WRITE'] === '1') {
    it('writes the fixture', () => {
      writeFileSync(FIXTURE, `${JSON.stringify({ lines: made }, null, 2)}\n`);
    });
  }

  it('is the file the web reads: a fixture that is not what the code makes is old (PLACEMENT_REFUSAL_WRITE=1 writes it again)', () => {
    const stored = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { lines: unknown };
    expect(stored).toEqual(JSON.parse(JSON.stringify({ lines: made })));
  });

  it('says the post (and the block) on every line of the category, as the real ids the case was built from', () => {
    for (const { name, postId, blockId, line } of made) {
      expect({ name, postId: line.params?.['postId'] ?? null, blockId: line.params?.['blockId'] ?? null }).toEqual({ name, postId, blockId });
    }
  });

  it('keeps the values a sentence reads where they were: the day and the clock are the row\'s, the names are the school\'s', () => {
    const byName = new Map(made.map((entry) => [entry.name, entry.line]));
    expect(byName.get('preflight')!.params).toMatchObject({ requirement: 'Idrott och hälsa för 7A', room: 'Sporthallen', day: 3, start: '10:00', end: '11:00', block: 'NO_BLOCK' });
    expect(byName.get('preflight-block')!.params).toMatchObject({ requirement: 'Franska för 7B', block: 'Språkval', day: 4, start: '13:15' });
    expect(byName.get('engine-room')!.params).toMatchObject({ requirement: 'Idrott och hälsa för 7A', room: 'Sporthallen', day: 2, start: '08:30' });
  });

  it('gives a day and a start that are the page\'s to read: an ISO weekday as a number, and HH:MM', () => {
    for (const { name, postId, line } of made) {
      if (postId === null) continue;
      expect({ name, day: typeof line.params?.['day'], start: /^\d\d:\d\d$/.test(String(line.params?.['start'])) }).toEqual({ name, day: 'number', start: true });
    }
  });
});
