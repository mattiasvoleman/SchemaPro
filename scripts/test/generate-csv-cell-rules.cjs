// Generates src/import/__fixtures__/csv-cell-rules.json from class-validator,
// which the import DTOs call, for the two contract tests that hold
// web/lib/csv-cell-rules.ts to it (src/import/csv-cell-rules.contract.spec.ts
// and web/lib/csv-cell-rules.test.ts). Run from the repository root after a
// class-validator or validator upgrade, and commit what changed:
//
//   node scripts/test/generate-csv-cell-rules.cjs > src/import/__fixtures__/csv-cell-rules.json
//
// Never edit the JSON by hand: it is what class-validator answered.
const { isEmail, isHexColor, maxLength } = require('class-validator');
const isLength = require('validator/lib/isLength').default;

const emails = [
  'karin.ek@example.com',
  'Karin.Ek@Example.COM',
  'noah.sjö.7b@demo-skola.example.com',
  'åsa.öberg@skola.se',
  'elev+7a@skola.se',
  "o'brien@skola.se",
  'a@b.co',
  'a@b.c',
  'a@b',
  'karin.ek@',
  '@skola.se',
  'karin ek@skola.se',
  'karin.ek@skola .se',
  'karin..ek@skola.se',
  '.karin@skola.se',
  'karin.@skola.se',
  'karin.ek@skola..se',
  'karin.ek@-skola.se',
  'karin.ek@skola-.se',
  'karin.ek@sko_la.se',
  'karin.ek@skola.se.',
  'karin.ek@skola.123',
  'karin.ek@skola.xn--p1ai',
  'karin.ek@skolå.se',
  'karin.ek@skola.sé',
  'karin@ek@skola.se',
  '"karin ek"@skola.se',
  '"karin"ek"@skola.se',
  'karin;ek@skola.se',
  'karin,ek@skola.se',
  'karin(ek)@skola.se',
  'karin.ek@[192.168.0.1]',
  'karin.ek@192.168.0.1',
  'Karin Ek <karin.ek@skola.se>',
  '',
  ' ',
  ' karin.ek@skola.se',
  'karin.ek@skola.se ',
  `${'a'.repeat(64)}@skola.se`,
  `${'a'.repeat(65)}@skola.se`,
  `${'ö'.repeat(32)}@skola.se`,
  `${'ö'.repeat(33)}@skola.se`,
  `karin@${'a'.repeat(63)}.se`,
  `karin@${'a'.repeat(64)}.se`,
  `${'a'.repeat(60)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(60)}.se`,
  `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.se`,
  'karin.ek@ｓkola.se',
  'karin ek@skola.se',
  'karin.ek@skola.s',
  'KARIN@SKOLA.SE',
  'karin.ek@sub.skola.example.com',
  'elev-7a@skola-ab.se',
  "#!$%&'*+-/=?^_`{}|~@skola.se",
];

const colors = [
  '#4f46e5', '4f46e5', '#4F46E5', '#fff', 'fff', '#ffff', '#ff00ff80', '#ff00f', '#gggggg', '', ' ', '#', 'blå',
  'rgb(1,2,3)', '#4f46e5 ', '##4f46e5', '#1e3', '#1e4000',
];

const texts = [
  '', 'a', '7A', 'Åsa', 'Ö', 'é', '😀', '👍🏽', '❤️', '🇸🇪', 'a'.repeat(60), 'a'.repeat(61), 'ö'.repeat(60),
  `${'😀'.repeat(30)}`, `${'😀'.repeat(31)}`, 'Hem- och konsumentkunskap "HKK"; teori',
];

const out = {
  generatedFrom: 'class-validator isEmail / isHexColor / maxLength, as the import DTOs call them',
  emails: emails.map((value) => ({ value, valid: isEmail(value) })),
  hexColors: colors.map((value) => ({ value, valid: isHexColor(value) })),
  lengths: texts.map((value) => ({ value, length: lengthOf(value), maxLength60: maxLength(value, 60) })),
};

function lengthOf(value) {
  for (let n = 0; n < 1000; n += 1) if (isLength(value, { min: n, max: n })) return n;
  return -1;
}

process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
