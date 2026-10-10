import {
  dateParts,
  formatDateTime,
  formatDayHeading,
  formatDayOfInstant,
  formatShortDate,
  formatTime,
  formatTimeRange,
  localDate,
  shiftDate,
} from './format';

/**
 * Dates and times without Intl. The suite runs under TZ=UTC (package.json).
 * A phone in Sweden is the other case that matters — the clock goes back on
 * 2026-10-25 — and jest's environment hands each test a copy of process.env,
 * so assigning TZ inside a test changes nothing. Those rows therefore run the
 * module itself, transpiled, in a child Node process whose TZ is the phone's.
 */

function inZone(zone: string, expression: string): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ts = require('typescript') as typeof import('typescript');
  const fs = require('fs') as typeof import('fs');
  const os = require('os') as typeof import('os');
  const path = require('path') as typeof import('path');
  const { execFileSync } = require('child_process') as typeof import('child_process');
  const source = fs.readFileSync(path.join(__dirname, 'format.ts'), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'format-zone-'));
  const file = path.join(dir, 'format.js');
  fs.writeFileSync(file, outputText);
  try {
    const out = execFileSync(
      process.execPath,
      ['-e', `const f = require(${JSON.stringify(file)}); process.stdout.write(JSON.stringify(${expression}));`],
      { env: { ...process.env, TZ: zone }, encoding: 'utf8' },
    );
    return JSON.parse(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('format, under the CI zone', () => {
  it('writes 24-hour zero-padded times', () => {
    expect(formatTime('2026-10-13T08:05:00.000Z')).toBe('08:05');
    expect(formatTime('2026-10-13T13:45:00.000Z')).toBe('13:45');
    expect(formatTimeRange('2026-10-13T08:00:00.000Z', '2026-10-13T08:45:00.000Z')).toBe('08:00–08:45');
  });

  it('heads a day in Swedish and in English', () => {
    expect(formatDayHeading('2026-10-13', 'sv')).toBe('tisdag 13 oktober');
    expect(formatDayHeading('2026-10-13', 'en')).toBe('Tuesday 13 October');
    expect(formatShortDate('2026-03-02', 'sv')).toBe('2 mars');
  });

  it('writes an instant short', () => {
    expect(formatDateTime('2026-10-13T08:00:00.000Z', 'sv')).toBe('tis 13 okt 08:00');
    expect(formatDateTime('2026-10-13T08:00:00.000Z', 'en')).toBe('Tue 13 Oct 08:00');
    expect(formatDayOfInstant('2026-10-15T08:00:00.000Z', 'sv')).toBe('tors 15 okt');
    expect(formatDateTime('not a date', 'sv')).toBe('');
  });

  it('reads a server date by its components, never as UTC midnight', () => {
    expect(dateParts('2026-10-13')).toEqual({ year: 2026, month: 10, day: 13 });
    expect(dateParts('2026-10-13T00:00:00.000Z')).toEqual({ year: 2026, month: 10, day: 13 });
    // West of Greenwich, new Date('2026-10-13') is the 12th: the heading must not be.
    expect(inZone('America/New_York', "f.formatDayHeading('2026-10-13', 'sv')")).toBe('tisdag 13 oktober');
  });

  it('shifts across a month, a year and the clock change', () => {
    expect(shiftDate('2026-10-31', 1)).toBe('2026-11-01');
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDate('2026-10-24', 1)).toBe('2026-10-25');
    expect(shiftDate('2026-10-25', 1)).toBe('2026-10-26');
    expect(shiftDate('2026-10-26', -7)).toBe('2026-10-19');
  });
});

describe('format, on a Swedish phone across 2026-10-25', () => {
  it('shows the same lesson time before and after the clock goes back', () => {
    // 08:00 CEST on Friday 23 October is 06:00Z; 08:00 CET on Monday 26 October is 07:00Z.
    expect(
      inZone(
        'Europe/Stockholm',
        "[f.formatTime('2026-10-23T06:00:00.000Z'), f.formatTime('2026-10-26T07:00:00.000Z'), f.formatDateTime('2026-10-26T07:00:00.000Z', 'sv')]",
      ),
    ).toEqual(['08:00', '08:00', 'mån 26 okt 08:00']);
  });

  it('heads Sunday 25 October once, and steps past it by one day', () => {
    expect(
      inZone('Europe/Stockholm', "[f.formatDayHeading('2026-10-25', 'sv'), f.shiftDate('2026-10-25', 1), f.shiftDate('2026-10-26', -1)]"),
    ).toEqual(['söndag 25 oktober', '2026-10-26', '2026-10-25']);
  });

  it('takes the phone’s calendar day for today, not the UTC one', () => {
    // 23:30Z on the 25th is 00:30 on the 26th in Stockholm.
    expect(inZone('Europe/Stockholm', "f.localDate(new Date('2026-10-25T23:30:00.000Z'))")).toBe('2026-10-26');
    expect(localDate(new Date('2026-10-25T23:30:00.000Z'))).toBe('2026-10-25');
  });
});
