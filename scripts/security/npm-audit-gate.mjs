#!/usr/bin/env node
/**
 * `npm audit` with a documented, expiring allowlist.
 *
 * npm audit alone has two failure modes this repo refuses: it cannot ignore a
 * specific advisory, so one unfixable transitive finding turns the security
 * gate permanently red (which trains people to ignore red); and silently
 * dropping the gate to --audit-level=critical would hide every future
 * moderate/high finding along with the known one.
 *
 * This wrapper keeps the gate real:
 *   - any moderate+ advisory NOT in the allowlist fails the run, exactly like
 *     `npm audit --audit-level=moderate`;
 *   - an allowlisted advisory is suppressed but PRINTED on every run, with its
 *     justification, so it stays visible;
 *   - every allowlist entry carries an `expires` date. Past it, the entry
 *     stops working and the gate goes red again — suppression is a lease that
 *     forces re-review, never a permanent exemption.
 *
 * Usage:  node scripts/security/npm-audit-gate.mjs <package-dir>
 * Allowlist: scripts/security/audit-allowlist.json, keyed by package dir.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

const packageDir = process.argv[2];
if (!packageDir) {
  console.error("usage: npm-audit-gate.mjs <package-dir>");
  process.exit(2);
}

const allowlistPath = path.join(here, "audit-allowlist.json");
const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));
const entries = allowlist[packageDir] ?? [];

// npm audit exits 1 when it finds anything; the JSON on stdout is still the
// full report, so capture it from the error object.
let raw;
try {
  raw = execSync("npm audit --json", {
    cwd: path.join(repoRoot, packageDir),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (error) {
  if (!error.stdout) throw error;
  raw = error.stdout;
}
const report = JSON.parse(raw);

const FAILING = new Set(["moderate", "high", "critical"]);
const ghsaOf = (url) => (url?.match(/GHSA-[a-z0-9-]+/i) ?? [null])[0];
const today = new Date().toISOString().slice(0, 10);

// Collect the concrete advisories (via objects); string vias are transitive
// pointers to another vulnerable package, not advisories themselves.
const advisories = new Map();
for (const vuln of Object.values(report.vulnerabilities ?? {})) {
  for (const via of vuln.via ?? []) {
    if (typeof via !== "object") continue;
    const id = ghsaOf(via.url);
    if (id && FAILING.has(via.severity)) {
      advisories.set(id, via);
    }
  }
}

const failures = [];
const suppressed = [];
for (const [id, via] of advisories) {
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) {
    failures.push({ id, via, why: "not allowlisted" });
  } else if (entry.expires < today) {
    failures.push({ id, via, why: `allowlist entry expired ${entry.expires}` });
  } else {
    suppressed.push({ id, via, entry });
  }
}

for (const { id, via, entry } of suppressed) {
  console.log(`SUPPRESSED ${id} [${via.severity}] ${via.title}`);
  console.log(`           reason: ${entry.reason}`);
  console.log(`           expires: ${entry.expires} — re-review before then\n`);
}

if (failures.length > 0) {
  for (const { id, via, why } of failures) {
    console.error(`FAIL ${id} [${via.severity}] ${via.title} — ${why}`);
    console.error(`     ${via.url}`);
  }
  console.error(
    `\n${failures.length} failing advisorie(s) in ${packageDir}. Fix the ` +
      "dependency, or — only when no patched release exists anywhere — add an " +
      `allowlist entry with a justification and an expiry to ${path.relative(repoRoot, allowlistPath)}.`,
  );
  process.exit(1);
}

console.log(
  `npm audit gate: ${packageDir} clean ` +
    `(${suppressed.length} suppressed by allowlist, 0 failing)`,
);
