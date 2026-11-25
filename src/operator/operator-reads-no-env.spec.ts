import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * "It reads no .env file" (scripts/operator/new-school.ts) is a promise about which database a command writes in: a value that is
 * not on the line the operator typed must not decide it. A source scan holds it the way the repo holds other things nobody wants to
 * find out by looking: the operator's code names no loader and reads no file, and takes its variables from a short list by name.
 */
const OPERATOR_FILES = [
  ...readdirSync(__dirname).filter((name) => name.endsWith('.ts') && !name.endsWith('.spec.ts')).map((name) => join(__dirname, name)),
  join(__dirname, '..', '..', 'scripts', 'operator', 'new-school.ts'),
];

/** Code without its comments and string-free of the words that explain the rule. */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

describe('the operator script reads no .env', () => {
  it.each(OPERATOR_FILES.map((path) => [path.replace(/^.*\/(src|scripts)\//, '$1/'), path]))('%s loads no environment file', (_name, path) => {
    const code = codeOf(path!);
    expect(code).not.toMatch(/dotenv/i);
    expect(code).not.toMatch(/loadEnvFile/);
    expect(code).not.toMatch(/readFile(Sync)?\s*\(/);
    // No file system at all: the operator's code takes everything from its arguments and the variables named below.
    expect(code).not.toMatch(/from 'node:fs'|from 'fs'|require\('(node:)?fs'\)/);
    expect(code).not.toMatch(/@nestjs\/config/);
  });

  it('the script takes its variables from this list, by name, and no other', () => {
    const code = codeOf(join(__dirname, '..', '..', 'scripts', 'operator', 'new-school.ts'));
    const named = [...code.matchAll(/env\.([A-Z_]+)/g)].map((match) => match[1]).sort();
    expect([...new Set(named)]).toEqual(['DIRECT_URL', 'SUPABASE_ACCESS_TOKEN', 'SUPABASE_PROJECT_REF', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_URL']);
    // The one more variable is the one --password-env names, read by that name and by none other.
    expect(code).toContain('env[args.login.passwordEnv]');
  });
});
