import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * A PostgREST embed that names its foreign key — `student:Users!GuardianStudents_studentId_fkey(…)` —
 * is a contract with the database that no type checks. Migration 20260822090000 replaced the
 * single-column guardian/student keys with tenant-scoped composite ones, and two embeds kept the old
 * names: PostgREST answered 400 PGRST200 and "Mina barn" could not list a guardian's children.
 *
 * This replays every migration's ADD/DROP/RENAME CONSTRAINT in order to get the foreign keys that
 * exist today, then requires every `!<name>_fkey` hint in the web code to be one of them.
 */
const WEB = path.resolve(__dirname, "..");
const MIGRATIONS = path.resolve(WEB, "..", "prisma", "migrations");

function liveForeignKeys(): Set<string> {
  const live = new Set<string>();
  const dirs = readdirSync(MIGRATIONS)
    .filter((d) => statSync(path.join(MIGRATIONS, d)).isDirectory())
    .sort();
  for (const dir of dirs) {
    const sql = readFileSync(path.join(MIGRATIONS, dir, "migration.sql"), "utf8");
    const events: Array<{ at: number; apply: () => void }> = [];
    for (const m of sql.matchAll(/(?:ADD\s+)?CONSTRAINT\s+"([^"]+_fkey)"\s+FOREIGN\s+KEY/gi)) {
      const name = m[1];
      events.push({ at: m.index ?? 0, apply: () => live.add(name) });
    }
    for (const m of sql.matchAll(/DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"([^"]+_fkey)"/gi)) {
      const name = m[1];
      events.push({ at: m.index ?? 0, apply: () => live.delete(name) });
    }
    for (const m of sql.matchAll(/RENAME\s+CONSTRAINT\s+"([^"]+_fkey)"\s+TO\s+"([^"]+_fkey)"/gi)) {
      const [from, to] = [m[1], m[2]];
      events.push({ at: m.index ?? 0, apply: () => { live.delete(from); live.add(to); } });
    }
    events.sort((a, b) => a.at - b.at).forEach((e) => e.apply());
  }
  return live;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("PostgREST embeds name foreign keys that exist", () => {
  it("knows the guardian links' composite keys from the migrations", () => {
    const live = liveForeignKeys();
    expect(live.has("GuardianStudents_studentId_schoolId_fkey")).toBe(true);
    expect(live.has("GuardianStudents_studentId_fkey")).toBe(false);
  });

  it("every !<constraint> hint in the web code is a live foreign key", () => {
    const live = liveForeignKeys();
    const stale: string[] = [];
    for (const dir of ["lib", "app", "components"]) {
      for (const file of sourceFiles(path.join(WEB, dir))) {
        const text = readFileSync(file, "utf8");
        for (const m of text.matchAll(/![A-Za-z]+_[A-Za-z_]+_fkey/g)) {
          const name = m[0].slice(1);
          if (!live.has(name)) stale.push(`${path.relative(WEB, file)}: ${name}`);
        }
      }
    }
    expect(stale).toEqual([]);
  });
});
