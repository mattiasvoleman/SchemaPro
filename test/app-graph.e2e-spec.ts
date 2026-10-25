import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_GUARD } from '@nestjs/core';
import { FEATURE_MODULES, GLOBAL_PROVIDERS } from './utils/test-app';

/**
 * The harness is AppModule's graph, not a copy of it that drifts: the
 * global guards in the same order (the harness's header guard standing in
 * for JwtAuthGuard, the throttler only in the throttled harness), and the
 * same feature modules, each difference named with why. A guard taken out
 * of AppModule, moved, or a module the harness lacks, fails here, so the
 * route sweeps (route-guards.e2e-spec, huvudman-gets.e2e-spec) ask the
 * routes production serves, guarded as production guards them.
 *
 * AppModule is read as its source: importing it would load AuthModule's
 * jwks-rsa, whose jose is ESM that this jest does not transform (the reason
 * the harness has a header guard in its place).
 */

/**
 * The source without its comments, strings kept: a guard or module named in
 * a comment, or one commented out, is not AppModule's.
 */
export function withoutComments(source: string): string {
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 1;
      out += ' ';
    } else if (char === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end - 1;
    } else if (char === "'" || char === '"' || char === '`') {
      let j = i + 1;
      while (j < source.length && source[j] !== char) j += source[j] === '\\' ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j;
    } else {
      out += char;
    }
  }
  return out;
}

const APP = withoutComments(readFileSync(join(__dirname, '..', 'src', 'app.module.ts'), 'utf8'));
const MODULE = APP.slice(APP.indexOf('@Module({'));
/** AppModule's APP_GUARD classes, in the order it provides them. */
const appGuards = [...MODULE.matchAll(/provide:\s*APP_GUARD,\s*useClass:\s*(\w+)/g)].map((match) => match[1]!);
/** AppModule's imports, by the name each begins with (ThrottlerModule.forRootAsync(…) is ThrottlerModule). */
const appImports = (() => {
  const start = MODULE.indexOf('imports: [') + 'imports: ['.length;
  let depth = 1;
  let end = start;
  for (; end < MODULE.length && depth > 0; end++) {
    if ('[({'.includes(MODULE[end]!)) depth++;
    if ('])}'.includes(MODULE[end]!)) depth--;
  }
  const body = MODULE.slice(start, end - 1);
  // Top-level entries only: drop what a factory's own brackets hold.
  let flat = '';
  let level = 0;
  for (const char of body) {
    if ('[({'.includes(char)) level++;
    if (level === 0) flat += char;
    if ('])}'.includes(char)) level--;
  }
  return flat.split(',').map((entry) => entry.trim().split('.')[0]!).filter((name) => /^\w+Module$/.test(name));
})();

type Provider = { provide?: unknown; useClass?: { name: string } };
const guardsOf = (providers: readonly unknown[]) =>
  (providers as Provider[]).filter((one) => one && one.provide === APP_GUARD).map((one) => one.useClass?.name);
const nameOf = (module: unknown) =>
  typeof module === 'function' ? module.name : (module as { module?: { name: string } }).module?.name ?? String(module);

describe('The test harness is AppModule (e2e)', () => {
  it('reads AppModule without its comments, so a guard or module named only in one does not count', () => {
    const source = [
      "/* { provide: APP_GUARD, useClass: OldGuard }, */",
      "// { provide: APP_GUARD, useClass: LineGuard },",
      "{ provide: APP_GUARD, useClass: RealGuard }, // after: { provide: APP_GUARD, useClass: TailGuard }",
      "const url = 'https://example.invalid/*not a comment*/';",
    ].join('\n');
    const kept = withoutComments(source);
    expect([...kept.matchAll(/provide:\s*APP_GUARD,\s*useClass:\s*(\w+)/g)].map((match) => match[1])).toEqual(['RealGuard']);
    expect(kept).toContain("'https://example.invalid/*not a comment*/'");
  });

  it('applies the global guards in AppModule\'s order, Huvudman\'s between authentication and roles', () => {
    const app = appGuards;
    expect(app).toEqual(['JwtAuthGuard', 'HuvudmanGuard', 'RolesGuard', 'ThrottlerGuard']);
    expect(guardsOf(GLOBAL_PROVIDERS)).toEqual(['HeaderAuthGuard', ...app.slice(1, -1)]);
  });

  it("imports AppModule's feature modules, each one it does not named with why", () => {
    expect(appImports.length).toBeGreaterThan(25);
    const app = new Set(appImports);
    const harness = new Set(FEATURE_MODULES.map(nameOf));
    // In AppModule, not the harness: the timers no spec wants running
    // (JobsModule), the JWT strategy the header guard stands in for
    // (AuthModule), the throttler (only the throttled harness), and the
    // Socket.IO server (TestRealtimeModule stands in).
    const appOnly = new Set(['JobsModule', 'AuthModule', 'ThrottlerModule', 'RealtimeModule']);
    // In the harness, not AppModule: the routing table for the sweeps, and
    // the realtime stand-in.
    const harnessOnly = new Set(['DiscoveryModule', 'TestRealtimeModule']);
    expect([...app].filter((name) => !harness.has(name) && !appOnly.has(name))).toEqual([]);
    expect([...harness].filter((name) => !app.has(name) && !harnessOnly.has(name))).toEqual([]);
    for (const name of appOnly) expect(app.has(name)).toBe(true);
  });
});
