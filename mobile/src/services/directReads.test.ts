import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * No screen or service reads another person's data straight from Supabase.
 *
 * Every read of a person goes through the gateway, which records it in the
 * read log (Läslogg), and a migration will take PostgREST's SELECT on these
 * tables away from `authenticated` for anything but the reader's own rows. A
 * direct read left behind would first escape the log and then, once the
 * grant goes, quietly answer nothing on a phone that has no store build to
 * replace. So the sources are read instead of trusted: a `.from('<table>')`
 * on one of these tables, an embed of one in a `.select('…')`, or a `.from`
 * whose table is not written out where this test can read it, fails. The one
 * read that stays is the signed-in person's own profile (authService), and it
 * must stay their own: filtered by their auth id.
 *
 * Writes count too: an insert or a delete through PostgREST is no more logged
 * than a read, and the gateway is where the school and the reporter are
 * derived rather than taken from the phone.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ts = require('typescript') as typeof import('typescript');

const PERSONAL = [
  'Users',
  'AttendanceRecords',
  'AbsenceReports',
  'LeaveRequests',
  'GuardianStudents',
  'StudentGroupMembers',
  // 20261028090000: the staff and timplan tables the gateway records.
  'TeacherAbsences',
  'TeacherAbsenceCovers',
  'TeacherEmployments',
  'TeacherEmploymentLogs',
  // 20261022120000: a post's periods, closed to PostgREST from the start.
  'TeacherEmploymentPeriods',
  'TeacherDuties',
  'StudentEnrollments',
  'TimplanStatements',
  'Ss12000SyncChanges',
] as const;

// `student:Users!fk(…)`, `Users(…)`: an embedded table in a select string.
const EMBED = new RegExp(`\\b(${PERSONAL.join('|')})\\s*[!(]`, 'g');

const ROOT = path.join(__dirname, '..', '..');
const DIRS = [path.join(ROOT, 'src'), path.join(ROOT, 'app')];

interface TableAccess {
  readonly file: string;
  readonly line: number;
  /** null: the table is not a literal, so nobody reading the source can tell which it is. */
  readonly table: string | null;
  readonly how: 'from' | 'embed';
  /** The whole call chain, getSupabase().from(…).select(…).eq(…). */
  readonly chain: string;
}

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

function literal(node: import('typescript').Node | undefined): string | null {
  if (!node) return null;
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : null;
}

function chainOf(node: import('typescript').Node): import('typescript').Node {
  let top = node;
  while (
    ts.isPropertyAccessExpression(top.parent) ||
    (ts.isCallExpression(top.parent) && top.parent.expression === top)
  ) {
    top = top.parent;
  }
  return top;
}

/**
 * Every PostgREST table access in one source: `x.from(…)` where x is a client
 * (a call such as getSupabase(), or a variable holding one) and not a
 * constructor's static such as Array.from or Buffer.from, and every personal
 * table embedded in a `.select(…)` string.
 */
function tableAccesses(file: string, source: string): TableAccess[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const found: TableAccess[] = [];
  const visit = (node: import('typescript').Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression;
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const chain = (): string => chainOf(node).getText(sourceFile);
      if (method === 'from' && !(ts.isIdentifier(receiver) && /^[A-Z]/.test(receiver.text))) {
        found.push({ file, line, table: literal(node.arguments[0]), how: 'from', chain: chain() });
      }
      if (method === 'select') {
        for (const argument of node.arguments) {
          for (const match of (literal(argument) ?? '').matchAll(EMBED)) {
            found.push({ file, line, table: match[1]!, how: 'embed', chain: chain() });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

const relative = (file: string): string => path.relative(ROOT, file).split(path.sep).join('/');
const isPersonal = (access: TableAccess): boolean =>
  access.table !== null && (PERSONAL as readonly string[]).includes(access.table);

describe('the detector', () => {
  it('finds a personal table read from a client, a variable or an embed, and an unnamed table', () => {
    const found = tableAccesses(
      'probe.ts',
      [
        "getSupabase().from('GuardianStudents').select('id').eq('guardianId', g);",
        'supabase.from("AttendanceRecords").insert(row);',
        'client.schema(`public`).from(`StudentGroupMembers`).delete();',
        "getSupabase().from('CalendarLessonTeachers').select('lesson:CalendarLessons!inner(id), teacher:Users!fk(firstName)');",
        'getSupabase().from(table).select();',
        'Array.from(rows); Buffer.from(bytes); Object.fromEntries(pairs);',
      ].join('\n'),
    );
    expect(found.map((access) => [access.line, access.how, access.table])).toEqual([
      [1, 'from', 'GuardianStudents'],
      [2, 'from', 'AttendanceRecords'],
      [3, 'from', 'StudentGroupMembers'],
      // The outer .select(…) call is met before the .from(…) inside it.
      [4, 'embed', 'Users'],
      [4, 'from', 'CalendarLessonTeachers'],
      [5, 'from', null],
    ]);
    expect(found[0]!.chain).toBe("getSupabase().from('GuardianStudents').select('id').eq('guardianId', g)");
  });
});

describe('direct reads of personal data', () => {
  const accesses = DIRS.flatMap(sources).flatMap((file) => tableAccesses(file, fs.readFileSync(file, 'utf8')));

  it('reads the sources it guards: the tables that stay on Supabase are seen', () => {
    // A guard that scans nothing passes everything. These are the reads that
    // stay direct (own notices, the schedule tables), so they must be found.
    const tables = new Set(accesses.map((access) => access.table));
    for (const table of ['Notifications', 'CalendarLessons', 'CalendarLunches', 'CalendarRasts', 'CalendarLessonTeachers']) {
      expect(tables).toContain(table);
    }
  });

  it('names every table it reads where the source can be read', () => {
    expect(accesses.filter((access) => access.table === null).map((access) => `${relative(access.file)}:${access.line}`)).toEqual([]);
  });

  it('leaves only the signed-in person’s own profile on Supabase', () => {
    const personal = accesses.filter(isPersonal);
    expect(personal.map((access) => `${relative(access.file)} ${access.how} ${access.table}`)).toEqual([
      'src/services/auth/authService.ts from Users',
    ]);
    // Their own row, by the auth id of the session they just signed in with,
    // and only the id and the role.
    const [own] = personal;
    expect(own!.chain).toMatch(/\.eq\(\s*'authId',\s*authId\s*\)/);
    expect(own!.chain).toMatch(/\.select\(\s*'id, role'\s*\)/);
    expect(own!.chain).toMatch(/\.maybeSingle\b/);
  });
});
