import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * The doc comment above a model in prisma/schema.prisma is the model's own: Prisma takes every `///` line that touches `model X {` as
 * its documentation. OptimizationProfile (P5 part 3) was put between kvittens's doc comment and `model AckSetting`, so the kvittens text
 * became the optimization profile's and AckSetting had none. Reads the schema only and imports nothing from src/ (Stryker's sandbox).
 */
const schema = readFileSync(join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8').split('\n');

function docAbove(model: string): string {
  const at = schema.findIndex((line) => line === `model ${model} {`);
  if (at < 0) throw new Error(`prisma/schema.prisma has no model ${model}`);
  const lines: string[] = [];
  for (let i = at - 1; i >= 0 && schema[i]!.startsWith('///'); i -= 1) lines.unshift(schema[i]!);
  return lines.join(' ');
}

describe('the doc comments above OptimizationProfile and AckSetting', () => {
  it("are each one's own: the profile's says what it is and says nothing of kvittens", () => {
    expect(docAbove('OptimizationProfile')).toContain('Optimeringsprofilen (P5, 20270314090000)');
    expect(docAbove('OptimizationProfile')).not.toContain('kvittens');
  });

  it("and kvittens's setting keeps its own", () => {
    expect(docAbove('AckSetting')).toContain('How a school uses kvittens');
    expect(docAbove('AckSetting')).not.toContain('Optimeringsprofilen');
  });
});
