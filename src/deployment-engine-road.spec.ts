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
    expect(section).toContain('--host ::');
    expect(section).toContain('custom start command on the engine');
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
