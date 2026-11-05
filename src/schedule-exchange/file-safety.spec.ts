import { createHash, randomUUID } from 'node:crypto';
import { MAX_PROBLEMS, MAX_QUOTE, ProblemLog, REDACTED, excerpt, hasPersonalNumber, redactPersonalNumbers, scrubPersonalNumbers } from './file-safety';

describe('file-safety', () => {
  describe('hasPersonalNumber', () => {
    const numbers: Array<[string, string]> = [
      ['ÅÅÅÅMMDD-NNNN', '19800101-1234'],
      ['ÅÅMMDDNNNN', '8001011234'],
      ['ÅÅÅÅMMDDNNNN', '198001011234'],
      ['ÅÅMMDD-NNNN', '800101-1234'],
      ['ÅÅMMDD+NNNN (over a hundred)', '121212+1234'],
      ['samordningsnummer ÅÅÅÅMMDD-NNNN', '19800181-1234'],
      ['samordningsnummer ÅÅMMDDNNNN', '8001811234'],
      ['samordningsnummer with day 61', '800161-1234'],
      ['samordningsnummer with day 91', '800191-1234'],
      ['with spaces round the hyphen', '19800101 - 1234'],
      ['with an en dash', '19800101–1234'],
      ['after a name', 'Anna Berg 19800101-1234'],
      ['in parentheses', '(800101-1234)'],
      ['in a longer text', 'Matematik; lärare 800101-1234; sal A101'],
      ['at the end of a sentence', 'Se 8001011234.'],
      // The second review of PR #256: spellings outside the first shape.
      ['a no-break space between', '800101\u00a01234'],
      ['a narrow no-break space between', '800101\u202f1234'],
      ['a line break between', '800101\n1234'],
      ['a CRLF between', '800101\r\n1234'],
      ['a line break after the hyphen', '19800101-\n1234'],
      ['three spaces between', '800101   1234'],
      ['a tab between', '800101\t1234'],
      ['a dot between', '800101.1234'],
      ['a slash between', '800101/1234'],
      ['an underscore between', '800101_1234'],
      ['a zero-width space between', '800101\u200b1234'],
      ['a zero-width space inside the date', '8001\u200b011234'],
      ['a soft hyphen between', '800101\u00ad1234'],
      ['a minus sign between', '800101\u22121234'],
      ['a figure dash between', '800101\u20121234'],
      ['fullwidth digits and hyphen', '\uff18\uff10\uff10\uff11\uff10\uff11\uff0d\uff11\uff12\uff13\uff14'],
      ['a space between every digit', '8 0 0 1 0 1 1 2 3 4'],
      ['a space between every group', '1980 01 01 1234'],
      ['a space between the groups of two digits', '80 01 01 1234'],
      ['two spaces round the hyphen', '800101  -  1234'],
      ['the date form with a hyphen', '1980-01-01-1234'],
      ['the date form with a space', '1980-01-01 1234'],
      ['the two-digit date form', '80-01-01-1234'],
      ['the date form with a samordningsnummer day', '1980-01-81-1234'],
      ['a plus after spaces', '800101 + 1234'],
      ['next to letters', 'abc8001011234xyz'],
      ['in a note', 'Se anteckning: 19800101-1234 (vikarie)'],
    ];
    it.each(numbers)('sees %s', (_label, text) => {
      expect(hasPersonalNumber(text)).toBe(true);
    });

    const notNumbers: Array<[string, string]> = [
      ['an ISO date', '2026-08-17'],
      ['a period', '2026-08-17–2026-12-18'],
      ['a time range', '08:10–09:10'],
      ['a UUID', '3f6c942b-35e4-432e-99be-d9d82944704a'],
      ['a plain number', '12345'],
      ['a room', 'Sal A101'],
      ['a month 13', '801301-1234'],
      ['a day 32', '800132-1234'],
      ['a day 00', '800100-1234'],
      ['a day 60', '800160-1234'],
      ['a day 92', '800192-1234'],
      ['nine digits', '800101123'],
      ['thirteen digits', '1980010112345'],
      ['empty', ''],
      ['a period with an en dash', '2026-08-17\u20132026-12-18'],
      ['a period with a hyphen', '2026-08-17-2026-12-18'],
      ['a period with a space', '2026-08-17 2026-12-18'],
      ['a period with dots', '2026.08.17-2026.12.18'],
      ['a date and a time', '2026-08-17 08:10'],
      ['a compact date', '20260817'],
      ['two times', '08:10 09:10'],
      ['a block name with a number', 'Block 1234'],
      ['a block name with a year', 'Val 2026 1'],
      ['a room', 'A101'],
      ['a code', '0810'],
      ['a long digit run that is no date', '9999999999999'],
      ['a month 13 in the date form', '1980-13-01-1234'],
      ['a day 32 in the date form', '1980-01-32-1234'],
    ];
    it.each(notNumbers)('does not see %s', (_label, text) => {
      expect(hasPersonalNumber(text)).toBe(false);
    });

    it('takes null and undefined for no number', () => {
      expect(hasPersonalNumber(null)).toBe(false);
      expect(hasPersonalNumber(undefined)).toBe(false);
    });

    it('is linear in the length of the text', () => {
      for (const filler of [' ', '-', '1', '12', ' -']) {
        const text = filler.repeat(Math.floor(200_000 / filler.length)) + 'x';
        const started = Date.now();
        hasPersonalNumber(text);
        redactPersonalNumbers(text);
        expect(Date.now() - started).toBeLessThan(1500);
      }
    });
  });

  describe('redactPersonalNumbers, in whatever spelling the number was written', () => {
    it.each([
      ['a no-break space', 'Anna 800101\u00a01234 klar'],
      ['a line break', 'Anna 800101\n1234 klar'],
      ['a dot', 'Anna 800101.1234 klar'],
      ['fullwidth digits', 'Anna \uff18\uff10\uff10\uff11\uff10\uff11\uff0d\uff11\uff12\uff13\uff14 klar'],
      ['the date form', 'Anna 1980-01-01-1234 klar'],
      ['spaced digits', 'Anna 8 0 0 1 0 1 1 2 3 4 klar'],
      ['a zero-width space', 'Anna 800101\u200b1234 klar'],
    ])('cuts out %s and keeps the words round it', (_label, text) => {
      expect(redactPersonalNumbers(text)).toBe(`Anna ${REDACTED} klar`);
    });

    it('cuts out a number that is the whole text, and two in one text', () => {
      expect(redactPersonalNumbers('800101.1234')).toBe(REDACTED);
      expect(redactPersonalNumbers('800101.1234 och 19800101\n1234')).toBe(`${REDACTED} och ${REDACTED}`);
    });

    it('leaves a period alone', () => {
      expect(redactPersonalNumbers('2026-08-17-2026-12-18')).toBe('2026-08-17-2026-12-18');
    });

    it('leaves what it does not cut exactly as written, characters that look like spaces included', () => {
      expect(redactPersonalNumbers('Sal\u00a0A101 och 800101\u00a01234')).toBe(`Sal\u00a0A101 och ${REDACTED}`);
    });
  });

  describe('redactPersonalNumbers', () => {
    it('replaces each number and keeps the text around it', () => {
      expect(redactPersonalNumbers('Anna 19800101-1234 och Bo 8001811234.')).toBe(`Anna ${REDACTED} och Bo ${REDACTED}.`);
    });

    it('leaves a clean text alone', () => {
      expect(redactPersonalNumbers('Matematik 7A 08:10')).toBe('Matematik 7A 08:10');
      expect(redactPersonalNumbers('')).toBe('');
    });
  });

  describe('excerpt', () => {
    it('quotes a short value as it is, on one line', () => {
      expect(excerpt('7A\n  Matematik')).toBe('”7A Matematik”');
    });

    it('cuts a long value, and says so', () => {
      const shown = excerpt('x'.repeat(5000));
      expect(shown.length).toBeLessThanOrEqual(MAX_QUOTE + 3);
      expect(shown.endsWith('…”')).toBe(true);
    });

    it('redacts before it cuts, so a number is never shown in half', () => {
      const shown = excerpt(`${'a'.repeat(MAX_QUOTE - 5)}19800101-1234`);
      expect(shown).not.toMatch(/\d{4}/);
      expect(shown).not.toContain('1980');
    });

    it('takes null for an empty value', () => {
      expect(excerpt(null)).toBe('””');
    });
  });

  describe('scrubPersonalNumbers', () => {
    it('redacts every string however deep, keys too', () => {
      const out = scrubPersonalNumbers({
        label: 'Anna 19800101-1234',
        rows: [{ detail: 'Läraren 800101-1234 finns inte', params: { key: '8001811234' }, n: 3 }],
        '19800101-1234': 1,
        flag: true,
        nothing: null,
      });
      expect(JSON.stringify(out)).not.toMatch(/1234/);
      expect(JSON.stringify(out)).toContain(REDACTED);
      expect(out.rows[0]!.n).toBe(3);
      expect(out.flag).toBe(true);
    });

    it('returns a clean value as it is, not a copy', () => {
      const clean = { a: ['x', { b: 'y' }], c: 1 };
      expect(scrubPersonalNumbers(clean)).toBe(clean);
    });

    it('lets ids and fingerprints be, whatever digits they happen to hold', () => {
      // 198001011234 is a valid shape, and a UUID or a hash may carry it by chance.
      const uuid = '3f6c942b-35e4-432e-99be-198001011234';
      const fingerprint = '198001011234abcdef0123456789abcd';
      expect(hasPersonalNumber(uuid) || hasPersonalNumber(fingerprint)).toBe(true);
      const out = scrubPersonalNumbers({ fingerprint, rows: [{ existingId: uuid, label: 'Anna 800101-1234' }], ids: [uuid.toUpperCase()] });
      expect(out.fingerprint).toBe(fingerprint);
      expect(out.rows[0]!.existingId).toBe(uuid);
      expect(out.ids[0]).toBe(uuid.toUpperCase());
      expect(out.rows[0]!.label).toBe(`Anna ${REDACTED}`);
    });

    it('never rewrites a random id or fingerprint: a thousand of each, every digit string a plan can hold', () => {
      for (let i = 0; i < 3_000; i += 1) {
        const id = randomUUID();
        const fingerprint = createHash('sha256').update(`${i}${id}`).digest('hex').slice(0, 32);
        const out = scrubPersonalNumbers({ id, fingerprint, nested: { ids: [id], fp: fingerprint } });
        expect(out).toEqual({ id, fingerprint, nested: { ids: [id], fp: fingerprint } });
      }
    });

    it('lets a Date through', () => {
      const when = new Date(0);
      expect(scrubPersonalNumbers({ when }).when).toBe(when);
    });

    it('stops at a depth no file reaches rather than looping', () => {
      let deep: Record<string, unknown> = { s: '19800101-1234' };
      for (let i = 0; i < 30; i += 1) deep = { next: deep };
      expect(() => scrubPersonalNumbers(deep)).not.toThrow();
    });
  });

  describe('ProblemLog', () => {
    it('keeps the first MAX_PROBLEMS and one closing line with the count of the rest', () => {
      const log = new ProblemLog('TOO_MANY');
      for (let i = 0; i < MAX_PROBLEMS + 7; i += 1) log.add(`rad ${i}`, 'X', `m${i}`);
      const problems = log.close();
      expect(problems).toHaveLength(MAX_PROBLEMS + 1);
      expect(problems.at(-1)).toEqual({ ref: '', code: 'TOO_MANY', message: 'Ytterligare 7 problem visas inte.' });
      expect(log.size).toBe(MAX_PROBLEMS + 7);
    });

    it('has no closing line when nothing was left out', () => {
      const log = new ProblemLog('TOO_MANY');
      log.add('rad 1', 'X', 'm');
      expect(log.close()).toEqual([{ ref: 'rad 1', code: 'X', message: 'm' }]);
    });
  });
});
