import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The gateway serves the OpenAPI document and no Swagger UI. @nestjs/swagger loads swagger-ui-dist (11 MB of browser
 * assets) only from SwaggerModule.setup, and the Dockerfile removes the package from the image for that reason. A call
 * to setup would fail at boot in production, so it fails here first.
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') && !path.endsWith('no-swagger-ui.spec.ts') ? [path] : [];
  });
}

describe('no Swagger UI', () => {
  it('is never set up, since the image does not carry swagger-ui-dist', () => {
    const calling = sources(join(__dirname, '..')).filter((file) => /SwaggerModule\s*\.\s*setup\s*\(/.test(readFileSync(file, 'utf8')));
    expect(calling).toEqual([]);
  });

  it('has the Dockerfile remove the package after the production prune', () => {
    const dockerfile = readFileSync(join(__dirname, '..', '..', 'Dockerfile'), 'utf8');
    expect(dockerfile.indexOf('npm prune --omit=dev')).toBeGreaterThan(-1);
    expect(dockerfile.indexOf('rm -rf node_modules/swagger-ui-dist')).toBeGreaterThan(dockerfile.indexOf('npm prune --omit=dev'));
  });
});
