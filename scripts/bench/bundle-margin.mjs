/**
 * How much room a route or the shared runtime has left under its bundle
 * budget, and when to say so.
 *
 * bundle-size.mjs fails a build only when a budget is crossed, and the one who
 * crosses it is the one whose pull request happened to touch a route that was
 * already within a few hundred bytes: a phase that adds one dialog finds out in
 * CI that the page had 507 B left. The warning exists so the *previous* pull
 * request sees it, with the number, while there is still room to act. It never
 * changes the exit code: a warning that could fail a build would be a second
 * budget under the first.
 *
 * Margins are in BYTES against the nominal budget (190 KB = 194 560 B), the
 * figure every design note and pull request quotes. bundle-size.mjs compares
 * in KB rounded to 0.1, so the gate's own ceiling is about 51 B higher; a route
 * inside that rounding is reported as a little over the nominal budget, not as
 * having room.
 *
 * No imports: bundle-margin.test.mjs runs this on a pull request without a
 * build (node --test scripts/bench/bundle-margin.test.mjs).
 */

/** Under this many bytes left, a route or the shared runtime is reported. */
export const WARN_MARGIN_BYTES = 2048;

/** Bytes left under a budget of `budgetKb` KB; negative when over it. */
export const marginOf = (bytes, budgetKb) => budgetKb * 1024 - bytes;

/**
 * One row per route plus one for the shared runtime, tightest first.
 *
 * `routes`: { route, tier, budgetKb, routeOnlyBytes, failing }, where `failing`
 * is the gate's own verdict (it is already reported as a failure, so it is not
 * reported twice as a warning).
 */
export function marginsOf({ sharedBytes, sharedBudgetKb, sharedFailing = false, routes }) {
  const rows = routes.map((r) => ({
    scope: r.route,
    kind: 'route',
    tier: r.tier,
    budgetKb: r.budgetKb,
    bytes: r.routeOnlyBytes,
    marginBytes: marginOf(r.routeOnlyBytes, r.budgetKb),
    failing: Boolean(r.failing),
  }));
  rows.push({
    scope: 'shared runtime',
    kind: 'shared',
    tier: 'shared',
    budgetKb: sharedBudgetKb,
    bytes: sharedBytes,
    marginBytes: marginOf(sharedBytes, sharedBudgetKb),
    failing: sharedFailing,
  });
  return rows.sort((a, b) => a.marginBytes - b.marginBytes || a.scope.localeCompare(b.scope));
}

/** The rows with less than `thresholdBytes` left that the gate has not already failed. */
export const warningsOf = (rows, thresholdBytes = WARN_MARGIN_BYTES) =>
  rows.filter((row) => !row.failing && row.marginBytes < thresholdBytes);

const group = (n) => String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** "1 460 B left of 194 560 B" — or, inside the gate's rounding, how far over. */
export function describe(row) {
  const budgetBytes = row.budgetKb * 1024;
  const left =
    row.marginBytes >= 0
      ? `${group(row.marginBytes)} B left of ${group(budgetBytes)} B`
      : `${group(row.marginBytes)} B over ${group(budgetBytes)} B (inside the gate's 0.1 KB rounding, so it still passes)`;
  const what = row.kind === 'shared' ? 'the shared runtime' : row.scope;
  return `${what} — ${left} (${row.tier}, ${row.budgetKb} KB)`;
}

/** GitHub escapes these three in an annotation's message (workflow commands). */
const escapeData = (text) =>
  text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

/** A `::warning` workflow command: shown on the run and on the pull request's checks. */
export const annotationOf = (row, thresholdBytes = WARN_MARGIN_BYTES) =>
  `::warning title=${escapeData(`Bundle margin under ${thresholdBytes / 1024} KB`)}::${escapeData(
    `${describe(row)}. The next change to it that adds more than that fails the bundle gate.`,
  )}`;

/** The tightest `count` rows as a markdown table, for the step summary of the run. */
export function summaryOf(rows, count = 8) {
  const lines = [
    '### Bundle margins',
    '',
    'Tightest first, in bytes under each budget (gzip level 9).',
    '',
    '| Scope | Tier | Budget | Bytes | Left |',
    '| :--- | :--- | ---: | ---: | ---: |',
  ];
  for (const row of rows.slice(0, count)) {
    lines.push(
      `| ${row.kind === 'shared' ? 'shared runtime' : `\`${row.scope}\``} | ${row.tier} | ${row.budgetKb} KB | ` +
        `${group(row.bytes)} | ${row.marginBytes < 0 ? '−' : ''}${group(row.marginBytes)} |`,
    );
  }
  return lines.join('\n') + '\n';
}
