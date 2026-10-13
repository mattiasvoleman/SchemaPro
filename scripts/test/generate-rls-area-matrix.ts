/**
 * Writes the generated part of section 116 of scripts/test/rls-policies.sql:
 * the profile matrix and every table's write gates, as rows the section's
 * probes run against. The source is src/auth/admin-areas.ts.
 *
 *   npx ts-node --transpile-only scripts/test/generate-rls-area-matrix.ts
 *
 * rewrites the block between the two markers in place.
 * src/auth/admin-areas.spec.ts fails while the block is stale, so a change to
 * the matrix that is not run here does not pass unnoticed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AdminProfile } from '@prisma/client';
import {
  PROFILE_DECIDES,
  PROFILE_WRITES,
  TABLE_WRITE_GATES,
  type WriteGate,
} from '../../src/auth/admin-areas';

export const BEGIN_MARKER = '-- BEGIN GENERATED: area matrix (scripts/test/generate-rls-area-matrix.ts)';
export const END_MARKER = '-- END GENERATED: area matrix';

const array = (items: readonly string[]): string => `'{${items.join(',')}}'`;
const gates = (items: readonly WriteGate[]): string => array([...items]);

/** The block, markers included. */
export function areaMatrixBlock(): string {
  const profiles = Object.values(AdminProfile).map(
    (profile) => `  ('${profile}', ${array(PROFILE_WRITES[profile])}, ${PROFILE_DECIDES[profile]})`,
  );
  const tables = Object.keys(TABLE_WRITE_GATES)
    .sort()
    .map((table) => {
      const g = TABLE_WRITE_GATES[table]!;
      return `  ('${table}', ${gates(g.insert)}, ${gates(g.update)}, ${gates(g.delete)}, ${gates(g.read ?? [])})`;
    });
  return [
    BEGIN_MARKER,
    'INSERT INTO area_profiles (profile, writes, decides) VALUES',
    `${profiles.join(',\n')};`,
    'INSERT INTO area_gates (tbl, ins, upd, del, rd) VALUES',
    `${tables.join(',\n')};`,
    END_MARKER,
  ].join('\n');
}

/** The suite with its block replaced by a fresh one. */
export function withFreshBlock(suite: string): string {
  const start = suite.indexOf(BEGIN_MARKER);
  const end = suite.indexOf(END_MARKER);
  if (start < 0 || end < start) {
    throw new Error('rls-policies.sql has no area matrix block to replace');
  }
  return suite.slice(0, start) + areaMatrixBlock() + suite.slice(end + END_MARKER.length);
}

if (require.main === module) {
  const path = join(__dirname, 'rls-policies.sql');
  writeFileSync(path, withFreshBlock(readFileSync(path, 'utf8')));
}
