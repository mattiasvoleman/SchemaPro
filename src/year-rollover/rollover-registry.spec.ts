import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { ROLLOVER_REGISTRY, ROLLOVER_STEP_ORDER, type Disposition } from './rollover-registry';

/**
 * The completeness test: no table that belongs to a läsår is left out of the
 * rollover without somebody having decided so in writing.
 *
 * WHERE THE SET COMES FROM. The runtime DMMF lists relation fields but not
 * which side holds the key — School and AcademicYear list StudentGroup as a
 * relation exactly as StudentGroup lists them — and three year-keyed tables
 * (ScheduleChangeLog, ScheduleVersion, OptimizationJob) carry academicYearId
 * with no relation at all. So the set is the union of
 *
 *  (i)   every model holding a `fields:` relation to AcademicYear or
 *        StudentGroup, parsed from prisma/schema.prisma (the `fields:` side
 *        is the child);
 *  (ii)  every model with a scalar named like *YearId, from the DMMF;
 *  (iii) every model holding a `fields:` relation to a model the rollover
 *        writes (PROMOTED or COPIED) — a child of a carried row would
 *        otherwise be dropped silently when its parent is copied without it.
 *
 * The registry's keys must cover the set exactly; an entry outside it must
 * be a FOLLOWS whose parent it really is a child of.
 */

const schema = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');

/** child → the models it holds a `fields:` relation to, from schema.prisma. */
function relationParents(): Map<string, Set<string>> {
  const parents = new Map<string, Set<string>>();
  for (const [, model, body] of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    for (const line of body!.split('\n')) {
      const field = /^\s*\w+\s+(\w+)(?:\?|\[\])?\s.*@relation\((.*)\)/.exec(line);
      if (!field || !field[2]!.includes('fields:')) continue;
      const set = parents.get(model!) ?? new Set<string>();
      set.add(field[1]!);
      parents.set(model!, set);
    }
  }
  return parents;
}

const models = Prisma.dmmf.datamodel.models;
const scalarColumns = (model: string): string[] =>
  models
    .find((candidate) => candidate.name === model)!
    .fields.filter((field) => field.kind === 'scalar' || field.kind === 'enum')
    .map((field) => field.name)
    .sort();

const isCarried = (disposition: Disposition) =>
  disposition.kind === 'ROOT' || disposition.kind === 'PROMOTED' || disposition.kind === 'COPIED';

function yearScopedModels(): Set<string> {
  const parents = relationParents();
  const found = new Set<string>();
  for (const [child, of] of parents) {
    if (of.has('AcademicYear') || of.has('StudentGroup')) found.add(child);
  }
  for (const model of models) {
    if (model.fields.some((field) => field.kind === 'scalar' && /Year\w*Id$/.test(field.name))) {
      found.add(model.name);
    }
  }
  // (iii), to a fixed point: a carried model's child is in the set, and so
  // is its child if it is carried in turn.
  let grew = true;
  while (grew) {
    grew = false;
    const carried = [...found, 'AcademicYear'].filter((model) => {
      const disposition = ROLLOVER_REGISTRY[model];
      return disposition !== undefined && isCarried(disposition);
    });
    for (const [child, of] of parents) {
      if (!found.has(child) && carried.some((model) => of.has(model))) {
        found.add(child);
        grew = true;
      }
    }
  }
  found.add('AcademicYear');
  return found;
}

describe('the rollover registry', () => {
  it('finds the year-scoped tables it is meant to find (the parser still parses)', () => {
    const set = yearScopedModels();
    // One of each source, so a schema reformat that blinds the parser fails here
    // rather than passing with an empty set.
    expect(set.has('TeachingRequirement')).toBe(true); // (i), to AcademicYear
    expect(set.has('User')).toBe(true); // (i), to StudentGroup only
    expect(set.has('ScheduleChangeLog')).toBe(true); // (ii), no relation at all
    expect(set.has('TeacherDuty')).toBe(true);
    expect(set.size).toBeGreaterThanOrEqual(19);
  });

  it('classifies every table that belongs to a läsår or a group (completeness)', () => {
    const set = yearScopedModels();
    const unclassified = [...set].filter((model) => ROLLOVER_REGISTRY[model] === undefined).sort();
    // A failure here is a new per-year table nobody has decided about. Add it
    // to ROLLOVER_REGISTRY as PROMOTED/COPIED (with columns and a step) or
    // SKIPPED/FOLLOWS/AT_ACTIVATION with the reason a schemaläggare would ask
    // for. P2's AcademicYearTimplans: PROMOTED by cohort, see the R-0 spec §3.
    expect(unclassified).toEqual([]);
  });

  it('has no entry that is not a year-scoped table, except a FOLLOWS of its real parent', () => {
    const set = yearScopedModels();
    const parents = relationParents();
    for (const [model, disposition] of Object.entries(ROLLOVER_REGISTRY)) {
      if (set.has(model)) continue;
      expect({ model, kind: disposition.kind }).toEqual({ model, kind: 'FOLLOWS' });
      if (disposition.kind !== 'FOLLOWS') continue;
      expect({ model, parentHeld: parents.get(model)?.has(disposition.parent) ?? false }).toEqual({
        model,
        parentHeld: true,
      });
    }
  });

  it('lets a FOLLOWS follow only a table that is itself left behind', () => {
    for (const [model, disposition] of Object.entries(ROLLOVER_REGISTRY)) {
      if (disposition.kind !== 'FOLLOWS') continue;
      const parent = ROLLOVER_REGISTRY[disposition.parent];
      expect({ model, parent: parent?.kind }).toEqual({
        model,
        parent: expect.stringMatching(/^(SKIPPED|FOLLOWS)$/),
      });
    }
  });

  it('gives every decision a reason someone can act on', () => {
    for (const [model, disposition] of Object.entries(ROLLOVER_REGISTRY)) {
      const nonBlank = disposition.reason.replace(/\s/g, '').length;
      expect({ model, enough: nonBlank >= 20 }).toEqual({ model, enough: true });
    }
  });

  it('gives every carried table a step the rollover runs', () => {
    for (const [model, disposition] of Object.entries(ROLLOVER_REGISTRY)) {
      if (!isCarried(disposition)) continue;
      const step = (disposition as { step: string }).step;
      expect({ model, step, known: ROLLOVER_STEP_ORDER.includes(step as never) }).toEqual({
        model,
        step,
        known: true,
      });
    }
    // The year comes first and the groups second: everything after maps a group.
    expect(ROLLOVER_STEP_ORDER.slice(0, 2)).toEqual(['year', 'groups']);
  });

  it('states a rule for every column of every carried table, and only for real columns', () => {
    for (const [model, disposition] of Object.entries(ROLLOVER_REGISTRY)) {
      if (!isCarried(disposition)) continue;
      const columns = (disposition as { columns: Record<string, string> }).columns;
      // A failure here is a column added to a table the rollover writes:
      // decide whether the copy keeps, maps, shifts or defaults it.
      expect({ model, columns: Object.keys(columns).sort() }).toEqual({
        model,
        columns: scalarColumns(model),
      });
    }
  });
});
