#!/usr/bin/env node
/**
 * Mints a short-lived HS256 JWT for benchmark and load-test runs.
 *
 * The API verifies bearer tokens with `JWT_SECRET` (see src/auth), so a locally
 * signed token is accepted by a local or CI stack without involving Supabase.
 * Signing is done with node:crypto — no dependency, nothing to audit.
 *
 *   JWT_SECRET=... node scripts/bench/mint-token.mjs --sub <authId>
 *
 * `--sub` must be the `Users.authId` of a seeded, active account. The gateway
 * deliberately resolves the application role, `schoolId` and internal `userId`
 * from the database by that subject claim (see src/auth/jwt.strategy.ts) and
 * ignores any role/tenant claims in the token body — so there is nothing else
 * to supply here, and no way to widen access by editing the payload.
 *
 * NEVER point this at a production secret. A token it mints grants the same
 * access as a real login for that account; treat its output as a credential.
 */

import { createHmac } from 'node:crypto';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

const secret = process.env.JWT_SECRET;
if (!secret) {
  console.error('JWT_SECRET is not set. Refusing to sign with an empty key.');
  process.exit(2);
}

const sub = flag('--sub');
const ttlSeconds = Number(flag('--ttl', '3600'));

if (!sub) {
  console.error('--sub <authId> is required (the Users.authId to impersonate).');
  process.exit(2);
}

const b64url = (input) =>
  Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const now = Math.floor(Date.now() / 1000);

const header = { alg: 'HS256', typ: 'JWT' };
const payload = {
  sub,
  // The PostgREST role, matching a Supabase access token. The *application*
  // role is looked up from Users — it is intentionally not a claim here.
  role: 'authenticated',
  aud: process.env.JWT_AUDIENCE ?? 'authenticated',
  iat: now,
  exp: now + ttlSeconds,
};
if (process.env.JWT_ISSUER) payload.iss = process.env.JWT_ISSUER;

const signingInput = `${b64url(JSON.stringify(header))}.${b64url(
  JSON.stringify(payload),
)}`;
const signature = createHmac('sha256', secret)
  .update(signingInput)
  .digest('base64')
  .replace(/\+/g, '-')
  .replace(/\//g, '_')
  .replace(/=+$/, '');

process.stdout.write(`${signingInput}.${signature}\n`);
