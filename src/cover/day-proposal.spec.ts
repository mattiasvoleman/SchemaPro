import { isFeasible, type CoverTarget, type PersonDay, type PersonLesson } from './cover-rules';
import { proposeDay, type ProposalDeps, type ProposalLesson } from './day-proposal';

const H = 3_600_000;
const D = '2026-10-14';
const MIDNIGHT = Date.UTC(2026, 9, 14);
const t = (hours: number) => MIDNIGHT + hours * H;

const person = (userId: string, overrides: Partial<PersonDay> = {}): PersonDay => ({
  userId,
  isActiveTeacher: true,
  lessons: [],
  closures: [],
  preferredFree: [],
  bookings: [],
  absences: [],
  lunch: null,
  minDailyRestMinutes: null,
  pool: { member: false, hasEmployment: false, windows: [] },
  ...overrides,
});

const busy = (id: string, from: number, to: number): PersonLesson => ({
  id,
  date: D,
  start: t(from),
  end: t(to),
  status: 'SCHEDULED',
  studentGroupId: 'g',
  subjectId: 's',
});

const lesson = (id: string, from: number, to: number, candidates: string[]): ProposalLesson => ({
  lessonId: id,
  absenceId: `abs-${id}`,
  target: { id, date: D, start: t(from), end: t(to), teacherIds: ['absent'] },
  candidates,
});

/** Base scores per (lesson, person); every pick already given costs `perPick`. */
function deps(people: PersonDay[], scores: Record<string, Record<string, number>>, perPick = 0): ProposalDeps {
  const byId = new Map(people.map((p) => [p.userId, p]));
  return {
    day: (userId) => byId.get(userId),
    score: (entry, userId, picked) => ({
      score: (scores[entry.lessonId]?.[userId] ?? 0) - perPick * picked.length,
      reasons: [],
      week: picked.length,
    }),
  };
}

const assignment = (proposal: ReturnType<typeof proposeDay>) =>
  Object.fromEntries(proposal.items.map((item) => [item.lessonId, item.userId]));

describe('Fördela dagen (greedy proposal)', () => {
  it('most constrained first: the lesson only A can take gets A, though A scores higher elsewhere', () => {
    const people = [person('A'), person('B')];
    // L1 first by start; naive order would give L1 to A and leave L2 empty.
    const lessons = [lesson('L1', 9, 10, ['A', 'B']), lesson('L2', 9.5, 10.5, ['A'])];
    const proposal = proposeDay(lessons, deps(people, { L1: { A: 50, B: 10 }, L2: { A: 10 } }));
    expect(assignment(proposal)).toEqual({ L1: 'B', L2: 'A' });
    expect(proposal.unassigned).toEqual([]);
  });

  it('re-checks lunch against the evolving day: a second lesson that would take A’s lunch goes to B', () => {
    const lunchA = person('A', { lunch: { minutes: 30, window: { start: t(11), end: t(13) } } });
    const lessons = [lesson('L1', 11, 12, ['A', 'B']), lesson('L2', 12, 12.75, ['A', 'B'])];
    const proposal = proposeDay(lessons, deps([lunchA, person('B')], { L1: { A: 50, B: 10 }, L2: { A: 50, B: 10 } }));
    expect(assignment(proposal)).toEqual({ L1: 'A', L2: 'B' });
  });

  it('the counter moves with each pick: A’s second cover scores below B', () => {
    const lessons = [lesson('L1', 8, 9, ['A', 'B']), lesson('L2', 10, 11, ['A', 'B'])];
    const proposal = proposeDay(lessons, deps([person('A'), person('B')], { L1: { A: 20, B: 18 }, L2: { A: 20, B: 18 } }, 5));
    expect(assignment(proposal)).toEqual({ L1: 'A', L2: 'B' });
  });

  it('repairs with one augmenting swap when a lesson is left with nobody', () => {
    const people = [person('A'), person('B'), person('D'), person('E')];
    const lessons = [lesson('L1', 8, 9, ['A', 'B']), lesson('L2', 8, 9, ['D', 'E']), lesson('L3', 8, 9, ['A', 'D'])];
    const proposal = proposeDay(
      lessons,
      deps(people, { L1: { A: 50, B: 10 }, L2: { D: 50, E: 10 }, L3: { A: 50, D: 50 } }),
    );
    expect(assignment(proposal)).toEqual({ L1: 'B', L2: 'D', L3: 'A' });
    expect(proposal.unassigned).toEqual([]);
  });

  it('names why a lesson stayed open', () => {
    const people = [person('A'), person('B', { lessons: [busy('own', 8, 9)] })];
    const lessons = [lesson('L1', 8, 9, ['A']), lesson('L2', 8, 9, ['A']), lesson('L3', 8, 9, ['B'])];
    const proposal = proposeDay(lessons, deps(people, { L1: { A: 5 }, L2: { A: 5 } }));
    expect(proposal.unassigned).toEqual([
      { lessonId: 'L2', absenceId: 'abs-L2', why: 'CONSUMED' },
      { lessonId: 'L3', absenceId: 'abs-L3', why: 'NO_FEASIBLE_CANDIDATE' },
    ]);
  });

  it('is deterministic: the same day is the same proposal, whatever the input order', () => {
    const people = [person('A'), person('B'), person('C')];
    const lessons = [lesson('L1', 8, 9, ['A', 'B', 'C']), lesson('L2', 8, 9, ['C', 'B', 'A']), lesson('L3', 9, 10, ['B', 'A'])];
    const one = proposeDay(lessons, deps(people, {}));
    const two = proposeDay([...lessons].reverse(), deps([...people].reverse(), {}));
    expect(two).toEqual(one);
  });

  it('a pool the school uses last is proposed only where no colleague can take the lesson, whatever its score', () => {
    const people = [person('A'), person('P')];
    const lessons = [lesson('L1', 9, 10, ['A', 'P']), lesson('L2', 9, 10, ['A', 'P'])];
    const base = deps(people, { L1: { A: -30, P: -15 }, L2: { A: -30, P: -15 } });
    const proposal = proposeDay(lessons, {
      ...base,
      score: (entry, userId, picked) => ({ ...base.score(entry, userId, picked), tier: userId === 'P' ? 1 : 0 }),
    });
    // A takes the first; the second overlaps it, so only then the pool.
    expect(assignment(proposal)).toEqual({ L1: 'A', L2: 'P' });
  });

  describe('two pairs of one lesson (a co-taught lesson whose two teachers are both away)', () => {
    const pair = (id: string, absenceId: string, from: number, to: number, candidates: string[]): ProposalLesson => ({
      lessonId: id,
      absenceId,
      target: { id, date: D, start: t(from), end: t(to), teacherIds: ['A', 'B'] },
      candidates,
    });

    it('names a different person for each pair, never one person twice on the lesson', () => {
      const lessons = [pair('L', 'absA', 10, 11, ['C1', 'C2', 'C3']), pair('L', 'absB', 10, 11, ['C1', 'C2', 'C3'])];
      const proposal = proposeDay(lessons, deps([person('C1'), person('C2'), person('C3')], { L: { C1: 50, C2: 40, C3: 10 } }, 6));
      expect(proposal.items.map((item) => [item.lessonId, item.absenceId, item.userId])).toEqual([
        ['L', 'absA', 'C1'],
        ['L', 'absB', 'C2'],
      ]);
      expect(proposal.unassigned).toEqual([]);
    });

    it('with an overlapping lesson and two free people, both are used and nobody is named twice', () => {
      const lessons = [
        pair('L', 'absA', 10, 11, ['C1', 'C2']),
        pair('L', 'absB', 10, 11, ['C1', 'C2']),
        lesson('M', 10, 11, ['C1', 'C2']),
      ];
      const proposal = proposeDay(lessons, deps([person('C1'), person('C2')], { L: { C1: 50, C2: 49 }, M: { C1: 1, C2: 1 } }, 6));
      const users = proposal.items.map((item) => item.userId);
      expect(new Set(users).size).toBe(users.length);
      expect(users.sort()).toEqual(['C1', 'C2']);
      expect(proposal.unassigned).toHaveLength(1);
    });

    it('a lone candidate takes one pair; the other is CONSUMED, not given to them again', () => {
      const lessons = [pair('L', 'absA', 10, 11, ['C1']), pair('L', 'absB', 10, 11, ['C1'])];
      const proposal = proposeDay(lessons, deps([person('C1')], { L: { C1: 5 } }));
      expect(proposal.items.map((item) => [item.absenceId, item.userId])).toEqual([['absA', 'C1']]);
      expect(proposal.unassigned).toEqual([{ lessonId: 'L', absenceId: 'absB', why: 'CONSUMED' }]);
    });
  });

  describe('property: 200 seeded random days', () => {
    /** mulberry32 — a fixed seed per day, so a failure names its day. */
    const rng = (seed: number) => () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };

    /** Every item feasible against the day with the OTHER items of the subset applied. */
    function holds(people: Map<string, PersonDay>, lessons: Map<string, CoverTarget>, items: { lessonId: string; userId: string }[]): boolean {
      return items.every((item) => {
        // One person on two pairs of one lesson is never a valid proposal.
        if (items.some((other) => other !== item && other.userId === item.userId && other.lessonId === item.lessonId)) return false;
        const others = items
          .filter((other) => other.userId === item.userId && other.lessonId !== item.lessonId)
          .map((other) => {
            const target = lessons.get(other.lessonId)!;
            return { id: target.id, date: target.date, start: target.start, end: target.end, status: 'SCHEDULED' as const, studentGroupId: '', subjectId: '' };
          });
        return isFeasible(people.get(item.userId)!, lessons.get(item.lessonId)!, others);
      });
    }

    it.each(Array.from({ length: 200 }, (_, seed) => [seed]))('day %i: the proposal and every subset of it pass the hard rules', (seed) => {
      const random = rng(seed + 1);
      const ids = Array.from({ length: 3 + Math.floor(random() * 6) }, (_, i) => `P${i}`);
      const people = ids.map((id) => {
        const own: PersonLesson[] = [];
        for (let k = 0; k < Math.floor(random() * 4); k++) {
          const start = 8 + Math.floor(random() * 16) / 2;
          own.push(busy(`${id}-own-${k}`, start, start + 0.5 + Math.floor(random() * 3) / 2));
        }
        return person(id, {
          lessons: own,
          lunch: random() < 0.5 ? { minutes: 30, window: { start: t(11), end: t(13) } } : null,
          absences: random() < 0.15 ? [{ start: t(8), end: t(12) }] : [],
          bookings: random() < 0.2 ? [{ start: t(13), end: t(14) }] : [],
        });
      });
      const lessons = Array.from({ length: 2 + Math.floor(random() * 9) }, (_, i) => {
        const start = 8 + Math.floor(random() * 16) / 2;
        const candidates = ids.filter(() => random() < 0.7);
        return lesson(`L${String(i).padStart(2, '0')}`, start, start + 0.5 + Math.floor(random() * 3) / 2, candidates);
      });
      const scores: Record<string, Record<string, number>> = {};
      for (const entry of lessons) scores[entry.lessonId] = Object.fromEntries(ids.map((id) => [id, Math.floor(random() * 60)]));
      // Some lessons are co-taught with both teachers away: a second pair of
      // the same lesson (its own stream, so the days above are unchanged).
      const twin = rng(seed + 10_001);
      for (const entry of [...lessons]) {
        if (twin() < 0.3) lessons.push({ ...entry, absenceId: `${entry.absenceId}-2` });
      }

      const proposal = proposeDay(lessons, deps(people, scores, 5));
      const byPerson = new Map(people.map((p) => [p.userId, p]));
      const byLesson = new Map(lessons.map((entry) => [entry.lessonId, entry.target]));
      const items = proposal.items.map(({ lessonId, userId }) => ({ lessonId, userId }));

      // Every pair is either proposed or named, once.
      const pairKey = (entry: { lessonId: string; absenceId: string }) => `${entry.lessonId}:${entry.absenceId}`;
      expect([...proposal.items.map(pairKey), ...proposal.unassigned.map(pairKey)].sort()).toEqual(lessons.map(pairKey).sort());
      // Every subset: all of them for a small day, 64 random ones otherwise.
      const masks =
        items.length <= 8
          ? Array.from({ length: 1 << items.length }, (_, mask) => mask)
          : Array.from({ length: 64 }, () => Math.floor(random() * (1 << items.length)));
      for (const mask of [...masks, (1 << items.length) - 1]) {
        const subset = items.filter((_, index) => (mask >> index) & 1);
        expect({ seed, mask, holds: holds(byPerson, byLesson, subset) }).toEqual({ seed, mask, holds: true });
      }
    });
  });
});
