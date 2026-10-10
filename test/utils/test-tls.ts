import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A throwaway certificate authority for the SS12000 tests: a CA, a server
 * certificate for localhost / 127.0.0.1 and a client certificate, made with
 * the openssl CLI into a fresh temporary directory once per process. Nothing
 * is committed: the keys exist for the length of a test run.
 *
 * Why TLS at all: the sources' URLs are https by CHECK (20261014090000), so
 * the mock provider and the mock webhook receiver run TLS too, trusted
 * through the client's test-only `ca` hook — the production code path, with
 * no http escape hatch.
 */
export interface TestTls {
  ca: string;
  serverCert: string;
  serverKey: string;
  clientCert: string;
  clientKey: string;
  /** A second CA that signed nothing the server presents: "the wrong trust store". */
  otherCa: string;
}

let cached: TestTls | null = null;

function openssl(args: string[], cwd: string): void {
  execFileSync('openssl', args, { cwd, stdio: 'pipe' });
}

export function makeTestTls(): TestTls {
  if (cached) return cached;
  const dir = mkdtempSync(join(tmpdir(), 'ss12000-tls-'));
  const ext = (name: string, body: string) => writeFileSync(join(dir, name), body);
  ext('ca.cnf', [
    '[req]', 'distinguished_name = dn', 'prompt = no', '[dn]', 'CN = SchemaPro SS12000 test CA',
    '[v3_ca]', 'basicConstraints = critical, CA:TRUE', 'keyUsage = critical, keyCertSign, cRLSign',
    'subjectKeyIdentifier = hash', '',
  ].join('\n'));
  ext('server.ext', [
    'basicConstraints = CA:FALSE', 'keyUsage = critical, digitalSignature', 'extendedKeyUsage = serverAuth',
    'subjectAltName = DNS:localhost, IP:127.0.0.1', '',
  ].join('\n'));
  ext('client.ext', ['basicConstraints = CA:FALSE', 'keyUsage = critical, digitalSignature', 'extendedKeyUsage = clientAuth', ''].join('\n'));

  for (const name of ['ca', 'other', 'server', 'client']) {
    openssl(['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', `${name}.key`], dir);
  }
  for (const name of ['ca', 'other']) {
    openssl(['req', '-new', '-x509', '-key', `${name}.key`, '-out', `${name}.crt`, '-days', '3650', '-config', 'ca.cnf', '-extensions', 'v3_ca'], dir);
  }
  openssl(['req', '-new', '-key', 'server.key', '-out', 'server.csr', '-subj', '/CN=localhost'], dir);
  openssl(['req', '-new', '-key', 'client.key', '-out', 'client.csr', '-subj', '/CN=schemapro-test-client'], dir);
  for (const name of ['server', 'client']) {
    openssl(
      ['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.crt`, '-days', '3650', '-extfile', `${name}.ext`],
      dir,
    );
  }
  const read = (name: string) => readFileSync(join(dir, name), 'utf8');
  cached = {
    ca: read('ca.crt'),
    serverCert: read('server.crt'),
    serverKey: read('server.key'),
    clientCert: read('client.crt'),
    clientKey: read('client.key'),
    otherCa: read('other.crt'),
  };
  return cached;
}
