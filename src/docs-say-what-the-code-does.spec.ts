import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * THE DOCUMENTS THAT DESCRIBE THE PRODUCT, HELD TO WHAT THE REPOSITORY HOLDS (omgång 15, Q1 "Dokumenten säger rätt").
 *
 * PRODUCT.md, the baseline, the deployment runbook and the README were written in July and October and each said
 * things the code had since overtaken: "one Administratör role per school, with no huvudman level" while the schema
 * had five profiles and a huvudman; "Reduced motion is not honoured" beside a media query that honours it; a
 * scorecard of "six of eleven" over fifteen rows; a table of times "at the production settings" that were not
 * production's. Nobody reads a document against the code until a buyer does, so this does it: a claim a document made
 * is tested against the file that decides it, and when the file moves the test names the document to read again.
 *
 * It is not a proof that the documents are right. It holds the claims that were wrong, and the arithmetic and the
 * numbers that can be read off a file, and it says nothing of the rest. It reads files and imports nothing from
 * src/, so Stryker's sandbox needs none of them (a spec that imports no mutated file is no slice's).
 */

const ROOT = join(__dirname, '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const flat = (text: string): string => text.replace(/\s+/g, ' ');

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
const word = (n: number): string => NUMBER_WORDS[n] ?? String(n);
const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

const product = flat(read('PRODUCT.md'));
const baseline = read('docs/verification-baseline.md');
const deployment = read('docs/DEPLOYMENT.md');

describe('PRODUCT.md says what the schema, the gateway, the web and the app hold', () => {
  it('names the administrator profiles the schema has, and no huvudman level missing', () => {
    const schema = read('prisma/schema.prisma');
    const profiles = /enum AdminProfile \{([^}]*)\}/.exec(schema);
    if (profiles === null) throw new Error('prisma/schema.prisma no longer has enum AdminProfile; read PRODUCT.md "What the roles are" again');
    const count = profiles[1]!.split('\n').filter((line) => /^\s*[A-Z_]+\s*$/.test(line)).length;

    expect(product).toContain(`Administratör is one role with ${word(count)} profiles`);
    expect(product).not.toContain('with no huvudman level');
    expect(product).not.toContain('Not modelled yet');
    expect(schema).toContain('model Huvudman {');
    expect(product).toContain("A huvudman (a kommun or a friskola's owner) owns schools");
  });

  it('says the school account is built, since the gateway has its controller', () => {
    expect(read('src/sign-in/sign-in-methods.controller.ts')).toContain("@Controller('public/v1/sign-in-methods')");
    expect(product).not.toContain('Sign-in is by e-mail and password only');
    expect(product).toContain('a school account (Microsoft Entra ID or Google Workspace)');
  });

  it('does not say the generator lacks blocks, A/B weeks, a daily cap or a spread of subjects', () => {
    const schema = read('prisma/schema.prisma');
    expect(schema).toContain('ODD_WEEKS');
    expect(schema).toContain('EVEN_WEEKS');
    expect(schema).toContain('model TeachingBlock {');
    expect(schema).toContain('maxTeachingMinutesPerDay');
    expect(product).not.toContain('The generator does not model');
    expect(product).not.toContain('It reserves alternating lessons every week');
    expect(product).toContain('The generator models parallel blocks');
  });

  it('says a login can belong to several schools, since the gateway has the route', () => {
    const controller = read('src/users/me.controller.ts');
    expect(controller).toContain("@Controller('api/v1/me')");
    expect(controller).toContain("@Get('schools')");
    expect(product).not.toContain('logs in to each separately');
    expect(product).toContain('A login can belong to several schools');
  });

  it('says what the apps have of the administration: the Krisläge view and nothing else', () => {
    expect(read('mobile/src/screens/crisis/CrisisAdminView.tsx')).toContain('export function CrisisAdminView');
    expect(product).not.toMatch(/have no admin\b/);
    expect(product).toContain('have no administration beyond Krisläge');
  });

  it('does not say what the web has since done: reduced motion, the drawer, the signed-in scan', () => {
    expect(read('web/app/globals.css')).toContain('@media (prefers-reduced-motion: reduce)');
    expect(product).not.toContain('Reduced motion is not honoured');

    const shell = read('web/components/layout/app-shell.tsx');
    expect(shell).toContain('event.key === "Escape"');
    expect(shell).toContain('event.key !== "Tab"');
    expect(product).not.toContain('no focus trap or Escape handling');

    expect(read('web/e2e/a11y-app.spec.ts').length).toBeGreaterThan(1000);
    expect(product).not.toContain('Signed-in screens are not scanned automatically');
  });

  it("gives the count of CI's `a11y` project to the project, not to the one spec file that is part of it", () => {
    // The project runs three files (the signed-in pages, the public pages with the keyboard checks, and the accessibility trees).
    expect(read('web/playwright.config.ts')).toContain('testMatch: /(a11y|a11y-app|aria)\\.spec\\.ts/');
    expect(product).not.toMatch(/a11y-app\.spec\.ts`, \d+ tests/);
    expect(product).toContain("CI's `a11y` project");
    expect(baseline).toContain("290 tests in CI's `a11y` project");
  });

  it('gives each manual the edition its own page prints', () => {
    for (const [file, label] of [
      ['anvandarmanual', 'docs/manual/anvandarmanual.html'],
      ['lararmanual', 'docs/manual/lararmanual.html'],
      ['vardnadshavarmanual', 'docs/manual/vardnadshavarmanual.html'],
    ] as const) {
      const edition = /Utgåva (\d+\.\d+)/.exec(read(`docs/manual/${file}.html`));
      if (edition === null) throw new Error(`${label} prints no edition`);
      expect(product).toContain(`docs/manual/${file}.html\` (${file === 'anvandarmanual' ? 'utgåva ' : ''}${edition[1]}`);
    }
  });
});

describe('the user manual says what leaves the system about a teacher’s own absence report (K6)', () => {
  const manual = flat(read('docs/manual/anvandarmanual.html'));

  it('does not say the notice is never mailed, since an administrator is offered the mail', () => {
    expect(read('src/notifications/notification-types.ts')).toMatch(/SCHOOL_ADMIN: \[[^\]]*'TEACHER_ABSENCE_REPORTED'/);
    expect(manual).not.toContain('den mejlas inte');
    expect(manual).toContain('En lärare har anmält frånvaro</em> skickas aldrig som push. Den kan mejlas till skolans administratörer');
  });
});

describe('the baseline counts its own scorecard, and PRODUCT.md quotes the count', () => {
  const scorecard = baseline.slice(baseline.indexOf('## Scorecard'), baseline.indexOf('## Where the harness stands'));
  const rows = scorecard.split('\n').filter((line) => /^\| (?!Gate\b|:?-)/.test(line));
  const count = (mark: string): number => rows.filter((row) => row.split('|')[2]!.trim().startsWith(mark)).length;

  it('has the rows it counts', () => {
    expect(rows.length).toBeGreaterThanOrEqual(15);
    expect(count('✓') + count('✗') + count('—')).toBe(rows.length);
  });

  it('says how many pass, fail and are not measured', () => {
    expect(flat(scorecard)).toContain(
      `${capital(word(count('✓')))} of ${word(rows.length)} rows pass (2026-11-25). ${capital(word(count('✗')))} have a harness`,
    );
    expect(flat(scorecard)).toContain(`and ${word(count('—'))} are not measured`);
  });

  it('is quoted the same by PRODUCT.md', () => {
    expect(product).toContain(
      `${capital(word(count('✓')))} of ${word(rows.length)} rows pass, ${word(count('✗'))} fail against a measured number and ${word(count('—'))} are not measured`,
    );
  });
});

describe('the baseline holds the floors and the budgets the code holds', () => {
  const floorOf = (source: string, name: string): number => {
    const found = new RegExp(`floor\\(['"]${name}['"], (\\d+)\\)`).exec(source);
    if (found === null) throw new Error(`${name} is no longer a floor(...) in its config; read the baseline's floors again`);
    return Number(found[1]);
  };
  const floors = flat(baseline);

  it('API: jest.base.js', () => {
    const base = read('jest.base.js');
    const [lines, statements, functions, branches] = ['LINES', 'STATEMENTS', 'FUNCTIONS', 'BRANCHES'].map((metric) => floorOf(base, `COVERAGE_MIN_${metric}`));
    expect(floors).toContain(`lines ${lines}, statements ${statements}, functions ${functions} and branches ${branches}`);
  });

  it('web: vitest.config.ts', () => {
    const config = read('web/vitest.config.ts');
    const [lines, statements, functions, branches] = ['LINES', 'STATEMENTS', 'FUNCTIONS', 'BRANCHES'].map((metric) => floorOf(config, `WEB_COVERAGE_MIN_${metric}`));
    expect(floors).toContain(`lines ${lines}, statements ${statements}, functions ${functions} and branches ${branches}`);
  });

  it('mobile: jest.config.js', () => {
    const found = /global: \{ statements: (\d+), lines: (\d+), functions: (\d+), branches: (\d+) \}/.exec(read('mobile/jest.config.js'));
    if (found === null) throw new Error("mobile/jest.config.js's coverageThreshold no longer reads as the baseline expects");
    expect(floors).toContain(`statements ${found[1]}, lines ${found[2]}, functions ${found[3]} and branches ${found[4]}`);
  });

  it('the bundle: the tiers and the shared runtime of scripts/bench/bundle-size.mjs', () => {
    const script = read('scripts/bench/bundle-size.mjs');
    const shared = /const SHARED_BUDGET_KB = (\d+);/.exec(script);
    if (shared === null) throw new Error('bundle-size.mjs no longer has SHARED_BUDGET_KB');
    expect(baseline).toContain(`| Shared framework runtime | ≤ ${shared[1]}KB`);

    const tiers = new Map([...script.matchAll(/name: '(\w+)',\s*budgetKb: (\d+)/g)].map((match) => [match[1]!, Number(match[2])] as const));
    expect(tiers.size).toBeGreaterThanOrEqual(6);
    for (const [name, label] of [
      ['admin', 'admin tier'],
      ['core', 'core tier'],
      ['auth', 'auth tier'],
      ['system', 'system tier'],
      ['public', 'public tier (Schemavisaren)'],
      ['other', 'other tier'],
    ] as const) {
      expect(baseline).toContain(`| Route-own JS, ${label} | ≤ ${tiers.get(name)}KB |`);
    }
  });
});

describe('DEPLOYMENT.md', () => {
  /** The table of section 5.1 as rows of cells, the header first. */
  const chain = (): string[][] => {
    const start = deployment.indexOf('| Time | At a ');
    const end = deployment.indexOf('\n\n', start);
    if (start < 0) throw new Error('DEPLOYMENT.md 5.1 no longer has its table of times with a budget in each column');
    return deployment
      .slice(start, end)
      .split('\n')
      .filter((line) => !/^\| ---/.test(line))
      .map((line) => line.slice(2, -2).split(' | '));
  };
  const seconds = (cell: string): number => Number(/(\d+) s/.exec(cell)![1]);
  const cell = (rows: string[][], label: RegExp, column: number): string => {
    const row = rows.find((candidate) => label.test(candidate[0]!));
    if (row === undefined) throw new Error(`5.1 has no row ${label}`);
    return row[column]!;
  };
  const engine = (name: string, file: string): number => {
    const found = new RegExp(`${name} = (\\d+)(?:\\.0)?\\b`).exec(read(file));
    if (found === null) throw new Error(`${file} no longer says ${name}`);
    return Number(found[1]);
  };

  it('5.1: each column is the budget on its head, the probe and the headroom, and what follows from them', () => {
    const rows = chain();
    const probe = Number(/solver_probe_seconds: float = Field\(default=(\d+)/.exec(read('optimization-engine/app/config.py'))![1]);
    const headroom = engine('BUILD_HEADROOM_SECONDS', 'optimization-engine/app/timing.py');
    const dueLess = engine('ANSWER_SLACK_SECONDS', 'optimization-engine/app/timing.py') + engine('SOLVE_OVERRUN_SECONDS', 'optimization-engine/app/timing.py');
    const wait = Number(/WAIT_MARGIN_SECONDS = (\d+)/.exec(read('src/optimization/engine-timing.ts'))![1]);

    for (const column of [1, 2]) {
      const head = Number(/(\d+) s/.exec(rows[0]![column]!)![1]);
      const budget = seconds(cell(rows, /^The search's budget/, column));
      const ceiling = seconds(cell(rows, /^\*\*The engine's ceiling/, column));

      expect(budget).toBe(head);
      expect(ceiling).toBe(budget + probe + headroom);
      expect(seconds(cell(rows, /^The instant the answer is due/, column))).toBe(ceiling - dueLess);
      expect(seconds(cell(rows, /^The API's wait for Generera/, column))).toBe(ceiling + wait);
    }
  });

  it('5.1 and 4 agree on what the default is, and the table does not call a column "production" that is not', () => {
    const configured = /solver_max_time_seconds: float = Field\(default=(\d+)/.exec(read('optimization-engine/app/config.py'));
    expect(configured).not.toBeNull();
    expect(deployment).toContain(`| \`SOLVER_MAX_TIME_SECONDS\` | \`${configured![1]}\` (the engine's own default`);
    for (const compose of ['docker-compose.yml', 'deploy/docker-compose.prod.yml']) {
      expect(read(compose)).toContain(`SOLVER_MAX_TIME_SECONDS:-${configured![1]}}`);
    }
    expect(deployment).not.toContain('| Time | At the production settings |');
    expect(deployment).toContain("At production's 540 s (private network)");
  });

  it('5.1: the sentence that says how long before the engine\'s ceiling a public road would close the call does the sum', () => {
    const limit = Number(/PUBLIC_PATH_IDLE_LIMIT_SECONDS = (\d+);/.exec(read('src/config/engine-path.ts'))![1]);
    const found = /would close the call (\d+) s before the engine's (\d+) s ceiling/.exec(flat(deployment));
    if (found === null) throw new Error('DEPLOYMENT.md 5.1 no longer says how long before the ceiling a public road would close the call; read the sentence again');

    expect(Number(found[1])).toBe(Number(found[2]) - limit);
  });

  it('36: Vad kom in names every area the gateway counts, and the off-states as the lowest level', () => {
    const start = deployment.indexOf('## 36. ');
    expect(start).toBeGreaterThan(0);
    const section = flat(deployment.slice(start, deployment.indexOf('\n## 37. ', start)));
    // The areas as the gateway lists them, and the words this section uses for each: a new area is added here and in the section together.
    const areas = [...(/export const INTAKE_AREAS = \[([^\]]*)\]/.exec(read('src/intake/intake.ts'))?.[1] ?? '').matchAll(/'([A-Z_]+)'/g)].map((found) => found[1]!);
    const WORDS: Record<string, string> = {
      YEAR: 'the year',
      SUBJECTS: 'subjects',
      ROOMS: 'room types',
      FRAME_TIMES: 'frame times',
      RASTS: 'rasts',
      BREAKS: 'lov',
      LUNCH: 'the lunch',
      SUPERVISION: 'the rastvakt',
      CLASSES: 'classes',
      TEACHING_GROUPS: 'teaching groups',
      PEOPLE: 'pupils',
      TIMPLAN: 'lokal timplan',
      REQUIREMENTS: 'the posts',
      STAFFING: 'the staffing',
      SWITCHES: 'kvittens',
    };
    expect(areas.filter((area) => WORDS[area] === undefined)).toEqual([]);
    expect(areas.filter((area) => !section.includes(WORDS[area]!))).toEqual([]);
    expect(section).toContain('is always the third level');
  });

  it('38: every part of R1 has the number of its pull request', () => {
    const start = deployment.indexOf('| Part | What it adds | Migration |');
    const table = deployment.slice(start, deployment.indexOf('\n\n', start)).split('\n').slice(2);
    expect(table.length).toBeGreaterThanOrEqual(7);
    for (const row of table) expect(row.split(' | ')[0]).toMatch(/#\d+/);
  });

  it('7 and the walkthrough: an insert into "Users" that a guide hands out names "invitedAt"', () => {
    // Section 7 hands the SQL out unless the operator's script has replaced it (P3, #472); either way no guide may hand out
    // a first administrator without the mark that says the person has a login.
    for (const file of ['docs/DEPLOYMENT.md', 'docs/deployment-walkthrough.md']) {
      for (const insert of read(file).match(/insert into "Users" \([^)]*\)/g) ?? []) expect(insert).toContain('"invitedAt"');
    }
  });

  it('39: tells the operator to check the engine before the gateway, with the field to look for', () => {
    const start = deployment.indexOf('## 39. ');
    expect(start).toBeGreaterThan(0);
    const section = flat(deployment.slice(start));
    expect(section).toContain('**The engine before the API.**');
    expect(section).toContain('has `exemptFromLunch` under `FixedLesson`');
  });

  it('35.2 and the measurement record say what production gave a run only on the days it was read (2026-11-18: 180 s, 2026-11-23: 540 s)', () => {
    for (const text of [flat(deployment), flat(read('docs/solve-corpus-measurement.md'))]) {
      expect(text).not.toContain('Production gave a run 180 s on every core it has when this was measured');
      expect(text).not.toContain('Production gives a run 180 s');
      expect(text).not.toContain('a budget of 180 s as in production');
    }
    expect(flat(deployment)).toContain("Production's budget was 180 s on 2026-11-18 and 540 s on 2026-11-23, and the day it changed is not read");
  });
});

describe('README.md and the security audit do not say the schema has twelve tables', () => {
  it('the README says every table, and what keeps it so', () => {
    const readme = read('README.md');
    expect(readme).not.toMatch(/\b12[- ]tables?\b/i);
    expect(flat(readme)).toContain('(section 12 of the RLS suite');
    expect(read('scripts/test/rls-policies.sql')).toContain('-- Section 12: every table is protected at all.');
  });

  it('the audit says the twelve are the day\'s, and where tenancy is held now', () => {
    const audit = flat(read('docs/SECURITY_AUDIT.md'));
    expect(audit).toContain('Read this as the state of 2026-07-11');
    expect(audit).toContain('its section 12 fails the build for any table in `public` that has row-level security off');
    for (const sentence of audit.split(/(?<=\.) /).filter((candidate) => /\b12 tables\b/.test(candidate))) {
      expect(sentence).toMatch(/then|of the time/);
    }
  });
});

describe('the sakbeskrivning keeps what only the owner can answer open', () => {
  const sakbeskrivning = read('docs/dataskydd-sakbeskrivning.md');
  const section = sakbeskrivning.slice(sakbeskrivning.indexOf('## 13. Öppna punkter'), sakbeskrivning.indexOf('## 14. '));

  it('lists the four questions of round 15, decision 14, each with its row', () => {
    for (const id of ['F1', 'F2', 'F5', 'B8']) expect(section).toContain(`| **${id}** |`);
    expect(section).toContain('Läge 2026-11-25');
    for (const part of ['region', 'säkerhetskopior', 'avsändare och SMTP', 'RESEND_API_KEY']) expect(section).toContain(part);
  });

  it('answers none of them: no region is named as the production\'s, and the production\'s state of mail stays out', () => {
    expect(section).not.toMatch(/produktionens (?:Supabase|Vercel)[^.]*(?:eu-|Frankfurt|Stockholm)/i);
    expect(section).toContain('Beskriver båda lägena (4.2 och 4.3) och säger inte vilket som gäller i produktionen (F3)');
  });
});

describe("the user manual's 5.2 says what a 'tiden tar slut' row of its table is not (M8's correction of DEPLOYMENT 35.2, handed to Q1)", () => {
  const manual = read('docs/manual/anvandarmanual.html');
  const text = flat(manual.slice(manual.indexOf('id="hur-lang-tid"'), manual.indexOf('<h3 id="s53">')).replace(/<[^>]+>/g, ''));

  it("DEPLOYMENT 35.2 still says the row is not the limit of what the engine can lay", () => {
    expect(flat(deployment)).toContain('It is **not the limit of what the engine can lay**');
  });

  it('and the manual, which carries the same table to schools, says so too', () => {
    expect(text).toContain('Det är inte en gräns för vad motorn kan lägga');
    expect(text).toContain('kan sakna schema inom sin ram');
    expect(text).toContain('inte skiljer en svår vecka från en omöjlig');
  });
});

describe("the user manual's 5.1 and the feature list say where the optimization profile is kept: with the school (omgång 15, P5 del 3)", () => {
  const manual = read('docs/manual/anvandarmanual.html');
  const section = flat(manual.slice(manual.indexOf('id="s51"'), manual.indexOf('<h3 id="s52">')).replace(/<[^>]+>/g, ''));

  it("says the profile is the school's, which every scheduler sees whatever computer they sit at", () => {
    expect(section).toContain('Profilen är skolans, inte webbläsarens');
  });

  it("does not also say, in a note below, that it is kept in the browser and a colleague's computer has its own", () => {
    expect(section).not.toContain('Profilen sparas lokalt');
    expect(section).not.toContain('sparas i den webbläsare du använder');
    expect(section).not.toContain('har den datorn sina egna inställningar');
  });

  it('and docs/schedule-editing.md does not list the sliders as persisted per browser', () => {
    expect(flat(read('docs/schedule-editing.md'))).not.toContain('persisted per browser');
  });
});
