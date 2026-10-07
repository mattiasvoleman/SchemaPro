import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

/**
 * WHO READS A ROSTER, AND ON WHICH BASIS.
 *
 * Förberäknade klasslistor hold only while every roster read of a läsår goes
 * through its basis (projected-rosters.ts) — or is CURRENT on purpose. This
 * spec reads src/ (not the specs) and fails on:
 *
 *  1. a roster query in a file nobody has classified: a Users read or count
 *     whose arguments mention the home class, any StudentGroupMembers read,
 *     or raw SQL over either;
 *  2. a Users roster query outside projected-rosters.ts in a file classified
 *     PROJECTED — its home side must go through the helpers, so CURRENT runs
 *     the reader's own query and PROJECTED lays the overlay over it;
 *  3. a literal `kind: 'CURRENT'` basis outside projected-rosters.ts — a
 *     reader that builds its own CURRENT reads empty classes for a rolled
 *     year without anybody deciding so;
 *  4. a controller route that reaches rostersOfYear whose roles are not
 *     within SCHOOL_ADMIN and TEACHER: under a pupil's or a guardian's RLS
 *     the projection's school-wide reads degenerate to the caller's own row.
 */

const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'src');

type Basis = 'PROJECTED' | 'CURRENT' | 'SOURCE';

/** Every file of src/ that reads a roster, and why on that basis. */
const CLASSIFIED: Record<string, { basis: Basis; why: string }> = {
  'src/year-rollover/projected-rosters.ts': { basis: 'PROJECTED', why: 'the read helpers themselves' },
  'src/optimization/room-eligibility.ts': {
    basis: 'PROJECTED',
    why: 'loadRosters: generation, room proposals, the load report and attendanceSpan; memberships are read as they are, the activation does not touch them',
  },
  'src/calendar/master-lessons.service.ts': {
    basis: 'PROJECTED',
    why: 'pupil clashes of a lesson placed by hand; rosterOf reads memberships as they are',
  },
  'src/timplan/timplan-coverage.service.ts': { basis: 'PROJECTED', why: 'planned coverage; memberships as they are' },
  'src/year-rollover/activation-plan.ts': { basis: 'SOURCE', why: 'what the projection and the activation are computed from' },
  'src/year-rollover/rollover-source.ts': {
    basis: 'SOURCE',
    why: 'the rollover reads its own source year; ROLLOVER_SOURCE_NOT_ACTIVATED refuses a source whose pupils have not moved in',
  },
  'src/attendance/attendance.service.ts': { basis: 'CURRENT', why: 'real people at dated lessons, and it writes rows' },
  'src/notifications/notifications.service.ts': {
    basis: 'CURRENT',
    why: 'writes notices and email; nobody is told about next year’s class before the activation',
  },
  'src/integration/ss12000.service.ts': { basis: 'CURRENT', why: 'an external export, of the active year by design' },
  'src/resources/academic-years.service.ts': { basis: 'CURRENT', why: 'YEAR_HAS_HOME_PUPILS guards real rows' },
  'src/resources/student-groups.service.ts': { basis: 'CURRENT', why: 'shows and writes a group’s members as facts' },
  'src/users/users.service.ts': { basis: 'CURRENT', why: 'a user’s own class, read before it is written' },
};

const STAFF = new Set(['SCHOOL_ADMIN', 'TEACHER']);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) out.push(path);
  }
  return out;
}

const files = sourceFiles(SRC).map((path) => ({
  path: relative(ROOT, path),
  text: readFileSync(path, 'utf8'),
}));

/** The text of a call from `start` (its callee) to its balanced closing parenthesis. */
function callAt(text: string, start: number, open: number): string {
  let depth = 1;
  let at = open + 1;
  while (depth > 0 && at < text.length) {
    if (text[at] === '(') depth++;
    else if (text[at] === ')') depth--;
    at++;
  }
  return text.slice(start, at);
}

interface RosterQuery {
  path: string;
  line: number;
  model: 'user' | 'studentGroupMember' | 'raw';
  call: string;
}

function rosterQueries(): RosterQuery[] {
  const found: RosterQuery[] = [];
  for (const { path, text } of files) {
    const prisma = /\b(user|studentGroupMember)\.(findMany|findFirst|findUnique|count|groupBy|aggregate)\(/g;
    for (let match = prisma.exec(text); match; match = prisma.exec(text)) {
      const call = callAt(text, match.index, match.index + match[0].length - 1);
      if (match[1] === 'studentGroupMember' || /studentGroup/.test(call)) {
        found.push({ path, line: text.slice(0, match.index).split('\n').length, model: match[1] as RosterQuery['model'], call });
      }
    }
    const raw = /\$queryRaw[^`]*`([^`]*)`/g;
    for (let match = raw.exec(text); match; match = raw.exec(text)) {
      if (/"Users"[\s\S]*"studentGroupId"|"studentGroupId"[\s\S]*"Users"|"StudentGroupMembers"/.test(match[1]!)) {
        found.push({ path, line: text.slice(0, match.index).split('\n').length, model: 'raw', call: match[0] });
      }
    }
  }
  return found;
}

describe('the roster-reader inventory', () => {
  const queries = rosterQueries();

  it('finds the roster queries it is meant to (the scan itself works)', () => {
    const where = new Set(queries.map((query) => query.path));
    for (const path of ['src/year-rollover/projected-rosters.ts', 'src/year-rollover/activation-plan.ts', 'src/attendance/attendance.service.ts']) {
      expect(where).toContain(path);
    }
  });

  it('has every roster query in a classified file', () => {
    const unclassified = queries
      .filter((query) => !(query.path in CLASSIFIED))
      .map((query) => `${query.path}:${query.line} ${query.call.replace(/\s+/g, ' ').slice(0, 120)}`);
    expect(unclassified).toEqual([]);
  });

  it('reads the home class only through the helpers in a PROJECTED file', () => {
    const direct = queries
      .filter(
        (query) =>
          CLASSIFIED[query.path]?.basis === 'PROJECTED' &&
          query.path !== 'src/year-rollover/projected-rosters.ts' &&
          query.model !== 'studentGroupMember',
      )
      .map((query) => `${query.path}:${query.line}`);
    expect(direct).toEqual([]);
    for (const [path, entry] of Object.entries(CLASSIFIED)) {
      if (entry.basis !== 'PROJECTED' || path === 'src/year-rollover/projected-rosters.ts') continue;
      expect([path, files.find((file) => file.path === path)!.text.includes('year-rollover/projected-rosters')]).toEqual([path, true]);
    }
  });

  it('builds a CURRENT basis nowhere but in projected-rosters.ts', () => {
    const literal = /kind\s*:\s*['"]CURRENT['"]/;
    const builders = files
      .filter((file) => file.path !== 'src/year-rollover/projected-rosters.ts' && literal.test(file.text))
      .map((file) => file.path);
    expect(builders).toEqual([]);
  });

  describe('the routes that reach a projection', () => {
    /**
     * A name-level call graph of src/: a function is known by its name, a
     * method by Class.method, and a call `this.field.method()` by the type of
     * the constructor parameter `field`. Reaching is a fixpoint from
     * rostersOfYear. Over-approximating a name is fine; missing a call is
     * what the expected routes below guard against.
     */
    function reachingRoutes(): { route: string; roles: string[] }[] {
      const declarations = new Map<string, Set<string>>();
      const routes: { route: string; roles: string[]; key: string }[] = [];
      const calleeNames = (body: ts.Node, fields: Map<string, string>, className: string | null): Set<string> => {
        const names = new Set<string>();
        const visit = (node: ts.Node) => {
          if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
            const callee = node.expression;
            if (ts.isIdentifier(callee)) names.add(callee.text);
            else if (ts.isPropertyAccessExpression(callee)) {
              const target = callee.expression;
              const method = callee.name.text;
              if (target.kind === ts.SyntaxKind.ThisKeyword && className) names.add(`${className}.${method}`);
              else if (ts.isPropertyAccessExpression(target) && target.expression.kind === ts.SyntaxKind.ThisKeyword) {
                const type = fields.get(target.name.text);
                if (type) names.add(`${type}.${method}`);
              } else if (ts.isIdentifier(target)) names.add(`${target.text}.${method}`);
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(body);
        return names;
      };
      const decoratorsOf = (node: ts.Node) => (ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : []);
      const decoratorCall = (node: ts.Node, name: string) =>
        decoratorsOf(node)
          .map((decorator) => decorator.expression)
          .find((expression): expression is ts.CallExpression => ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === name);
      const rolesOf = (call: ts.CallExpression | undefined) =>
        call ? call.arguments.map((argument) => argument.getText().replace(/^Role\./, '')) : null;

      for (const { path, text } of files) {
        const file = ts.createSourceFile(path, text, ts.ScriptTarget.ES2021, true);
        for (const statement of file.statements) {
          if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
            declarations.set(statement.name.text, calleeNames(statement.body, new Map(), null));
          }
          if (ts.isVariableStatement(statement)) {
            for (const declaration of statement.declarationList.declarations) {
              if (ts.isIdentifier(declaration.name) && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
                declarations.set(declaration.name.text, calleeNames(declaration.initializer, new Map(), null));
              }
            }
          }
          if (ts.isClassDeclaration(statement) && statement.name) {
            const className = statement.name.text;
            const fields = new Map<string, string>();
            for (const member of statement.members) {
              if (ts.isConstructorDeclaration(member)) {
                for (const parameter of member.parameters) {
                  if (ts.isIdentifier(parameter.name) && parameter.type && ts.isTypeReferenceNode(parameter.type)) {
                    fields.set(parameter.name.text, parameter.type.typeName.getText());
                  }
                }
              }
            }
            const controller = decoratorCall(statement, 'Controller');
            const classRoles = rolesOf(decoratorCall(statement, 'Roles'));
            for (const member of statement.members) {
              if (!ts.isMethodDeclaration(member) || !member.body || !ts.isIdentifier(member.name)) continue;
              const key = `${className}.${member.name.text}`;
              declarations.set(key, calleeNames(member.body, fields, className));
              const verb = ['Get', 'Post', 'Patch', 'Put', 'Delete'].find((name) => decoratorCall(member, name));
              if (controller && verb) {
                routes.push({ key, route: `${className}.${member.name.text}`, roles: rolesOf(decoratorCall(member, 'Roles')) ?? classRoles ?? [] });
              }
            }
          }
        }
      }

      const reaching = new Set(['rostersOfYear']);
      for (let grew = true; grew; ) {
        grew = false;
        for (const [name, callees] of declarations) {
          if (reaching.has(name)) continue;
          if ([...callees].some((callee) => reaching.has(callee))) {
            reaching.add(name);
            grew = true;
          }
        }
      }
      return routes.filter((route) => reaching.has(route.key)).map(({ route, roles }) => ({ route, roles }));
    }

    const reached = reachingRoutes();

    it('finds the routes it is meant to (the call graph itself works)', () => {
      const names = reached.map((entry) => entry.route);
      expect(names).toEqual(
        expect.arrayContaining([
          'OptimizationController.startJob',
          'OptimizationController.proposeRooms',
          'OptimizationController.applyRooms',
          'MasterLessonsController.create',
          'MasterLessonsController.update',
          'CalendarLessonsController.assignSubstitute',
          'CalendarLessonsController.suggestSubstitutes',
          'StaffingLoadController.load',
          'StaffingLoadController.suggestTeachers',
          'TeachingRequirementsController.create',
          'TeachingRequirementsController.update',
          'ImportController.importRequirements',
          'LunchSittingsController.place',
          'TimplanCoverageController.get',
          'YearRolloverController.rosters',
        ]),
      );
    });

    it('admits only SCHOOL_ADMIN and TEACHER on every one of them', () => {
      const wider = reached.filter((entry) => entry.roles.length === 0 || entry.roles.some((role) => !STAFF.has(role)));
      expect(wider).toEqual([]);
    });
  });
});
