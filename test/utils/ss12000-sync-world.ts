import { randomUUID } from 'node:crypto';
import type { TxMock } from './prisma-mock';

/**
 * An in-memory school behind the e2e harness's Prisma mock, for the SS12000
 * sync's specs: the rows the sync reads and writes (source, sealed
 * credentials, runs, changes, users, groups, memberships, guardian links,
 * duty links, years), answered by the model calls the services make. It
 * stands in for the database exactly as the mock does everywhere else —
 * the code under test runs whole; what Postgres itself enforces (RLS, the
 * guards, the triggers) is the RLS suite's and the adapter probe's, against
 * a real database.
 *
 * Filters understood: equality (null included), { not }, { in }, { gte },
 * { gt }, { lt }. `select` is ignored (whole rows come back).
 */
type Row = Record<string, unknown>;

function matches(row: Row, where: Row | undefined): boolean {
  if (!where) return true;
  for (const [key, condition] of Object.entries(where)) {
    const value = row[key];
    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date) && !Array.isArray(condition)) {
      const c = condition as Row;
      if ('not' in c && (c['not'] === null ? value === null || value === undefined : value === c['not'])) return false;
      if ('in' in c && !(c['in'] as unknown[]).includes(value)) return false;
      if ('gte' in c && !((value as Date | number) >= (c['gte'] as Date | number))) return false;
      if ('gt' in c && !((value as Date | number) > (c['gt'] as Date | number))) return false;
      if ('lt' in c && !((value as Date | number) < (c['lt'] as Date | number))) return false;
      continue;
    }
    if (condition === null ? value !== null && value !== undefined : value !== condition) return false;
  }
  return true;
}

function table(rows: Row[], defaults: () => Row = () => ({})) {
  return {
    rows,
    findFirst: async ({ where }: { where?: Row } = {}) => rows.find((row) => matches(row, where)) ?? null,
    findMany: async ({ where, orderBy, take }: { where?: Row; orderBy?: Row | Row[]; take?: number } = {}) => {
      let out = rows.filter((row) => matches(row, where));
      const order = Array.isArray(orderBy) ? orderBy[0] : orderBy;
      if (order) {
        const [key, direction] = Object.entries(order)[0] as [string, 'asc' | 'desc'];
        out = [...out].sort((a, b) => {
          const x = a[key] as string | number | Date;
          const y = b[key] as string | number | Date;
          return (x < y ? -1 : x > y ? 1 : 0) * (direction === 'desc' ? -1 : 1);
        });
      }
      return take === undefined ? out : out.slice(0, take);
    },
    count: async ({ where }: { where?: Row } = {}) => rows.filter((row) => matches(row, where)).length,
    create: async ({ data }: { data: Row }) => {
      const row = { id: randomUUID(), ...defaults(), ...data };
      rows.push(row);
      return row;
    },
    createMany: async ({ data }: { data: Row[] }) => {
      for (const item of data) rows.push({ id: randomUUID(), ...defaults(), ...item });
      return { count: data.length };
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = rows.find((candidate) => matches(candidate, where));
      if (!row) throw new Error(`no row ${JSON.stringify(where)}`);
      Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }: { where?: Row; data: Row }) => {
      const hit = rows.filter((row) => matches(row, where));
      for (const row of hit) Object.assign(row, data);
      return { count: hit.length };
    },
  };
}

export interface SealedSecretRow {
  kind: string;
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  key_id: string;
  set_at: Date;
}

export class SyncWorld {
  readonly sources: Row[] = [];
  readonly secrets = new Map<string, SealedSecretRow>();
  readonly runs: Row[] = [];
  readonly changes: Row[] = [];
  readonly users: Row[] = [];
  readonly groups: Row[] = [];
  readonly members: Row[] = [];
  readonly links: Row[] = [];
  readonly dutyLinks: Row[] = [];
  readonly years: Row[] = [];
  readonly rawStatements: string[] = [];
  /** What app.ss12000_due_sources answers on the next tick. */
  due: Array<{ source_id: string; school_id: string; full_due: boolean }> = [];
  school: Row;

  constructor(readonly schoolId: string) {
    this.school = { id: schoolId, name: 'Ekskolan', timezone: 'Europe/Stockholm' };
  }

  get source(): Row | undefined {
    return this.sources[0];
  }

  install(tx: TxMock): void {
    const now = () => new Date();
    const models: Record<string, ReturnType<typeof table>> = {
      ss12000Source: table(this.sources, () => ({
        tokenAuthStyle: 'BASIC', organisationIds: [], schoolUnitCodes: [], pageSize: 1000, enabled: true, scheduleEnabled: false,
        scheduleAutoApply: false, scheduleHourLocal: 2, fullEveryDays: 7, incrementalUnsupported: false, modifiedCursor: null,
        deletedCursor: null, lastFullAt: null, lastAppliedAt: null, lastTestedAt: null, lastTestOutcome: null, schedulerClaimedAt: null,
        lastScheduledLocalDate: null, tokenUrl: null, clientId: null, tokenScope: null, createdAt: now(), updatedAt: now(),
      })),
      ss12000SyncRun: table(this.runs, () => ({
        status: 'RUNNING', statusCode: null, startedAt: now(), fetchedAt: null, finishedAt: null, appliedAt: null, appliedById: null,
        autoApplied: false, counts: {}, errors: [], basisHash: null, autoApplyBlockedReason: null, cursorTo: null,
      })),
      ss12000SyncChange: table(this.changes, () => ({ applied: false, createdAt: now() })),
      user: table(this.users, () => ({ isActive: true, studentGroupId: null, ss12000Id: null, invitedAt: null, updatedAt: now(), phone: null })),
      studentGroup: table(this.groups, () => ({ ss12000Id: null, gradeLevel: null, updatedAt: now() })),
      studentGroupMember: table(this.members),
      guardianStudent: table(this.links, () => ({ origin: 'MANUAL' })),
      ss12000DutyLink: table(this.dutyLinks, () => ({ endedAt: null })),
      academicYear: table(this.years),
      school: table([this.school]),
    };
    for (const [model, impl] of Object.entries(models)) {
      for (const [method, fn] of Object.entries(impl)) {
        if (method === 'rows') continue;
        tx[model]![method]!.mockImplementation(fn as (...args: unknown[]) => unknown);
      }
    }

    const sqlOf = (statement: unknown) => {
      const sql = statement as { strings?: string[]; values?: unknown[] };
      return { text: (sql.strings ?? []).join('?'), values: sql.values ?? [] };
    };
    (tx.$queryRaw as unknown as jest.Mock).mockImplementation(async (statement: unknown) => {
      const { text, values } = sqlOf(statement);
      this.rawStatements.push(text);
      if (text.includes('app.ss12000_source_secret_presence')) {
        return [...this.secrets.values()].map((row) => ({ kind: row.kind, set_at: row.set_at }));
      }
      if (text.includes('app.ss12000_set_source_secret')) {
        const [, kind, ciphertext, iv, tag, keyId] = values as [string, string, Buffer, Buffer, Buffer, string];
        const row = { kind, ciphertext, iv, auth_tag: tag, key_id: keyId, set_at: now() };
        this.secrets.set(kind, row);
        return [{ set_at: row.set_at }];
      }
      if (text.includes('app.ss12000_clear_source_secrets')) {
        const kinds = (values.find(Array.isArray) as string[] | undefined) ?? (values.filter((v) => typeof v === 'string' && /^[A-Z_]+$/.test(v)) as string[]);
        let cleared = 0;
        for (const kind of kinds) if (this.secrets.delete(kind)) cleared++;
        return [{ cleared }];
      }
      if (text.includes('app.ss12000_source_secrets')) {
        return [...this.secrets.values()].map(({ kind, ciphertext, iv, auth_tag, key_id }) => ({ kind, ciphertext, iv, auth_tag, key_id }));
      }
      if (text.includes('app.ss12000_housekeeping')) return [{ stale: 0, expired: 0 }];
      if (text.includes('app.ss12000_due_sources')) {
        const due = this.due;
        this.due = [];
        return due;
      }
      if (text.includes('"Ss12000Sources"') && text.includes('FOR UPDATE')) {
        return this.source ? [{ id: this.source['id'] }] : [];
      }
      return [];
    });
    (tx.$executeRaw as unknown as jest.Mock).mockImplementation(async (statement: unknown) => {
      const { text } = sqlOf(statement);
      this.rawStatements.push(typeof statement === 'object' && statement !== null && 'strings' in statement ? text : String(statement));
      return 0;
    });
  }
}
