// FIRST, as the built application reads it: AppModule's graph reaches the clash
// rule's file before the proxy's, and with the old import cycle that order is
// the one that decorated the proxy's constructor with `undefined` (review of
// #293, HÖG-1). Kept first on purpose; do not let an import sorter move it.
import { MasterLessonsService } from '../calendar/master-lessons.service';
import { Test } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaService } from '../database/prisma.service';
import { OptimizationProxyService } from './optimization-proxy.service';

/*
 * FÖRLAGDA POSTER NEED THE CLASH RULE IN THE PROXY, AS NEST GIVES IT.
 *
 * Generera judges every förläggning with MasterLessonsService.findConflicts
 * (placement-judge.ts) before the engine is woken. The proxy's specs build the
 * service by hand with a fake in its fourth place, so they could not see that
 * Nest gave it nothing: master-lessons.service.ts imported requirementName
 * from the proxy's file, the proxy imported MasterLessonsService back, and
 * whichever file was read first saw the other half-built. The parameter was
 * decorated `undefined`, @Optional() let Nest pass undefined, and every
 * Generera of a school with one förläggning was a 500.
 *
 * These ask what Nest asks: the parameter's design type, and what a module
 * built by Nest's own injector hands the proxy.
 */
describe('OptimizationProxyService receives MasterLessonsService from Nest (HÖG-1 of #293)', () => {
  it('is decorated with MasterLessonsService in its fourth place, not undefined', () => {
    const types = Reflect.getMetadata('design:paramtypes', OptimizationProxyService) as unknown[];
    expect(types[3]).toBe(MasterLessonsService);
  });

  it('gets the clash rule injected when Nest builds it, and refuses to build without one', async () => {
    const masters = { findConflicts: jest.fn() };
    const config = { getOrThrow: () => ({ baseUrl: 'http://engine.invalid', apiKey: 'k'.repeat(32), timeoutMs: 1000 }) };
    const providers = [
      OptimizationProxyService,
      { provide: PrismaService, useValue: {} },
      { provide: HttpService, useValue: {} },
      { provide: ConfigService, useValue: config },
    ];

    const built = await Test.createTestingModule({
      providers: [...providers, { provide: MasterLessonsService, useValue: masters }],
    }).compile();
    expect((built.get(OptimizationProxyService) as unknown as { masters: unknown }).masters).toBe(masters);

    // No @Optional(): a graph that cannot give it fails when the module is
    // built (at boot), never at the first Generera with a förläggning.
    await expect(Test.createTestingModule({ providers }).compile()).rejects.toThrow(/MasterLessonsService|dependencies/);
  });

  it('keeps the clash rule’s file from importing the proxy’s again', () => {
    // The cycle, as a fact about the source: no import (type-only ones are
    // erased) from master-lessons.service.ts names the proxy's file.
    const source = readFileSync(join(__dirname, '..', 'calendar', 'master-lessons.service.ts'), 'utf8');
    const runtimeImports = [...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)'/gms)].map((match) => match[1]);
    expect(runtimeImports).not.toContain('../optimization/optimization-proxy.service');
  });
});
