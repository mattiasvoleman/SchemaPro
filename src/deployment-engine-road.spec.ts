import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * WHAT DEPLOYMENT.md SAYS OF THE ROAD TO THE ENGINE, HELD TO WHAT THE REPOSITORY DOES (omgång 15, the 2026-11-23
 * incident).
 *
 * Section 5.3 tells whoever runs the deployment to check one fact before they point the API at Railway's private
 * network: that the engine's image binds `0.0.0.0`, which is IPv4 only, and that Railway's private network is IPv6
 * only in environments created before 2025-10-16. The sentence is true of the Dockerfile as it is. If the
 * Dockerfile's start line changes (to `::`, to a variable), the section is wrong in a way that costs a deploy: an
 * operator would believe the engine needs a custom start command it no longer needs, or the reverse. This fails then,
 * and says which text to read again.
 */

const ROOT = join(__dirname, '..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const deployment = read('docs/DEPLOYMENT.md');
const section = deployment.slice(
  deployment.indexOf('### 5.3 The road to the engine'),
  deployment.indexOf('## 6. Deploy the web app'),
);
const dockerfile = read('optimization-engine/Dockerfile');

describe('docs/DEPLOYMENT.md 5.3: the road to the engine', () => {
  it('exists, between 5.2 and the web app', () => {
    expect(section.length).toBeGreaterThan(1000);
    expect(deployment.indexOf('### 5.2 Where a timed-out run')).toBeLessThan(deployment.indexOf('### 5.3 The road to the engine'));
  });

  it('says what the platform does: 5 minutes with no data, 15 with data, and that the engine is silent while it solves', () => {
    expect(section).toContain('closed after 5 minutes with no data transferred');
    expect(section).toContain('up to **15 minutes if data keeps transferring**');
    expect(section).toContain('sends nothing while it solves');
    expect(section).toContain('300 008 ms');
  });

  it('says the engine binds 0.0.0.0, and the Dockerfile still does: change one and the other is read again', () => {
    expect(dockerfile).toMatch(/uvicorn app\.main:app --host 0\.0\.0\.0 --port \$\{PORT:-8000\}/);
    expect(section).toContain('binds **`0.0.0.0`**');
    expect(section).toContain('IPv4 only');
  });

  it('says what a legacy environment needs: the date, IPv6, and the start command that gives it', () => {
    expect(section).toContain('2025-10-16');
    expect(section).toContain('IPv6 only');
    expect(section).toContain('custom start command on the engine');
  });

  it('gives a start command that listens on both address families, and never says that `--host ::` does', () => {
    // `uvicorn --host ::` (one worker) is IPv6 ONLY: asyncio and uvloop set IPV6_V6ONLY on that socket, measured against the
    // engine's own image on 2026-11-24 (127.0.0.1 refused, ::1 answered). The command the section gives has an empty host,
    // which listens on both; optimization-engine/tests/test_listen_host.py runs the command's host against both families.
    expect(section).toContain('sh -c "exec uvicorn app.main:app --host \'\' --port ${PORT:-8000} --workers 1 --no-access-log"');
    expect(section).toContain('IPV6_V6ONLY');
    expect(section).not.toContain('accepts IPv4 as well');
    expect(section).not.toMatch(/--host :: --port/);
  });

  it('gives the private address as http, with a port, and names the variable that carries it', () => {
    expect(section).toContain('AI_ENGINE_URL=http://<engine service name>.railway.internal:<port>');
    expect(section).toContain('`http` and not `https`');
  });

  it('says how to see that it worked, and the way back', () => {
    expect(section).toContain('does not state its times');
    expect(section).toContain('Put the old `AI_ENGINE_URL` back');
  });

  it('is named where the engine is deployed (4), in the variable table and in the chain of times (5.1)', () => {
    const four = deployment.slice(deployment.indexOf('## 4. Deploy the AI engine'), deployment.indexOf('## 5. Deploy the NestJS API'));
    expect(four).toContain('(§5.3)');
    expect(deployment).toContain('`AI_ENGINE_PATH_IDLE_LIMIT_SECONDS`');
    expect(deployment).toContain('**How long the road to the engine holds a request that sends nothing**');
  });
});

/*
 * THE NUMBERS AND THE SENTENCES OF 5.3, HELD TO THE CODE THAT MAKES THEM TRUE (the review of #418).
 *
 * The section says what the API does about the road ("held to 290 s", "235 s at the defaults", the variable's range, the
 * lines in the start log), and the PR says its text "only says what the code does". Nothing above reads that code: a
 * margin changed from 10 s to 15 s, or a log line reworded, left the document wrong and every case green. These read the
 * API's own files, so they need the code the section describes (omgång 15, the road's limit, #416): on a tree without it
 * they fail with "no such file", which is the order the PR says it must merge in.
 */
describe('docs/DEPLOYMENT.md 5.3: held to the code it describes', () => {
  const PATH_LIMIT = /export const PUBLIC_PATH_IDLE_LIMIT_SECONDS = (\d+);/;
  const PATH_MARGIN = /export const PATH_MARGIN_SECONDS = (\d+);/;
  const numberIn = (text: string, pattern: RegExp, where: string): number => {
    const found = pattern.exec(text);
    if (found === null) throw new Error(`${where}: ${pattern} no longer matches; read section 5.3 again`);
    return Number(found[1]);
  };

  const limit = (): number => numberIn(read('src/config/engine-path.ts'), PATH_LIMIT, 'src/config/engine-path.ts');
  const margin = (): number => numberIn(read('src/optimization/engine-timing.ts'), PATH_MARGIN, 'src/optimization/engine-timing.ts');
  const engineSeconds = (name: string, file: string): number =>
    numberIn(read(file), new RegExp(`${name} = (\\d+)(?:\\.0)?\\b`), file);

  it('says the limit, what the API holds a wait to, and the budget that fits, as the code computes them', () => {
    const wait = limit() - margin();
    const transfer = engineSeconds('TRANSFER_MARGIN_SECONDS', 'optimization-engine/app/timing.py');
    const headroom = engineSeconds('BUILD_HEADROOM_SECONDS', 'optimization-engine/app/timing.py');
    const probe = numberIn(read('optimization-engine/app/config.py'), /solver_probe_seconds: float = Field\(default=(\d+)(?:\.0)?,/, 'config.py');
    const fits = wait - transfer - probe - headroom;

    expect(section).toContain(`| a public \`https://…\` address | ${limit()} s | ${wait} s |`);
    expect(deployment).toContain(`**${wait} s** (the limit less 10 s)`);
    expect(section).toContain(`**the limit less 10 s less the transfer margin (${transfer} s), the probe (${probe} s) and the headroom (${headroom} s): ${fits} s at the defaults.**`);
    expect(margin()).toBe(10);
  });

  it('says the range of the variable and that 0 is "none", as the validation has them', () => {
    const validation = read('src/config/env.validation.ts');
    const range = /@Min\((\d+)\)\s+@Max\(([\d_]+)\)\s+AI_ENGINE_PATH_IDLE_LIMIT_SECONDS\?: number;/.exec(validation);
    if (range === null) throw new Error('env.validation.ts no longer declares the variable as this test reads it');
    const [min, max] = [Number(range[1]), Number(range[2]!.replace(/_/g, ''))];

    expect(deployment).toContain(`otherwise \`${min}\` to \`${max}\``);
    expect(deployment).toContain('`0` says the road holds a silent request as long as it takes');
  });

  it('classifies each address of the table as the code does', () => {
    const { pathIdleLimitSecondsOf } = jest.requireActual('./config/engine-path') as {
      pathIdleLimitSecondsOf: (baseUrl: string, configured: number | undefined) => number | undefined;
    };
    // The rows of the table in 5.3, one address each.
    expect(pathIdleLimitSecondsOf('https://engine.up.railway.app', undefined)).toBe(limit());
    expect(pathIdleLimitSecondsOf('http://engine.railway.internal:8000', undefined)).toBeUndefined();
    expect(pathIdleLimitSecondsOf('http://localhost:8000', undefined)).toBeUndefined();
    expect(pathIdleLimitSecondsOf('http://10.1.2.3:8000', undefined)).toBeUndefined();
    expect(pathIdleLimitSecondsOf('http://solver:8000', undefined)).toBeUndefined();
    expect(pathIdleLimitSecondsOf('http://engine.example.com:8000', undefined)).toBeUndefined();
    // The variable table: an https address is what has the edge, unless the name says it is private.
    expect(pathIdleLimitSecondsOf('https://engine.railway.internal:8000', undefined)).toBeUndefined();
    expect(pathIdleLimitSecondsOf('https://localhost:8000', undefined)).toBeUndefined();
    expect(pathIdleLimitSecondsOf('https://10.1.2.3:8000', undefined)).toBeUndefined();
    expect(pathIdleLimitSecondsOf('https://solver', undefined)).toBeUndefined();
    // The override: a number is the limit, and 0 is "none" whatever the address says.
    expect(pathIdleLimitSecondsOf('http://engine.example.com:8000', 120)).toBe(120);
    expect(pathIdleLimitSecondsOf('https://engine.up.railway.app', 0)).toBeUndefined();
  });

  it('quotes the start-log lines that the API writes', () => {
    const service = read('src/optimization/engine-timing.service.ts');
    expect(section).toContain('The engine says its generator waits up to');
    expect(service).toContain('The engine says its generator waits up to');
    expect(section).toContain('held to what the road to the engine holds');
    expect(service).toContain('held to what the road to the engine holds');
    expect(section).toContain('does not state its times');
    expect(service).toContain('does not state its times');
  });
});
