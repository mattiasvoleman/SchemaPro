import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  ROLLOVER_REGISTRY,
  ROLLOVER_STEP_ORDER,
  carriedModels,
  skippedModels,
  type Disposition,
} from './rollover-registry';

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
 *  (ii)  every model with a scalar named like *YearId or yearId, from the
 *        DMMF (the case-sensitive /Year\w*Id$/ missed a bare `yearId`);
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
type DmmfModel = { name: string; fields: readonly { kind: string; name: string }[] };

/** A scalar that names a läsår: academicYearId, sourceYearId — and a bare yearId. */
const YEAR_KEY = /(?:^y|Y)ear\w*Id$/;
const scalarColumns = (model: string): string[] =>
  models
    .find((candidate) => candidate.name === model)!
    .fields.filter((field) => field.kind === 'scalar' || field.kind === 'enum')
    .map((field) => field.name)
    .sort();

const isCarried = (disposition: Disposition) =>
  disposition.kind === 'ROOT' || disposition.kind === 'PROMOTED' || disposition.kind === 'COPIED';

function yearScopedModels(dmmfModels: readonly DmmfModel[] = models): Set<string> {
  const parents = relationParents();
  const found = new Set<string>();
  for (const [child, of] of parents) {
    if (of.has('AcademicYear') || of.has('StudentGroup')) found.add(child);
  }
  for (const model of dmmfModels) {
    if (model.fields.some((field) => field.kind === 'scalar' && YEAR_KEY.test(field.name))) {
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

  it('catches a year key with no relation whatever its case: academicYearId, sourceYearId and a bare yearId', () => {
    expect(['academicYearId', 'sourceYearId', 'yearId'].every((name) => YEAR_KEY.test(name))).toBe(true);
    expect(['predecessorId', 'studentGroupId', 'yearly', 'yearIds'].some((name) => YEAR_KEY.test(name))).toBe(false);
    // A future table keyed by a bare `yearId` with no @relation, like
    // ScheduleVersion today: it must land in the set, and so fail completeness.
    const fake = { name: 'FakeYearSnapshot', fields: [{ kind: 'scalar', name: 'id' }, { kind: 'scalar', name: 'yearId' }] };
    expect(yearScopedModels([...models, fake]).has('FakeYearSnapshot')).toBe(true);
  });

  it('classifies every table that belongs to a läsår or a group (completeness)', () => {
    const set = yearScopedModels();
    const unclassified = [...set].filter((model) => ROLLOVER_REGISTRY[model] === undefined).sort();
    // A failure here is a new per-year table nobody has decided about. Add it
    // to ROLLOVER_REGISTRY as PROMOTED/COPIED (with columns and a step) or
    // SKIPPED/FOLLOWS/AT_ACTIVATION with the reason a schemaläggare would ask
    // for. P2's AcademicYearTimplans is PROMOTED by cohort (rollover-timplans.ts).
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

  it('states a rule for every column of every carried table, and only for real columns — for every writer of it', () => {
    for (const [model, disposition] of Object.entries(ROLLOVER_REGISTRY)) {
      if (!isCarried(disposition)) continue;
      const entry = disposition as { columns: Record<string, string>; alsoWrittenBy?: { step: string; columns: Record<string, string> }[] };
      // A failure here is a column added to a table the rollover writes:
      // decide whether the copy keeps, maps, shifts or defaults it.
      expect({ model, columns: Object.keys(entry.columns).sort() }).toEqual({
        model,
        columns: scalarColumns(model),
      });
      // And for the second writer of the table (an uppdrag's slot).
      for (const writer of entry.alsoWrittenBy ?? []) {
        expect({ model, step: writer.step, columns: Object.keys(writer.columns).sort() }).toEqual({
          model,
          step: writer.step,
          columns: scalarColumns(model),
        });
      }
    }
  });

  it('gives every second writer a step the rollover runs, and after the step of the table’s own rows', () => {
    for (const [model, disposition] of Object.entries(ROLLOVER_REGISTRY)) {
      if (!isCarried(disposition)) continue;
      const entry = disposition as { step: string; alsoWrittenBy?: { step: string; rows: string }[] };
      for (const writer of entry.alsoWrittenBy ?? []) {
        expect({ model, step: writer.step, known: ROLLOVER_STEP_ORDER.includes(writer.step as never) }).toEqual({
          model,
          step: writer.step,
          known: true,
        });
        expect({ model, rows: writer.rows.replace(/\s/g, '').length >= 20 }).toEqual({ model, rows: true });
        expect({ model, after: ROLLOVER_STEP_ORDER.indexOf(writer.step as never) > ROLLOVER_STEP_ORDER.indexOf(entry.step as never) }).toEqual({
          model,
          after: true,
        });
      }
    }
    expect(ROLLOVER_REGISTRY['AvailabilityConstraint']).toMatchObject({ alsoWrittenBy: [{ step: 'duties' }] });
  });

  it('says what an optional carry is with its option off, in a reason someone can act on, and counts it', () => {
    const optional = Object.entries(ROLLOVER_REGISTRY).filter(
      ([, disposition]) => isCarried(disposition) && (disposition as { option?: string }).option !== undefined,
    );
    expect(optional.map(([model]) => model).sort()).toEqual(['TeacherDuty', 'TeacherEmployment']);
    for (const [model, disposition] of optional) {
      const whenOff = (disposition as { whenOff?: { reason: string; previewCount: true } }).whenOff;
      expect({ model, enough: (whenOff?.reason.replace(/\s/g, '').length ?? 0) >= 20, counted: whenOff?.previewCount }).toEqual({
        model,
        enough: true,
        counted: true,
      });
    }
  });

  it('lists, with the option off, exactly fa4a3d6’s skipped tables and reasons, and carries exactly its tables', () => {
    // sha256 of JSON.stringify(skippedModels()) at fa4a3d6 (a git archive of
    // it), over every entry that existed then: TimplanCredit (timplan P3) and
    // TeacherEmploymentLog (staffing Fas 3) are the tables added since, and
    // are asserted beside it — skipped, not counted — so fa4a3d6's own list
    // stays pinned byte for byte. The statement tables (timplan P4) likewise,
    // and the publication log (Publicering).
    const skipped = skippedModels();
    const added = [
      'TimplanCredit',
      'TeacherEmploymentLog',
      'TimplanStatementPublication',
      'TimplanStatement',
      'TimetablePublication',
      'PublishedLesson',
      'CancellationBatch',
      'CancellationBatchLesson',
      'CancellationBatchCredit',
      'PublicationPendingRemoval',
    ];
    expect(
      createHash('sha256')
        .update(JSON.stringify(skipped.filter((entry) => !added.includes(entry.model))))
        .digest('hex'),
    ).toBe('15e270c65904cbdbf7c54b605def4014bb038dc836dd29dae22f91c0b23ad113');
    expect(skipped.slice(-10)).toEqual([
      expect.objectContaining({ model: 'TimplanCredit', counted: false }),
      expect.objectContaining({ model: 'TeacherEmploymentLog', counted: false }),
      expect.objectContaining({ model: 'TimplanStatementPublication', counted: false }),
      expect.objectContaining({ model: 'TimplanStatement', counted: false }),
      expect.objectContaining({ model: 'TimetablePublication', counted: false }),
      expect.objectContaining({ model: 'PublishedLesson', counted: false }),
      expect.objectContaining({ model: 'CancellationBatch', counted: false }),
      expect.objectContaining({ model: 'CancellationBatchLesson', counted: false }),
      expect.objectContaining({ model: 'CancellationBatchCredit', counted: false }),
      expect.objectContaining({ model: 'PublicationPendingRemoval', counted: false }),
    ]);
    expect(skippedModels({ carryStaffing: false })).toEqual(skippedModels());
    expect(carriedModels().map(({ model }) => model)).toEqual([
      'AcademicYear',
      'StudentGroup',
      'StudentGroupMember',
      'TeachingRequirement',
      'SchoolBreak',
      'AvailabilityConstraint',
      'AcademicYearTimplan',
    ]);
    // With it on: the two staffing tables carried, by their own steps, last.
    expect(carriedModels({ carryStaffing: true }).slice(-2)).toEqual([
      { model: 'TeacherEmployment', step: 'employments' },
      { model: 'TeacherDuty', step: 'duties' },
    ]);
    expect(skippedModels({ carryStaffing: true }).map((entry) => entry.model)).not.toContain('TeacherDuty');
    expect(ROLLOVER_STEP_ORDER.slice(-2)).toEqual(['employments', 'duties']);
  });
});
