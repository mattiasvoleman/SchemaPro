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
 *     a read of any model that selects or filters through a group's members
 *     (`members`, `teachingMembers`) or a pupil's (`groupMemberships`), or
 *     raw SQL over either;
 *  2. a Users roster query, or a members relation read, outside
 *     projected-rosters.ts in a file classified PROJECTED — its home side must
 *     go through the helpers, so CURRENT runs the reader's own query and
 *     PROJECTED lays the overlay over it;
 *  3. a literal `kind: 'CURRENT'` basis outside projected-rosters.ts — a
 *     reader that builds its own CURRENT reads empty classes for a rolled
 *     year without anybody deciding so;
 *  4. a controller route that reaches rostersOfYear whose roles are not
 *     within SCHOOL_ADMIN and TEACHER: under a pupil's or a guardian's RLS
 *     the projection's school-wide reads degenerate to the caller's own row;
 *  5. a change in the set of routes that reach rostersOfYear. Each of them
 *     answers R6's 409 ROLLOVER_NOT_ACTIVATED for a year two steps ahead, or
 *     for a rolled year in a school with no active year — reports and the
 *     staffing checks too, not only the six sites that refused before the
 *     projection. A route that joins the list starts refusing, and one that
 *     leaves it stops; either is a decision, so the list is written out.
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
  'src/publication/publication-gates.reader.ts': {
    basis: 'PROJECTED',
    why: 'PUB_CLASHES: pupils shared between groups, the board’s question asked of the whole year; memberships as they are',
  },
  'src/publication/public-links.service.ts': {
    basis: 'CURRENT',
    why: 'whether a share link answers: app.public_timetable counts a teaching group’s active members as they are, so the list asks the same',
  },
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
  'src/timplan/timplan-stage.service.ts': {
    basis: 'CURRENT',
    why: 'stage totals: home classes from the class history (ENROLLED, below); teaching-group memberships as they are — they carry no dates — for the pupils the history names',
  },
  'src/realtime/realtime.service.ts': {
    basis: 'CURRENT',
    why: 'pushes a dated lesson’s change to the people in its classes and groups as they are now',
  },
  'src/family/family-schedule.service.ts': {
    basis: 'CURRENT',
    why: 'one child’s published week for the family: the child’s own row and teaching groups as they are; the home class only on dates its class history (ENROLLED) names',
  },
};

/**
 * Every file of src/ that reads the class history (StudentEnrollments, timplan
 * P4), and why. Its own basis, ENROLLED — who sat where, as recorded — beside
 * the three above: a past year's rosters read from the history are neither the
 * rows as they are now (CURRENT) nor the activation's projection (PROJECTED),
 * and a reader that started reading it without anybody deciding so would mix
 * a recorded year with a present one.
 */
const ENROLLED: Record<string, string> = {
  'src/resources/student-groups.service.ts': 'a class with history keeps its läsår: counted before a year change (409 STUDENT_GROUP_HAS_ENROLMENT_HISTORY)',
  'src/timplan/timplan-coverage.service.ts':
    'a past year’s rosters for planned and delivered coverage, when the history has rows for it (enrolmentBasisOf); rostersOfYear otherwise',
  'src/timplan/timplan-stage.service.ts':
    'stage totals: the active year’s pupils (their open segments) and every year they sat in, window by window; no roster basis is asked',
  'src/family/family-schedule.service.ts':
    'one child’s segments over one week: a lesson matched only through the home class is shown on the days the history names that class',
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
  model: 'user' | 'studentGroupMember' | 'relation' | 'raw';
  call: string;
}

/** A group's members or a pupil's memberships, selected, included or filtered through. */
const MEMBERS_RELATION = /\b(members|teachingMembers|groupMemberships)\s*:/;

function rosterQueries(): RosterQuery[] {
  const found: RosterQuery[] = [];
  for (const { path, text } of files) {
    const prisma = /\b(\w+)\.(findMany|findFirst|findUnique|findUniqueOrThrow|findFirstOrThrow|count|groupBy|aggregate)\(/g;
    for (let match = prisma.exec(text); match; match = prisma.exec(text)) {
      const call = callAt(text, match.index, match.index + match[0].length - 1);
      const line = text.slice(0, match.index).split('\n').length;
      if (match[1] === 'studentGroupMember' || (match[1] === 'user' && /studentGroup/.test(call))) {
        found.push({ path, line, model: match[1] as RosterQuery['model'], call });
      } else if (MEMBERS_RELATION.test(call)) {
        // A roster read through a relation: the home class's members, a
        // teaching group's, or a pupil's memberships, from any model.
        found.push({ path, line, model: 'relation', call });
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
    // The relation reads too: realtime's members selects, SS12000's, and the
    // share-link list's count of a teaching group's members.
    const relations = new Set(queries.filter((query) => query.model === 'relation').map((query) => query.path));
    expect(relations).toEqual(
      new Set(['src/realtime/realtime.service.ts', 'src/integration/ss12000.service.ts', 'src/publication/public-links.service.ts']),
    );
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

  it('has every read of the class history in a file classified ENROLLED', () => {
    const readers = new Set<string>();
    for (const { path, text } of files) {
      if (/\bstudentEnrollment\.(findMany|findFirst|findUnique|findUniqueOrThrow|findFirstOrThrow|count|groupBy|aggregate)\(/.test(text)) {
        readers.add(path);
      }
      // Raw SQL over the table: a $queryRaw or a Prisma.sql template naming it.
      if (/(?:\$queryRaw|Prisma\.sql)[^`]*`[^`]*"StudentEnrollments"/.test(text)) readers.add(path);
    }
    expect([...readers].sort()).toEqual(Object.keys(ENROLLED).sort());
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

    it('is exactly the routes that answer R6’s 409 (the decision, written out)', () => {
      // Some answer it only when they compute a basis: a timplanspost or an
      // import when the staffing checks run, a vikarie when behörighet is
      // asked. StaffingLoadController.unstaffed reads the load input like
      // the report it is opened from, and .delivered (staffing Fas 3) reads
      // it for the planned column of the reconciliation. The staffing
      // proposal (Fas 4) reads it for every row's grade span, in propose and
      // again under apply's locks, so a rolled year two steps ahead is refused
      // there as everywhere else.
      //
      // Publicering's gates ask the timplan layers and, under a REFUSE staffing
      // mode, the load report, so a preview or a publish of a year two steps
      // ahead answers the 409 those pages answer. The old POST /calendar/publish
      // reaches them only for a school that has set a gate to REFUSE; with
      // every gate at its default WARN it asks nothing and refuses nothing.
      //
      // Vikarieplanering's board reaches a basis where a vikarie does: a
      // SUBSTITUTE decision (decide, and apply and bulk through the same
      // decision) asks behörighet through assignInTransaction, and the
      // candidates and the day proposal ask the grade span of each lesson to
      // rank behörighet. They are admin routes over published lessons of the
      // running year, so a year two steps ahead answering R6's 409 there is
      // the same answer the old vikarie PATCH gives.
      expect(reached.map((entry) => entry.route).sort()).toEqual([
        'CalendarController.publish',
        'CalendarLessonsController.assignSubstitute',
        'CalendarLessonsController.suggestSubstitutes',
        'CoverController.apply',
        'CoverController.bulk',
        'CoverController.candidates',
        'CoverController.decide',
        'CoverController.proposal',
        'ImportController.importRequirements',
        'LunchSittingsController.place',
        'MasterLessonsController.create',
        'MasterLessonsController.update',
        'OptimizationController.applyRooms',
        'OptimizationController.applyStaffing',
        'OptimizationController.proposeRooms',
        'OptimizationController.proposeStaffing',
        'OptimizationController.startJob',
        'OptimizationController.trigger',
        'PublicationsController.preview',
        'PublicationsController.publish',
        'StaffingLoadController.delivered',
        'StaffingLoadController.load',
        'StaffingLoadController.suggestTeachers',
        'StaffingLoadController.unstaffed',
        'TeachingRequirementsController.create',
        'TeachingRequirementsController.update',
        'TimplanCoverageController.get',
        'YearRolloverController.rosters',
      ]);
    });

    it('admits only SCHOOL_ADMIN and TEACHER on every one of them', () => {
      const wider = reached.filter((entry) => entry.roles.length === 0 || entry.roles.some((role) => !STAFF.has(role)));
      expect(wider).toEqual([]);
    });
  });
});
