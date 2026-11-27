/**
 * Möjliga tider (E3): THE QUERY AGAINST THE JUDGE, over every start of the week, against a real database, as the API role under RLS,
 * through the real services.
 *
 *   DATABASE_URL='postgresql://app_authenticated:app_authenticated_local@localhost:5432/schemapro?schema=public&connection_limit=4' \
 *   PROBE_OWNER_URL='postgresql://postgres:postgres_local@localhost:5432/schemapro' \
 *   npx ts-node --transpile-only scripts/test/probe-mojliga-tider.ts
 *
 * POST /master-lessons/possible-times says, for every start of the week, where a lesson can stand, which stretches a rule shuts and
 * which lesson holds the rest. The judge (src/calendar/lesson-judge.ts, the function POST /judge and every write ask) has the last word
 * on a time, so the query may only ever be a prune in front of it: it must never call free a time the judge refuses, and the prune must
 * never lose a time the judge lets through. This asks both of the same starts over the worlds of E1's fall file
 * (src/calendar/__fixtures__/lesson-judge-cases.json: small schools with frames, meals, weekly closures, halves and alternating weeks),
 * every lesson of each, every fifteenth minute of the week, and requires them to agree:
 *
 *   (mt-a) a start the judge lets through is FREE, in the lesson's own room, and a start the query calls FREE or CHANGE the judge lets
 *          through (CHANGE: in the room the query offered);
 *   (mt-b) a start the query calls CLOSED is refused by the judge for that very rule (FRAME, LUNCH, GRADE_RULE, AVAILABILITY of the
 *          resource it names), and one it calls IN_THE_WAY or CROWDED is refused for a clash; the lesson it names holds the stretch by
 *          the judge's own words (class, subject, day, clock);
 *   (mt-c) the best is the best: the first option's score is the lowest of every start the judge lets through, costed by the swap
 *          search's own measure, and the options are in that order;
 *   (mt-d) the cases are not vacuous: every answer and every rule is given somewhere, and a good many starts are free;
 *   (mt-f) "vad kan ligga här?": at each of several starts, every lesson of the world and a brick for each class and teacher are asked
 *          at once, and the ones that fit are exactly the ones the judge lets through (a lesson that fits in another room is let through
 *          by the judge in that room);
 *   (mt-g) the room chooser: for every room, at several starts, a room it calls free is one the judge's room rule leaves alone, one it
 *          calls busy is refused for the room by the lesson it names, and one it calls shut is refused by a weekly row on the room;
 *   (mt-e) the same over a högstadium laid by scripts/fixtures/hogstadium-week.ts, which the small worlds are not: parallel blocks whose
 *          lessons move as one, halves and teaching groups that share pupils, the pupils' ombyte and dusch. The judge here is the public
 *          one, POST /judge, asked of the whole unit as the card's move, so that the query's own call into the judge is not the only
 *          witness. Prints how long an answer takes, with the load beside it.
 *
 * It works in schools of its own (slug `probe-mojliga-tider-<n>`) and drops them.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { ConflictReads } from '../../src/calendar/conflict-reads';
import { judgeLessons, type JudgeItem } from '../../src/calendar/lesson-judge';
import { MasterLessonsService } from '../../src/calendar/master-lessons.service';
import { costOf, type PossibleWorld } from '../../src/calendar/possible-times';
import { PossibleTimesService } from '../../src/calendar/possible-times.service';
import { WhatFitsService } from '../../src/calendar/what-fits.service';
import { PrismaService } from '../../src/database/prisma.service';
import { SwapContext } from '../../src/swaps/swap-context';
import { readSwapData } from '../../src/swaps/swap-snapshot';
import { Role } from '../../src/auth/enums/role.enum';
import type { AuthenticatedUser } from '../../src/auth/interfaces/authenticated-user.interface';
import { CURRENT } from '../../src/year-rollover/projected-rosters';
import { seedHogstadium } from '../fixtures/hogstadium-week';
import { plant, type World } from './probe-domaren';

const SLUG = 'probe-mojliga-tider';
const FIXTURE = join(__dirname, '../../src/calendar/__fixtures__/lesson-judge-cases.json');
const STEP = 15;
/** The probe's own transactions may run as long as the judge is allowed to (possible.judgeBudgetMs below): a loaded host must not decide the answer. */
const PROBE_TX = { timeoutMs: 10 * 60_000 };

const minutesOf = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));
const clockOf = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const dateOf = (day: string | null | undefined): Date | null => (day ? new Date(`${day}T00:00:00.000Z`) : null);

export async function mojligaTiderChecks(owner: Client, api: PrismaService, check: (label: string, body: () => Promise<void>) => Promise<void>): Promise<void> {
  const worlds = (JSON.parse(readFileSync(FIXTURE, 'utf8')) as { worlds: World[] }).worlds;
  // MOJLIGA_FROM and MOJLIGA_WORLDS take a stretch of the file's worlds (the first to the one before the last), so that the richer worlds can be asked
  // in two processes on a loaded host; the thresholds below are for the whole file.
  const from = Number(process.env['MOJLIGA_FROM'] ?? 0);
  const wanted = Number(process.env['MOJLIGA_WORLDS'] ?? worlds.length);

  const realtime = { notifyMasterTimetableChanged: () => undefined };
  const notifications = { recipientsForLessons: async () => [], notifyUsers: async () => undefined };
  const masters = new MasterLessonsService(api, realtime as never, notifications as never);
  const possible = new PossibleTimesService(api, masters);
  const fitting = new WhatFitsService(api, possible);
  // What is asked here is whether the answer is right, not how fast it is: the judge gets all the time it needs on a loaded host.
  possible.judgeBudgetMs = 10 * 60_000;

  const seen = { free: 0, change: 0, closed: new Map<string, number>(), inTheWay: 0, crowded: 0, stands: 0, judgedOk: 0, lessons: 0, worlds: 0, refusedByJudge: 0 };

  try {
    await check(`(mt-a/b/c) the query against the judge, every ${STEP}th minute of the week, every lesson of the first ${wanted} worlds of the fall file`, async () => {
      for (const [offset, world] of worlds.slice(from, wanted).entries()) {
        const index = from + offset;
        const planted = await plant(owner, `${SLUG}-${index}`, world);
        const { caller } = planted;
        seen.worlds += 1;
        for (const lesson of world.lessons) {
          const lessonId = planted.lessonId.get(lesson.key)!;
          const standing = planted.slot.get(lesson.key)!;
          const minutes = minutesOf(standing.end) - minutesOf(standing.start);
          const label = `world ${index}, ${lesson.key}`;
          seen.lessons += 1;

          const answer = await possible.possibleTimes({ lessonId, from: '07:00', to: '18:00', stepMinutes: STEP, limit: 40 }, caller);
          assert.equal(answer.stats.truncated, false, `${label}: the judge ran out of time`);
          // A pupil NAMED on a lesson is a clash the prune cannot see (swap-context.ts inTheWay reads groups, as the engine's own prune does): the
          // judge pass refuses the start and it is painted CROWDED by no one. In a world with none the prune is exact, and the judge refuses nothing it passed.
          const namedPupils = world.lessons.some((entry) => (entry.participants ?? []).length > 0);
          if (!namedPupils) assert.equal(answer.stats.refused, 0, `${label}: the prune let ${answer.stats.refused} start(s) through that the judge refused`);

          // What the judge says of every start, in the lesson's own room, as the PATCH would hold it.
          const startsOfDay = (): Array<{ day: number; start: number }> =>
            [1, 2, 3, 4, 5].flatMap((day) => {
              const out: Array<{ day: number; start: number }> = [];
              for (let start = 7 * 60; start + minutes <= 18 * 60; start += STEP) out.push({ day, start });
              return out;
            });
          const verdicts = await api.withRls(caller, async (tx) => {
            const data = await readSwapData(tx, caller, planted.year);
            const own = data.lessons.find((entry) => entry.id === lessonId)!;
            const items: JudgeItem[] = startsOfDay().map(({ day, start }) => ({
              lesson: { id: lessonId, studentGroupId: own.studentGroupId, subjectId: own.subjectId },
              candidate: {
                dayOfWeek: day,
                startMinutes: start,
                endMinutes: start + minutes,
                teacherId: own.teacherId,
                coTeacherId: own.coTeacherId,
                roomId: own.roomId,
                extraGroupIds: own.extraGroupIds,
                studentIds: own.studentIds,
                recurrence: own.recurrence,
                // The lesson's window of dates (the richer worlds of the fall file have lessons that run in one).
                startDate: dateOf(own.startDate),
                endDate: dateOf(own.endDate),
              },
              stands: { dayOfWeek: own.dayOfWeek, startMinutes: own.startMinutes, endMinutes: own.endMinutes, teacherId: own.teacherId, coTeacherId: own.coTeacherId, roomId: own.roomId, extraGroupIds: own.extraGroupIds, recurrence: own.recurrence, startDate: dateOf(own.startDate), endDate: dateOf(own.endDate) },
              excludeIds: [lessonId],
            }));
            const judged = await judgeLessons(tx, masters, { academicYearId: planted.year, schoolId: planted.school, basis: CURRENT, gradeNumbering: 'NIOARIG' }, items, { reads: new ConflictReads() });
            return new Map(startsOfDay().map(({ day, start }, at) => [`${day}|${start}`, judged[at]!]));
          }, PROBE_TX);

          const kindAt = (day: number, start: number) => {
            const run = answer.days.find((entry) => entry.dayOfWeek === day)!.runs.find((candidate) => candidate.fromMinutes <= start && start <= candidate.toMinutes);
            assert.ok(run, `${label}: no run holds ${day} ${clockOf(start)}`);
            return run;
          };

          const okStarts: Array<{ day: number; start: number }> = [];
          for (const { day, start } of startsOfDay()) {
            const verdict = verdicts.get(`${day}|${start}`)!;
            const run = kindAt(day, start);
            const where = `${label}, day ${day} ${clockOf(start)}`;
            const reasons = verdict.refusals.map((refusal) => refusal.reason);
            if (run.kind === 'STANDS') {
              seen.stands += 1;
              assert.ok(day === standing.day && start === minutesOf(standing.start), `${where}: STANDS is where the lesson stands`);
              continue;
            }
            if (verdict.ok) {
              seen.judgedOk += 1;
              okStarts.push({ day, start });
              // (mt-a) the prune does not lose it, and it is free in the lesson's own room.
              assert.equal(run.kind, 'FREE', `${where}: the judge lets it through and the query says ${run.kind}${run.code ? ` ${run.code}` : ''}`);
            }
            switch (run.kind) {
              case 'FREE':
                seen.free += 1;
                assert.ok(verdict.ok, `${where}: the query says FREE and the judge says ${reasons.join(',')}`);
                break;
              case 'CHANGE':
                // Another room: the judge is asked below with it. A CHANGE where the own room is fine is a mistake.
                seen.change += 1;
                assert.ok(!verdict.ok, `${where}: the query says CHANGE although the lesson's own room is free`);
                break;
              case 'CLOSED': {
                seen.closed.set(run.code!, (seen.closed.get(run.code!) ?? 0) + 1);
                assert.ok(!verdict.ok, `${where}: the query says CLOSED ${run.code} and the judge lets it through`);
                const wantedReason = run.code;
                assert.ok(reasons.includes(wantedReason!), `${where}: the query says CLOSED ${run.code}, the judge says ${reasons.join(',')}`);
                if (run.code === 'AVAILABILITY') {
                  // The judge's own sentence names the resource. An hour that two rows close (a room's and a class's, in the richer worlds) is
                  // two sentences, and the query names one of them.
                  const resources = verdict.refusals.filter((refusal) => refusal.reason === 'AVAILABILITY').map((refusal) => refusal.params['resource']);
                  assert.ok(resources.includes(run.params!['resource']!), `${where}: what the weekly row closes is ${String(run.params!['resource'])}, the judge says ${resources.join(', ')}`);
                }
                break;
              }
              case 'IN_THE_WAY':
              case 'CROWDED': {
                if (run.kind === 'IN_THE_WAY') seen.inTheWay += 1;
                else seen.crowded += 1;
                assert.ok(!verdict.ok, `${where}: the query says ${run.kind} and the judge lets it through`);
                // CROWDED by no one is the judge's refusal for a pupil named on a lesson, and nothing else.
                if (run.kind === 'CROWDED' && run.units === 0) assert.ok(namedPupils && reasons.some((reason) => reason === 'PUPILS' || reason === 'GROUP'), `${where}: CROWDED by no one, and the judge says ${reasons.join(',')}`);
                assert.ok(reasons.some((reason) => ['TEACHER', 'ROOM', 'GROUP', 'PUPILS', 'AVAILABILITY'].includes(reason)), `${where}: ${run.kind} without a clash: the judge says ${reasons.join(',')}`);
                if (run.kind === 'IN_THE_WAY') {
                  const named = answer.blockers[run.blockerId!]!;
                  assert.ok(named, `${where}: the blocker is not named`);
                  // The judge names the lesson that holds it by class, subject, day and clock: the blocker is one of them.
                  const clashes = verdict.refusals.filter((refusal) => ['TEACHER', 'ROOM', 'GROUP', 'PUPILS'].includes(refusal.reason));
                  assert.ok(
                    clashes.some(
                      (refusal) =>
                        refusal.params['className'] === named.className &&
                        refusal.params['subjectName'] === named.subjectName &&
                        refusal.params['day'] === named.dayOfWeek &&
                        refusal.params['start'] === clockOf(named.startMinutes) &&
                        refusal.params['end'] === clockOf(named.endMinutes),
                    ),
                    `${where}: the judge does not name ${named.className} ${named.subjectName} ${named.dayOfWeek} ${clockOf(named.startMinutes)} (it says ${JSON.stringify(clashes.map((refusal) => refusal.params))})`,
                  );
                }
                break;
              }
            }
          }

          // (mt-c) the best is the best of what the judge lets through, by the swap search's own measure.
          await api.withRls(caller, async (tx) => {
            const data = await readSwapData(tx, caller, planted.year);
            const context = new SwapContext(data);
            const own = context.lessonById.get(lessonId)!;
            const subject = { unit: context.unitOf.get(lessonId)!, lesson: own, unplaced: false };
            const rooms = new Map([[own.id, own.roomId]]);
            const costed = okStarts
              .filter(({ day, start }) => !(day === standing.day && start === minutesOf(standing.start)))
              .map(({ day, start }) => costOf({ context, rooms: [], wishes: [], needsOf: () => null } as PossibleWorld, subject, { dayOfWeek: day, startMinutes: start, rooms, roomChanged: false }))
              .sort((a, b) => a.score - b.score || a.dayOfWeek - b.dayOfWeek || a.startMinutes - b.startMinutes);
            const free = answer.options.filter((option) => !option.roomChanged);
            // The options hold the best `limit` of every free start, own room or not; the own-room ones among them are the best of those.
            const bestOwn = costed.slice(0, free.length);
            assert.deepEqual(
              free.map((option) => [option.dayOfWeek, option.startMinutes]),
              bestOwn.map((entry) => [entry.dayOfWeek, entry.startMinutes]),
              `${label}: the options are not the best of what the judge lets through, in the order of the written cost`,
            );
            const scores = answer.options.map((option) => option.score);
            assert.deepEqual(scores, [...scores].sort((a, b) => a - b), `${label}: the options are not in the order of their score`);
            assert.deepEqual(
              answer.options.map((option) => option.rank),
              answer.options.map((_, at) => at + 1),
              `${label}: the ranks`,
            );
          }, PROBE_TX);
        }
        await owner.query(`DELETE FROM "Schools" WHERE slug IN ($1, $2)`, [`${SLUG}-${index}`, `${SLUG}-${index}-andra`]);
      }
    });

    await check('(mt-d) the worlds are not vacuous: every answer and every rule is given, and many starts are free', async () => {
      // The thresholds are for all of the fall file; a run of a few worlds (MOJLIGA_WORLDS) only says what it saw.
      const all = wanted >= worlds.length && from === 0;
      if (all) {
        assert.ok(seen.free >= 500, `${seen.free} free starts`);
        assert.ok(seen.inTheWay >= 200, `${seen.inTheWay} starts with one lesson in the way`);
        assert.ok(seen.crowded >= 20, `${seen.crowded} crowded starts`);
        for (const code of ['FRAME', 'LUNCH', 'GRADE_RULE', 'AVAILABILITY']) assert.ok((seen.closed.get(code) ?? 0) >= 20, `${code} closes ${seen.closed.get(code) ?? 0} starts`);
        assert.ok(seen.judgedOk >= 500, `${seen.judgedOk} starts the judge lets through`);
      }
      console.log(
        `     ${seen.worlds} worlds, ${seen.lessons} lessons: ${seen.free} free, ${seen.change} with another room, ${seen.inTheWay} with a lesson in the way, ${seen.crowded} crowded, closed ${[...seen.closed].map(([code, count]) => `${code} ${count}`).join(', ')}; the judge let ${seen.judgedOk} through`,
      );
    });

    await check('(mt-f/g) what can lie here, and the room chooser, against the judge', async () => {
      const fitsSeen = { lit: 0, dim: 0, changed: 0, free: 0, busy: 0, shut: 0 };
      for (const [offset, world] of worlds.slice(from, wanted).entries()) {
        const index = from + offset;
        const planted = await plant(owner, `${SLUG}-${index}`, world);
        const { caller } = planted;
        const starts = [
          [1, '08:30'], [2, '09:15'], [3, '10:00'], [3, '13:30'], [4, '11:05'], [5, '08:00'], [5, '14:45'],
        ] as const;
        const classKeys = world.classes.map((entry) => entry.key);
        for (const [day, start] of starts) {
          const startMinutes = minutesOf(start);
          // (mt-f) every lesson of the world, and a brick of each class with each teacher of the world.
          const bricks = classKeys.flatMap((key) => world.teachers.map((teacher) => ({ key, teacher })));
          const answer = await fitting.whatFits(
            {
              academicYearId: planted.year,
              dayOfWeek: day,
              startTime: start,
              candidates: [
                ...world.lessons.map((lesson) => ({ lessonId: planted.lessonId.get(lesson.key)! })),
                ...bricks.map(({ key, teacher }) => ({
                  brick: { academicYearId: planted.year, studentGroupId: planted.classId.get(key)!, subjectId: planted.subjectId.get(world.subjects[0]!)!, minutes: 45, teacherId: planted.teacherId.get(teacher)! },
                })),
              ],
            },
            caller,
          );
          assert.equal(answer.stats.truncated, false);
          // As above: a pupil named on a lesson is a clash the prune cannot see, and the judge pass is what refuses it (answered CROWDED, never lit).
          const namedPupils = world.lessons.some((entry) => (entry.participants ?? []).length > 0);
          if (!namedPupils) assert.equal(answer.stats.refused, 0, `world ${index} ${day} ${start}: the prune let ${answer.stats.refused} lesson(s) through that the judge refused`);
          for (const entry of answer.answers) {
            const label = `world ${index}, day ${day} ${start}, candidate ${entry.index} (${entry.lessonId ?? 'a brick'})`;
            const lesson = entry.lessonId === null ? null : world.lessons.find((candidate) => planted.lessonId.get(candidate.key) === entry.lessonId)!;
            const minutes = entry.minutes;
            let own: { ok: boolean };
            if (lesson) {
              own = await masters.judgeMoves({ moves: [{ lessonId: entry.lessonId!, dayOfWeek: day, startTime: start, endTime: clockOf(startMinutes + minutes) }] }, caller);
            } else {
              const { key, teacher } = bricks[entry.index - world.lessons.length]!;
              own = await api.withRls(caller, async (tx) => {
                const data = await readSwapData(tx, caller, planted.year);
                const [verdict] = await judgeLessons(
                  tx,
                  masters,
                  { academicYearId: planted.year, schoolId: planted.school, basis: CURRENT, gradeNumbering: 'NIOARIG' },
                  [{ lesson: { id: null, studentGroupId: planted.classId.get(key)!, subjectId: planted.subjectId.get(world.subjects[0]!)! }, candidate: { dayOfWeek: day, startMinutes, endMinutes: startMinutes + minutes, teacherId: planted.teacherId.get(teacher)!, roomId: null } }],
                  { reads: new ConflictReads() },
                );
                void data;
                return verdict!;
              }, PROBE_TX);
            }
            if (entry.answer === 'STANDS') continue;
            if (own.ok) assert.equal(entry.answer, 'FREE', `${label}: the judge lets it through and the query says ${entry.answer}`);
            if (entry.answer === 'FREE') {
              assert.ok(own.ok, `${label}: the query says FREE and the judge refuses`);
              fitsSeen.lit += 1;
            } else if (entry.answer === 'CHANGE') {
              fitsSeen.changed += 1;
              assert.ok(!own.ok, `${label}: the query says CHANGE although the own room is free`);
              // In the room it offers, the judge lets it through.
              const roomId = entry.lessons![0]!.roomId;
              const there = await masters.judgeMoves({ moves: [{ lessonId: entry.lessonId!, dayOfWeek: day, startTime: start, endTime: clockOf(startMinutes + minutes), roomId }] }, caller);
              assert.ok(there.ok, `${label}: the judge refuses the room the query offers`);
            } else {
              fitsSeen.dim += 1;
              assert.ok(!own.ok, `${label}: the query says ${entry.answer} and the judge lets it through`);
            }
          }
          assert.deepEqual(
            answer.fits.map((entry) => answer.answers[entry]!.rank),
            answer.fits.map((_, at) => at + 1),
            `world ${index}, day ${day} ${start}: the ranks`,
          );

          // (mt-g) the rooms, for a few lessons at this start.
          for (const lesson of world.lessons.slice(0, 4)) {
            if (lesson.room === undefined) continue;
            const lessonId = planted.lessonId.get(lesson.key)!;
            const minutes = minutesOf(planted.slot.get(lesson.key)!.end) - minutesOf(planted.slot.get(lesson.key)!.start);
            const chosen = await fitting.roomChoices({ lessonId, dayOfWeek: day, startTime: start }, caller);
            for (const room of chosen.rooms) {
              const verdict = await masters.judgeMoves({ moves: [{ lessonId, dayOfWeek: day, startTime: start, endTime: clockOf(startMinutes + minutes), roomId: room.roomId }] }, caller);
              const refusals = verdict.moves[0]!.refusals;
              const roomRefused = refusals.some((refusal) => refusal.reason === 'ROOM' || (refusal.reason === 'AVAILABILITY' && refusal.params['resource'] === 'ROOM'));
              const label = `world ${index}, ${lesson.key} at day ${day} ${start}, room ${room.name}`;
              if (room.state === 'FREE') {
                fitsSeen.free += 1;
                assert.ok(!roomRefused, `${label}: the chooser says free and the judge refuses the room (${refusals.map((refusal) => refusal.reason).join(',')})`);
              } else if (room.state === 'BUSY') {
                fitsSeen.busy += 1;
                const named = refusals.filter((refusal) => refusal.reason === 'ROOM');
                assert.ok(named.length > 0, `${label}: the chooser says busy and the judge does not refuse the room`);
                assert.ok(
                  named.some(
                    (refusal) =>
                      refusal.params['className'] === room.occupant!.className &&
                      refusal.params['subjectName'] === room.occupant!.subjectName &&
                      refusal.params['day'] === room.occupant!.dayOfWeek &&
                      refusal.params['start'] === clockOf(room.occupant!.startMinutes) &&
                      refusal.params['end'] === clockOf(room.occupant!.endMinutes),
                  ) || room.occupants > 1,
                  `${label}: the chooser names ${JSON.stringify(room.occupant)}, the judge ${JSON.stringify(named.map((refusal) => refusal.params))}`,
                );
              } else {
                fitsSeen.shut += 1;
                if (room.closedBy === 'OTHER_SCHOOL') {
                  // A room another school has borrowed (a world's `loans`): the judge names the school.
                  assert.ok(
                    refusals.some((refusal) => refusal.reason === 'OTHER_SCHOOL' && refusal.params['schools'] === room.closedParams['schools']),
                    `${label}: the chooser says another school holds it (${String(room.closedParams['schools'])}) and the judge says ${refusals.map((refusal) => `${refusal.reason}${JSON.stringify(refusal.params)}`).join(',')}`,
                  );
                } else {
                  assert.ok(refusals.some((refusal) => refusal.reason === 'AVAILABILITY' && refusal.params['resource'] === 'ROOM'), `${label}: the chooser says shut and the judge does not say the room is unavailable`);
                }
              }
            }
          }
        }
        await owner.query(`DELETE FROM "Schools" WHERE slug IN ($1, $2)`, [`${SLUG}-${index}`, `${SLUG}-${index}-andra`]);
      }
      if (wanted >= worlds.length && from === 0) {
        assert.ok(fitsSeen.lit >= 100 && fitsSeen.dim >= 100, `${fitsSeen.lit} lit, ${fitsSeen.dim} dim`);
        assert.ok(fitsSeen.free >= 100 && fitsSeen.busy >= 50 && fitsSeen.shut >= 1, `${fitsSeen.free} free, ${fitsSeen.busy} busy, ${fitsSeen.shut} shut rooms`);
      }
      console.log(`     what fits: ${fitsSeen.lit} lit, ${fitsSeen.changed} lit in another room, ${fitsSeen.dim} dim; rooms: ${fitsSeen.free} free, ${fitsSeen.busy} busy, ${fitsSeen.shut} shut, each held against the judge`);
    });

    // MOJLIGA_NO_HOGSTADIUM=1 leaves it to the other process when the worlds are asked in two (it plants a school of one fixed name).
    if (process.env['MOJLIGA_NO_HOGSTADIUM'] !== '1') await check('(mt-e) a högstadium, with blocks and teaching groups: the unit moves as one, and the query and POST /judge agree on every start', async () => {
      const seeded = await seedHogstadium(owner, { slug: `${SLUG}-hogstadium`, letters: 'AB', pupils: 25 });
      const caller = { authId: seeded.adminAuth, userId: seeded.admin, schoolId: seeded.school, role: Role.SCHOOL_ADMIN, adminProfile: 'FULL', channel: 'WEB', hrRead: false } as unknown as AuthenticatedUser;
      const rows = (
        await owner.query<{ id: string; day: number; start: number; minutes: number; kind: string }>(
          `SELECT l.id, l."dayOfWeek" AS day,
                  extract(hour FROM l."startTime")::int * 60 + extract(minute FROM l."startTime")::int AS start,
                  (extract(epoch FROM l."endTime" - l."startTime") / 60)::int AS minutes,
                  g.kind
             FROM "MasterLessons" l JOIN "StudentGroups" g ON g.id = l."studentGroupId"
            WHERE l."academicYearId" = $1 AND NOT l."isParked" ORDER BY l.id`,
          [seeded.year],
        )
      ).rows;
      const byId = new Map(rows.map((row) => [row.id, row]));
      let asked = 0;
      let units = 0;
      let multi = 0;
      const timings: number[] = [];
      const every = Number(process.env['MOJLIGA_HOGSTADIUM_EVERY'] ?? 23);
      // Every so-many-th lesson, and some of the teaching groups' (the blocks and the halves are where units are more than one lesson).
      const sample = new Set([...rows.filter((_, at) => at % every === 0), ...rows.filter((row) => row.kind !== 'CLASS').filter((_, at) => at % 9 === 0).slice(0, 6)]);
      for (const row of sample) {
        const started = Date.now();
        const answer = await possible.possibleTimes({ lessonId: row.id, from: '07:00', to: '17:00', stepMinutes: 30, limit: 40 }, caller);
        timings.push(Date.now() - started);
        assert.equal(answer.stats.truncated, false);
        const members = answer.subject.lessonIds.map((id) => byId.get(id)!);
        units += 1;
        if (members.length > 1) multi += 1;
        const label = `${row.id} (${row.kind}, a unit of ${members.length})`;
        for (let day = 1; day <= 5; day++) {
          for (let start = 7 * 60; start + row.minutes <= 17 * 60; start += 30) {
            const run = answer.days.find((entry) => entry.dayOfWeek === day)!.runs.find((candidate) => candidate.fromMinutes <= start && start <= candidate.toMinutes);
            assert.ok(run, `${label}: no run holds ${day} ${clockOf(start)}`);
            if (run.kind === 'STANDS') continue;
            const asked_ = await masters.judgeMoves(
              { moves: members.map((member) => ({ lessonId: member.id, dayOfWeek: day, startTime: clockOf(start), endTime: clockOf(start + member.minutes) })) },
              caller,
            );
            asked += 1;
            const where = `${label}, day ${day} ${clockOf(start)}`;
            const reasons = asked_.moves.flatMap((move) => move.refusals.map((refusal) => refusal.reason));
            if (asked_.ok) assert.equal(run.kind, 'FREE', `${where}: POST /judge lets the unit through and the query says ${run.kind}${run.code ? ` ${run.code}` : ''}`);
            if (run.kind === 'FREE') assert.ok(asked_.ok, `${where}: the query says FREE and POST /judge says ${reasons.join(',')}`);
            if (run.kind === 'CLOSED' && !reasons.includes(run.code!) && process.env['MOJLIGA_DEBUG']) {
              const hit = await owner.query(
                `SELECT c."resourceType", c."userId", c."roomId", c."studentGroupId", c.date, c.type, to_char(c."startTime",'HH24:MI') s, to_char(c."endTime",'HH24:MI') e
                   FROM "AvailabilityConstraints" c WHERE c."dayOfWeek" = $1 AND c."schoolId" = $2`,
                [day, seeded.school],
              );
              const lesson = await owner.query(`SELECT "teacherId", "coTeacherId", "roomId", "studentGroupId" FROM "MasterLessons" WHERE id = ANY($1::uuid[])`, [members.map((member) => member.id)]);
              console.log('DEBUG', JSON.stringify({ lesson: lesson.rows, rowsOfTheDay: hit.rows, refusals: asked_.moves.map((move) => move.refusals) }, null, 1));
            }
            if (run.kind === 'CLOSED') assert.ok(reasons.includes(run.code!), `${where}: the query says CLOSED ${run.code}, POST /judge says ${reasons.join(',') || 'ok'}`);
            if (run.kind === 'IN_THE_WAY' || run.kind === 'CROWDED') assert.ok(!asked_.ok, `${where}: the query says ${run.kind} and POST /judge lets the unit through`);
          }
        }
        assert.equal(answer.stats.refused, 0, `${label}: the prune let ${answer.stats.refused} start(s) through that the judge refused`);

        // The rooms of a unit: the unit is moved as one with the asked lesson in the room asked about, and the judge agrees with the chooser.
        if (members.length > 1) {
          for (const [day, start] of [[2, 9 * 60], [4, 13 * 60]] as const) {
            const chosen = await fitting.roomChoices({ lessonId: row.id, dayOfWeek: day, startTime: clockOf(start) }, caller);
            for (const room of chosen.rooms) {
              const verdict = await masters.judgeMoves(
                { moves: members.map((member) => ({ lessonId: member.id, dayOfWeek: day, startTime: clockOf(start), endTime: clockOf(start + member.minutes), ...(member.id === row.id ? { roomId: room.roomId } : {}) })) },
                caller,
              );
              const roomRefusals = verdict.moves.filter((move) => move.lessonId === row.id).flatMap((move) => move.refusals).filter((refusal) => refusal.reason === 'ROOM' || (refusal.reason === 'AVAILABILITY' && refusal.params['resource'] === 'ROOM'));
              const where = `${label}, day ${day} ${clockOf(start)}, room ${room.name}`;
              if (room.state === 'FREE') assert.equal(roomRefusals.length, 0, `${where}: the chooser says free and the judge refuses the room`);
              else assert.ok(roomRefusals.length > 0, `${where}: the chooser says ${room.state} and the judge has no objection to the room`);
            }
          }
        }
      }
      assert.ok(multi >= 1, `${multi} of ${units} units had more than one lesson`);
      timings.sort((a, b) => a - b);
      const { rows: lessonCount } = await owner.query(`SELECT count(*)::int AS n FROM "MasterLessons" WHERE "academicYearId" = $1`, [seeded.year]);
      console.log(`     a school of ${lessonCount[0].n} lessons: ${units} units asked (${multi} of more than one lesson), ${asked} starts held against POST /judge; an answer took ${timings[0]}–${timings[timings.length - 1]} ms, median ${timings[Math.floor(timings.length / 2)]} ms, at load ${(await import('node:os')).loadavg().map((load) => load.toFixed(0)).join('/')}`);
    });
  } finally {
    // Only the worlds this process asked: another process asking the rest has its schools planted.
    for (let index = from; index < Math.min(wanted, worlds.length); index++) await owner.query(`DELETE FROM "Schools" WHERE slug IN ($1, $2)`, [`${SLUG}-${index}`, `${SLUG}-${index}-andra`]);
    if (process.env['MOJLIGA_NO_HOGSTADIUM'] !== '1') await owner.query(`DELETE FROM "Schools" WHERE slug = $1`, [`${SLUG}-hogstadium`]);
  }
}

async function main() {
  const owner = new Client({ connectionString: process.env['PROBE_OWNER_URL'] });
  await owner.connect();
  const api = new PrismaService();
  await api.onModuleInit();
  try {
    await mojligaTiderChecks(owner, api, async (name, run) => {
      try {
        await run();
        console.log(`  ok  ${name}`);
      } catch (error) {
        console.error(`  FAIL  ${name}`);
        throw error;
      }
    });
  } finally {
    await owner.end();
    await api.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
